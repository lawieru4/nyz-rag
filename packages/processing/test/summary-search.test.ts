import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { ArticleMetadata } from "@nyz-rag/types";
import type { ModelTarget } from "../src/provider.js";
import { closeDatabase, getPool, migrate, withTransaction } from "../src/db.js";
import {
  createSource, getSummaryInput, listDocumentChunks, listMissingSummaryEmbeddings, replaceDocumentChunks, saveDocumentEmbeddings, saveSummaryEmbedding, setEmbeddingState,
  summarySearchChunks, upsertDocument,
} from "../src/repository.js";
import { ARTICLE_LIST_URL, articleDocument } from "./article-fixtures.js";

const DIMENSIONS = 384;
// 若干单位向量之和（未归一化，余弦相似度与长度无关）。
const vec = (...axes: number[]) => Array.from({ length: DIMENSIONS }, (_, index) => axes.includes(index) ? 1 : 0);
const embedding: ModelTarget = {
  provider: { id: "provider-1", name: "Test", provider: "compatible", baseUrl: "", credentialEnv: "UNUSED", enabled: true, hasApiKey: false, createdAt: "", updatedAt: "" },
  model: "test-model",
};

test("summary recall finds articles by summary vector and locates their best chunk", { skip: process.env.NYZ_INTEGRATION_TEST !== "1", timeout: 60000 }, async () => {
  const previousUrl = process.env.DATABASE_URL;
  const admin = new pg.Pool({ connectionString: previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag" });
  const schema = `nyz_summary_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag");
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  try {
    await migrate();
    const source = await createSource({ name: "Summary fixtures", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "" });
    // chunkVectors 与切片一一对应；summaryVector 为 null 表示文章没有摘要。
    const create = async (name: string, category: string, summary: string | null, chunkVectors: number[][], summaryVector: number[] | null) => withTransaction(async (tx) => {
      const id = await upsertDocument(tx, articleDocument(source.id, name, name, name));
      await replaceDocumentChunks(tx, id, { content: name, category, metadata: summary === null ? null : { summary } as ArticleMetadata },
        chunkVectors.map((_, index) => ({ id: `${id}-${index}`, index, content: `${name} 切片 ${index}`, tokenEstimate: 5 })));
      if (summary !== null) assert.equal(await getSummaryInput(id, tx), `文章：${name}\n\n${summary}`);
      await saveDocumentEmbeddings(tx, id, await listDocumentChunks(id, tx), chunkVectors, embedding, summaryVector);
      return id;
    });
    const a = await create("a", "research", "钠离子电池综述", [vec(1), vec(0, 2)], vec(0));
    const b = await create("b", "report", "钠电与锂电对比", [vec(3)], vec(0, 1));
    const c = await create("c", "research", null, [vec(0)], null);
    const summaryOf = async (id: string) => (await getPool().query("SELECT summary_embedding IS NOT NULL AS present FROM documents WHERE id = $1", [id])).rows[0].present;
    assert.equal(await getSummaryInput(c), null);

    const hits = await summarySearchChunks(vec(0), "test-model", 10);
    assert.deepEqual(hits.map((hit) => hit.chunkId), [`${a}-1`, `${b}-0`], "one best chunk per article, ordered by summary similarity; documents without summaries are skipped");
    assert.ok(Math.abs(hits[0].score - 1) < 1e-6);
    assert.ok(Math.abs(hits[1].score - Math.SQRT1_2) < 1e-6);
    assert.deepEqual((await summarySearchChunks(vec(0), "test-model", 10, undefined, { categories: ["report"] })).map((hit) => hit.documentId), [b]);
    assert.deepEqual((await summarySearchChunks(vec(0), "test-model", 1)).map((hit) => hit.documentId), [a]);
    assert.deepEqual(await summarySearchChunks(vec(0), "other-model", 10), []);
    await assert.rejects(summarySearchChunks([], "test-model", 1), /Invalid query vector/);
    await assert.rejects(withTransaction((tx) => saveDocumentEmbeddings(tx, c, [{ id: `${c}-0`, index: 0, content: "c", tokenEstimate: 1 }], [vec(0)], embedding, [1, 0, 0])), /same dimensions/);

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT id FROM documents WHERE embedding_dimensions = ${DIMENSIONS} AND embedding_model = 'test-model' AND summary_embedding IS NOT NULL
        ORDER BY summary_embedding::vector(${DIMENSIONS}) <=> $1::vector LIMIT 2`, [JSON.stringify(vec(0))]);
      assert.match(JSON.stringify(plan.rows), new RegExp(`documents_summary_embedding_${DIMENSIONS}_hnsw_idx`));
      await client.query("SET LOCAL hnsw.ef_search = 1");
      const recovered = await summarySearchChunks(vec(0), "test-model", 10, drizzle(client, { casing: "snake_case" }), { categories: ["research", "report"] });
      assert.equal(recovered.length, 2, "exact fallback fills results after an underfilled ANN scan");
      await client.query("ROLLBACK");
    } finally { client.release(); }

    // 重新向量化开始时清除文章级向量（模型与维度信息随之清除），重新切片同样清除。
    await setEmbeddingState(b, "processing");
    assert.equal(await summaryOf(b), false);
    assert.deepEqual((await summarySearchChunks(vec(0), "test-model", 10)).map((hit) => hit.documentId), [a]);

    // 回填：只处理 ready、同模型、有摘要且缺少文章级向量的文档；切片版本变化后拒绝写入。
    await getPool().query("UPDATE documents SET summary_embedding = NULL WHERE id = $1", [a]);
    assert.equal((await listMissingSummaryEmbeddings("", 10, "other-model")).items.length, 0);
    const batch = await listMissingSummaryEmbeddings("", 10, "test-model");
    assert.deepEqual(batch.items.map((item) => [item.id, item.input]), [[a, "文章：a\n\n钠离子电池综述"]]);
    assert.equal(batch.cursor, a);
    assert.equal((await listMissingSummaryEmbeddings(a, 10, "test-model")).cursor, null);
    assert.equal(await saveSummaryEmbedding(a, batch.items[0].version - 1, vec(0), "test-model"), false, "stale processing version");
    assert.equal(await saveSummaryEmbedding(a, batch.items[0].version, [1, 0, 0], "test-model"), false, "dimension mismatch");
    assert.equal(await saveSummaryEmbedding(a, batch.items[0].version, vec(0), "test-model"), true);
    assert.equal(await saveSummaryEmbedding(a, batch.items[0].version, vec(0), "test-model"), false, "already filled");
    assert.equal((await summarySearchChunks(vec(0), "test-model", 10))[0].documentId, a);

    await withTransaction((tx) => replaceDocumentChunks(tx, a, { content: "a" }, [{ id: `${a}-0`, index: 0, content: "a", tokenEstimate: 1 }]));
    assert.equal(await summaryOf(a), false, "rechunking clears the summary vector");
  } finally {
    await closeDatabase();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
