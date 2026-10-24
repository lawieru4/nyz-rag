import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import { getDb, closeDatabase } from "./src/db.js";
import { documents } from "./src/schema.js";
const db = getDb();
const eligible = and(eq(documents.status, "ready"), isNull(documents.duplicateOf), ne(documents.processingStatus, "duplicate"));
const dryRun = process.argv.includes("--dry-run");
const rows = await db.select({ id: documents.id }).from(documents).where(and(eligible, sql`${documents.chunkerVersion} IS DISTINCT FROM 3`)).orderBy(documents.createdAt, documents.id);
const stats = await db.execute(sql`SELECT processing_status, embedding_status, chunker_version, count(*)::int AS n FROM documents GROUP BY 1, 2, 3 ORDER BY 4 DESC`);
console.log(`待重新处理 ${rows.length} 篇`, stats.rows);
if (dryRun) { await closeDatabase(); process.exit(0); }

const api = `http://127.0.0.1:${process.env.API_PORT ?? "3001"}`;
const login = await fetch(`${api}/api/admin/auth/login`, {
  method: "POST", headers: { "content-type": "application/json", "x-nyz-admin": "1" },
  body: JSON.stringify({ username: process.env.ADMIN_USERNAME ?? "admin", password: process.env.ADMIN_PASSWORD }),
});
if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

// 处理中的文档（入队后尚未切片完成或尚未向量化完成）不超过 4 篇，避免大量文档同时处于切片后、向量化前的状态。
const inFlight = async (ids: string[]) => ids.length ? (await db.select({ n: sql<number>`count(*)::int` }).from(documents).where(and(inArray(documents.id, ids),
  or(inArray(documents.processingStatus, ["pending", "cleaning"]), inArray(documents.embeddingStatus, ["pending", "queued", "processing"]))))) [0].n : 0;
const submitted: string[] = [];
const skipped: string[] = [];
const started = Date.now();
for (const [index, { id }] of rows.entries()) {
  while (await inFlight(submitted.slice(-20)) >= 4) await delay(500);
  // API 按 IP 每分钟 120 次限流：每 650 毫秒提交一篇（约 90 次/分钟，给管理端界面留余量），429 时按 Retry-After 等待后重试。
  await delay(650);
  let response: Response;
  for (;;) {
    response = await fetch(`${api}/api/admin/documents/${id}/reprocess`, { method: "POST", headers: { cookie, "x-nyz-admin": "1" } });
    if (response.status !== 429) break;
    await response.body?.cancel();
    await delay(Math.max(1, Number(response.headers.get("retry-after")) || 5) * 1000);
  }
  if (response.status === 202) submitted.push(id);
  else skipped.push(`${id}: HTTP ${response.status} ${await response.text()}`);
  if ((index + 1) % 50 === 0) console.log(`[${index + 1}/${rows.length}] ${Math.round((Date.now() - started) / 1000)}s，跳过 ${skipped.length}`);
}
while (await inFlight(submitted.slice(-20)) > 0) await delay(1000);
await fetch(`${api}/api/admin/auth/logout`, { method: "POST", headers: { cookie, "x-nyz-admin": "1" } });
console.log(`入队 ${submitted.length} 篇，跳过 ${skipped.length} 篇，${Math.round((Date.now() - started) / 1000)}s`, skipped.slice(0, 20));
const after = await db.execute(sql`SELECT processing_status, embedding_status, chunker_version, count(*)::int AS n FROM documents GROUP BY 1, 2, 3 ORDER BY 4 DESC`);
console.log(after.rows);
await closeDatabase();
