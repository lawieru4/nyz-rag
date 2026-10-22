import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { closeDatabase, getDb, getPool, migrate, withTransaction } from "../src/db.js";
import { parseRetrievalFilters } from "../src/retrieval-filters.js";
import { createSource, getDocumentDetail, keywordSearchChunks, replaceDocumentChunks, upsertDocument, vectorSearchChunks } from "../src/repository.js";
import { searchTerms } from "../src/search-terms.js";

test("metadata filters validate dates, limits, exact lists and unknown fields", () => {
  assert.deepEqual(parseRetrievalFilters(undefined), {});
  assert.deepEqual(parseRetrievalFilters({ publishedFrom: "2024-02-29", categories: [" 科研 ", "科研"], tags: [] }), { publishedFrom: "2024-02-29", categories: ["科研"], tags: [] });
  for (const input of [null, [], "all", { tags: "a" }, { scenarios: [null] }, { categories: [""] }, { tags: Array(21).fill("a") },
    { tags: ["a".repeat(201)] }, { sourceId: 1 }, { publishedFrom: "0000-01-01" }, { publishedFrom: "2025-02-29" }, { publishedTo: "2026-13-01" },
    { publishedFrom: "2026-01-01T00:00:00Z" }, { publishedFrom: "2026-02-01", publishedTo: "2026-01-01" }, { category: "typo" }]) {
    assert.throws(() => parseRetrievalFilters(input), undefined, JSON.stringify(input));
  }
});

test("public projection, filtered retrieval and HNSW plan in an isolated schema", { skip: process.env.NYZ_INTEGRATION_TEST !== "1", timeout: 60000 }, async () => {
  const previousUrl = process.env.DATABASE_URL;
  const admin = new pg.Pool({ connectionString: previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag" });
  const schema = `nyz_search_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag");
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  try {
    await migrate();
    await migrate();
    const source = await createSource({ name: "Filter fixtures", url: "https://example.test", kind: "网页站点", frequency: "" });
    const vector = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
    const create = async (name: string, category: string, tags: string[], publishedAt: string | null, scenario: string) => withTransaction(async (tx) => {
      const id = await upsertDocument(tx, { sourceId: source.id, url: `https://example.test/${name}`, title: name, content: "battery materials", rawHtml: "private input", status: "ready" });
      await replaceDocumentChunks(tx, id, { content: "battery materials", category, tags, publishedAt: publishedAt ? new Date(publishedAt) : null }, [{ id: `${id}-chunk`, index: 0, content: "battery materials", tokenEstimate: 5 }]);
      return { id, scenario };
    });
    const a = await create("a", "research", ["sodium", "energy"], "2026-10-20T00:00:00Z", "storage");
    const b = await create("b", "report", ["lithium"], "2026-10-20T23:59:59.999Z", "transport");
    const c = await create("c", "research", ["sodium"], "2026-10-21T00:00:00Z", "storage");
    const d = await create("d", "research", [], null, "");
    for (const item of [a, b, c, d]) {
      await getPool().query("UPDATE documents SET metadata = $2, processing_error = 'private error' WHERE id = $1", [item.id, { summary: "Summary", sourceMeta: { repostSource: "Original", keywords: ["battery"], scenarios: item.scenario ? [item.scenario] : [] } }]);
      await getPool().query("UPDATE document_chunks SET embedding = $2::vector, dimensions = 384, model = 'test-model' WHERE document_id = $1", [item.id, JSON.stringify(vector)]);
    }
    const detail = await getDocumentDetail(a.id);
    assert.equal(detail?.repostSource, "Original");
    assert.deepEqual(detail?.scenarios, ["storage"]);
    assert.equal(detail?.publishedAt, "2026-10-20T00:00:00.000Z");
    for (const key of ["rawHtml", "rawJson", "chunks", "processingError", "embedding", "sourceId"]) assert.ok(!(key in detail!));
    assert.equal(await getDocumentDetail("missing"), null);
    const cases = [
      { filters: {}, ids: [a.id, b.id, c.id, d.id] },
      { filters: { publishedFrom: "2026-10-20", publishedTo: "2026-10-20" }, ids: [a.id, b.id] },
      { filters: { categories: ["research"], tags: ["sodium"], scenarios: ["storage"], publishedTo: "2026-10-20", sourceId: source.id }, ids: [a.id] },
      { filters: { tags: ["lithium", "energy"] }, ids: [a.id, b.id] },
      { filters: { scenarios: ["transport"] }, ids: [b.id] },
      { filters: { categories: ["report", "research"] }, ids: [a.id, b.id, c.id, d.id] },
      { filters: { tags: ["sod"] }, ids: [] },
      { filters: { sourceId: "missing" }, ids: [] },
      { filters: { categories: ["' OR 1=1 --"] }, ids: [] },
    ];
    for (const { filters, ids } of cases) {
      const keyword = await keywordSearchChunks(searchTerms("battery"), 20, getDb(), filters);
      const semantic = await vectorSearchChunks(vector, "test-model", 20, getDb(), filters);
      assert.deepEqual(keyword.map((hit) => hit.documentId).sort(), [...ids].sort(), `keyword ${JSON.stringify(filters)}`);
      assert.deepEqual(semantic.map((hit) => hit.documentId).sort(), [...ids].sort(), `vector ${JSON.stringify(filters)}`);
    }
    const single = await keywordSearchChunks(searchTerms("battery"), 1, getDb(), { tags: ["lithium"] });
    assert.deepEqual(single.map((hit) => hit.documentId), [b.id], "filtering is applied before the retrieval limit");
    assert.deepEqual((await vectorSearchChunks(vector, "test-model", 1, getDb(), { tags: ["lithium"] })).map((hit) => hit.documentId), [b.id]);
    assert.deepEqual(await vectorSearchChunks(vector, "different-model", 20), []);
    await getPool().query("UPDATE document_chunks SET model = 'different-model' WHERE document_id = $1", [d.id]);
    assert.equal((await vectorSearchChunks(vector, "test-model", 20)).length, 3, "same-dimension embeddings from another model are excluded");
    await getPool().query("UPDATE document_chunks SET model = 'test-model' WHERE document_id = $1", [d.id]);
    await getPool().query("UPDATE documents SET status = 'failed' WHERE id = $1", [a.id]);
    assert.equal(await getDocumentDetail(a.id), null);
    assert.ok(!(await keywordSearchChunks(searchTerms("battery"), 20)).some((hit) => hit.documentId === a.id));
    assert.ok(!(await vectorSearchChunks(vector, "test-model", 20)).some((hit) => hit.documentId === a.id));
    // Actual execution proves expression/predicate compatibility, not just index existence.
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT c.id, 1 - (c.embedding::vector(384) <=> $1::vector) AS score
        FROM document_chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.dimensions = 384 AND c.model = 'test-model' AND c.embedding IS NOT NULL AND d.status = 'ready'
        ORDER BY c.embedding::vector(384) <=> $1::vector LIMIT 2`, [JSON.stringify(vector)]);
      assert.match(JSON.stringify(plan.rows), /document_chunks_embedding_384_hnsw_idx/);
      await client.query("SET LOCAL hnsw.ef_search = 1");
      const recovered = await vectorSearchChunks(vector, "test-model", 20, drizzle(client, { casing: "snake_case" }), { categories: ["research", "report"] });
      assert.equal(recovered.length, 3, "exact fallback fills results after an underfilled ANN scan");
      await client.query("ROLLBACK");
    } finally { client.release(); }
    // Non-indexed dimensions retain exact search, and mixed dimensions do not break casts.
    await getPool().query("UPDATE document_chunks SET embedding = '[1,0,0]'::vector, dimensions = 3 WHERE document_id = $1", [d.id]);
    assert.deepEqual((await vectorSearchChunks([1, 0, 0], "test-model", 20)).map((hit) => hit.documentId), [d.id]);
    assert.equal((await vectorSearchChunks(vector, "test-model", 20)).length, 2);
    await assert.rejects(vectorSearchChunks([], "test-model", 1), /Invalid query vector/);
    await getPool().query("UPDATE document_chunks SET search_vector = array_to_tsvector(ARRAY['battery','rareone','raretwo','rarethree','rarefour','rarefive','raresix','rareseven','rareeight']) WHERE document_id = $1", [c.id]);
    assert.deepEqual((await keywordSearchChunks(searchTerms("battery rareone raretwo rarethree rarefour rarefive raresix rareseven rareeight"), 20, getDb(), { categories: ["report"] })).map((hit) => hit.documentId), [b.id], "rare terms outside the filtered corpus must not crowd out eligible terms");
  } finally {
    await closeDatabase();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
