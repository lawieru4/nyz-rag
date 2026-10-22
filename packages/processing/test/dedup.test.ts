import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { closeDatabase, getDb, getPool, migrate, withTransaction } from "../src/db.js";
import { canonicalUrlFromHtml, contentFingerprint, isDedupCandidate, normalizeUrl } from "../src/dedup.js";
import { processDocument } from "../src/process.js";
import {
  backfillContentHashes, createSource, deleteDocument, findDocumentByCanonicalUrl, getDocument, getDocumentSummary, getStats, keywordSearchChunks, listDocumentChunks, upsertDocument,
} from "../src/repository.js";
import { searchTerms } from "../src/search-terms.js";

test("normalizeUrl drops fragments, default ports and tracking params, and sorts the query", () => {
  assert.equal(normalizeUrl("HTTPS://Example.COM:443/a/b?b=2&utm_source=x&a=1&spm=3#top"), "https://example.com/a/b?a=1&b=2");
  assert.equal(normalizeUrl("http://example.com/list.php?id=2&id=1&FBCLID=9"), "http://example.com/list.php?id=2&id=1", "repeated params keep their order");
  assert.equal(normalizeUrl("https://example.com/a?flag&x=%E4%B8%AD"), "https://example.com/a?flag&x=%E4%B8%AD", "raw encoding is kept");
  assert.equal(normalizeUrl("https://example.com/path/?utm_medium=a"), "https://example.com/path/", "trailing slash and path case are unchanged");
  assert.equal(normalizeUrl("../b?x=1", "https://example.com/a/c"), "https://example.com/b?x=1");
  assert.equal(normalizeUrl("mailto:a@example.com"), null);
  assert.equal(normalizeUrl("not a url"), null);
});

test("canonicalUrlFromHtml reads <link rel=canonical> and ignores site-root misconfiguration", () => {
  const page = "https://example.com/news/item?id=1&utm_source=feed";
  const html = (link: string) => `<html><head><title>t</title>${link}</head><body><link rel="canonical" href="/body"></body></html>`;
  assert.equal(canonicalUrlFromHtml(html(`<link href="/news/item?utm_campaign=x&amp;id=1" rel="alternate canonical">`), page), "https://example.com/news/item?id=1");
  assert.equal(canonicalUrlFromHtml(html("<link rel=canonical href=https://mirror.example.org/a>"), page), "https://mirror.example.org/a");
  assert.equal(canonicalUrlFromHtml(html('<link rel="canonical" href="https://example.com/">'), page), null, "non-root page pointing at the homepage");
  assert.equal(canonicalUrlFromHtml(html('<link rel="canonical" href="/">'), "https://example.com/"), "https://example.com/");
  assert.equal(canonicalUrlFromHtml(html('<link rel="canonical" href="javascript:void(0)">'), page), null);
  assert.equal(canonicalUrlFromHtml(html('<link rel="stylesheet" href="/a.css">'), page), null, "only links inside <head> are considered");
});

test("contentFingerprint ignores whitespace and width differences; short content is not deduplicated", () => {
  assert.equal(contentFingerprint("钠离子电池\n\n正极 材料ＡＢＣ１２"), contentFingerprint("钠离子电池正极材料ABC12"));
  assert.notEqual(contentFingerprint("钠离子电池"), contentFingerprint("锂离子电池"));
  assert.equal(isDedupCandidate("加载中……"), false);
  assert.equal(isDedupCandidate("正".repeat(50)), true);
});

const body = (topic: string) => `${topic}的研究进展。`.repeat(8);

test("duplicate documents keep their source but are not chunked; primaries hand over on change and delete", { skip: process.env.NYZ_INTEGRATION_TEST !== "1", timeout: 60000 }, async () => {
  const previousUrl = process.env.DATABASE_URL;
  const admin = new pg.Pool({ connectionString: previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag" });
  const schema = `nyz_dedup_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag");
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  try {
    await migrate();
    const siteA = await createSource({ name: "Site A", url: "https://a.test", kind: "网页站点", frequency: "" });
    const siteB = await createSource({ name: "Site B", url: "https://b.test", kind: "网页站点", frequency: "" });
    const save = (sourceId: string, path: string, content: string, canonicalUrl?: string) => withTransaction((tx) =>
      upsertDocument(tx, { sourceId, url: `https://${path}`, canonicalUrl, title: path, content, status: "ready" }));
    const run = (id: string) => withTransaction((tx) => processDocument(tx, id));
    const state = async (id: string) => {
      const summary = (await getDocumentSummary(id))!;
      return { status: summary.processingStatus, duplicateOf: summary.duplicateOf ?? null, chunks: summary.chunkCount };
    };

    // 跨来源：后处理的同内容文档成为重复文档，不切片；排版差异不影响判定。
    const a = await save(siteA.id, "a.test/1", body("钠离子电池"));
    const b = await save(siteB.id, "b.test/x", body("钠离子电池").replace(/。/g, "。\n"));
    assert.deepEqual(await run(a), { duplicateOf: null, chunks: 1, embed: [a] });
    assert.deepEqual(await run(b), { duplicateOf: a, chunks: 0, embed: [] });
    assert.deepEqual(await state(b), { status: "duplicate", duplicateOf: a, chunks: 0 });
    assert.deepEqual((await getDocument(a))!.duplicates, [{ id: b, sourceId: siteB.id, title: "b.test/x", url: "https://b.test/x" }]);
    assert.equal((await getDocument(b))!.primary?.id, a);
    assert.deepEqual((await keywordSearchChunks(searchTerms("钠离子电池"), 10)).map((hit) => hit.documentId), [a], "duplicates are not retrievable");
    assert.equal((await getStats()).documents, 1, "duplicates are not counted as knowledge documents");
    // 重新处理主文档（内容不变）仍为主文档，重复关系不变。
    assert.deepEqual(await run(a), { duplicateOf: null, chunks: 1, embed: [a] });
    assert.equal((await state(b)).duplicateOf, a);

    // 过短的正文不判重。
    const s1 = await save(siteA.id, "a.test/short-1", "加载中");
    const s2 = await save(siteB.id, "b.test/short-2", "加载中");
    await run(s1);
    assert.equal((await run(s2)).duplicateOf, null);

    // 主文档内容变化：最早的重复文档接替为主文档（需要向量化），其余同内容的跟随它。
    const c = await save(siteA.id, "a.test/3", body("钠离子电池"));
    assert.equal((await run(c)).duplicateOf, a);
    await save(siteA.id, "a.test/1", body("固态电池"));
    assert.deepEqual(await run(a), { duplicateOf: null, chunks: 1, embed: [a, b] });
    assert.deepEqual(await state(b), { status: "chunked", duplicateOf: null, chunks: 1 });
    assert.deepEqual(await state(c), { status: "duplicate", duplicateOf: b, chunks: 0 });

    // 主文档的内容变成另一篇主文档的内容：它成为重复文档，名下内容不同的重复文档重新判定并接替。
    await save(siteB.id, "b.test/x", body("固态电池"));
    assert.deepEqual(await run(b), { duplicateOf: a, chunks: 0, embed: [c] });
    assert.deepEqual(await state(c), { status: "chunked", duplicateOf: null, chunks: 1 });

    // 历史数据中同内容的两篇主文档：重新处理较晚的一篇时，它与名下同内容的重复文档都归到最早的主文档。
    const d = await save(siteB.id, "b.test/4", body("钠离子电池"));
    assert.equal((await run(d)).duplicateOf, c);
    const legacy = await save(siteA.id, "a.test/legacy", body("钠离子电池"));
    await getPool().query("UPDATE documents SET created_at = now() - interval '1 day', content_hash = $2, processing_status = 'chunked' WHERE id = $1", [legacy, contentFingerprint(body("钠离子电池"))]);
    assert.deepEqual(await run(c), { duplicateOf: legacy, chunks: 0, embed: [] });
    assert.equal((await state(d)).duplicateOf, legacy);

    // 删除主文档：最早的重复文档接替并置为待处理，其余指向它。
    assert.deepEqual(await deleteDocument(legacy), { promotedId: c });
    assert.deepEqual(await state(c), { status: "pending", duplicateOf: null, chunks: 0 });
    assert.equal((await state(d)).duplicateOf, c);
    assert.deepEqual(await run(c), { duplicateOf: null, chunks: 1, embed: [c] });
    assert.deepEqual(await deleteDocument(d), { promotedId: null });
    assert.equal(await deleteDocument(d), null);

    // 并发处理同内容的两篇新文档：按指纹加锁，只有一篇成为主文档。
    const e1 = await save(siteA.id, "a.test/e1", body("液流电池"));
    const e2 = await save(siteB.id, "b.test/e2", body("液流电池"));
    const results = await Promise.all([run(e1), run(e2)]);
    assert.equal(results.filter((result) => result.duplicateOf === null).length, 1);
    assert.equal((await listDocumentChunks(e1)).length + (await listDocumentChunks(e2)).length, 1);

    // 规范地址：同来源同 canonical 的不同抓取地址更新同一篇；不同来源互不影响。
    const p1 = await save(siteA.id, "a.test/page?ref=1", body("钙钛矿"), "https://a.test/page");
    assert.equal(await save(siteA.id, "a.test/page?ref=2", body("钙钛矿"), "https://a.test/page"), p1);
    assert.equal((await findDocumentByCanonicalUrl(getDb(), siteA.id, "https://a.test/page"))?.url, "https://a.test/page?ref=2");
    assert.notEqual(await save(siteB.id, "a.test/page?ref=2", body("钙钛矿"), "https://a.test/page"), p1);

    // 回填正文指纹：只补缺失的，不改变重复关系。
    await getPool().query("UPDATE documents SET content_hash = NULL WHERE id = $1", [a]);
    assert.equal(await backfillContentHashes("", 100), a);
    assert.equal(await backfillContentHashes("", 100), null);
    assert.equal((await getPool().query("SELECT content_hash FROM documents WHERE id = $1", [a])).rows[0].content_hash, contentFingerprint(body("固态电池")));
  } finally {
    await closeDatabase();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
