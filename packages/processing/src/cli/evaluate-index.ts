// 用法：pnpm --filter @nyz-rag/processing evaluate:index --schema=eval_<名称> [--chunker=2] [--concurrency=4] [--reset]
// 在 nyzrag 库中建立评估用的实验 schema：执行迁移，复制文章、数据源、模型供应商与业务模型、知识库配置（密钥按密文原样复制，不解密），
// 再按 --chunker 指定的切片规则在进程内重新切片并向量化（调用 Embedding，产生费用），不经过队列与 Worker，不修改业务 schema。
// 中断后再次运行只处理尚未完成的文章；--reset 删除并重建实验 schema（重新从业务库复制）。之后用 evaluate:retrieval --schema=<同名> 评估。
// 方案见 docs/evaluation-plan.md 第 8.5 节。
import { and, count, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { Pool } from "pg";
import { AdmissionError } from "../admission.js";
import { embeddingInput, LEGACY_CHUNKER_VERSION, SECTION_CHUNKER_VERSION, type ChunkerVersion } from "../chunking.js";
import { closeDatabase, getDb, migrate, withTransaction } from "../db.js";
import { embedChunks, requireEmbeddingModel } from "../embedding.js";
import { closeModelAdmissionLimiter } from "../model-admission.js";
import { processDocument } from "../process.js";
import { usableModel, type ModelSelection } from "../provider.js";
import { getModelSelection, getSummaryInput, listDocumentChunks, lockDocument, saveDocumentEmbeddings } from "../repository.js";
import { documentChunks, documents, documentSections } from "../schema.js";
import { EVALUATION_SCHEMA, useEvaluationSchema, withRetry } from "./evaluation-corpus.js";

const arg = (name: string, fallback?: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const message = (error: unknown) => error instanceof Error ? error.message : "unknown error";

const schema = arg("schema") ?? "";
if (!EVALUATION_SCHEMA.test(schema)) throw new Error("--schema is required and must look like eval_<name> (lowercase letters, digits and underscores), e.g. --schema=eval_sections");
const chunker = Number(arg("chunker", String(SECTION_CHUNKER_VERSION))) as ChunkerVersion;
if (chunker !== LEGACY_CHUNKER_VERSION && chunker !== SECTION_CHUNKER_VERSION) throw new Error(`--chunker must be ${LEGACY_CHUNKER_VERSION} or ${SECTION_CHUNKER_VERSION}`);
const concurrency = Number(arg("concurrency", "4"));
if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error("--concurrency must be a positive integer");
const reset = process.argv.includes("--reset");
const baseUrl = process.env.DATABASE_URL?.trim();
if (!baseUrl) throw new Error("DATABASE_URL is required.");

// 按外键顺序复制的表：重新切片只需要文章原始内容，检索与向量化还需要模型配置与知识库参数。nyzdata token（secret_settings）不复制。
const COPIED_TABLES = ["model_providers", "model_settings", "knowledge_bases", "data_sources", "documents"];

/** 建立实验 schema（已存在且未指定 --reset 时沿用）；返回是否新建。用不改 search_path 的连接执行。 */
async function prepareSchema(): Promise<boolean> {
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schema]);
    if (rowCount && !reset) return false;
    if (rowCount) {
      console.info(`删除实验 schema ${schema}`);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await admin.query(`CREATE SCHEMA "${schema}"`);
    return true;
  } finally {
    await admin.end();
  }
}

/** 从业务 schema 复制数据，只复制两边都有的列（实验 schema 可能已有新迁移加的列）。 */
async function copyTables(): Promise<void> {
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  const client = await admin.connect();
  try {
    await client.query("SET statement_timeout = 0");
    await client.query("BEGIN");
    for (const table of COPIED_TABLES) {
      const { rows } = await client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1
        INTERSECT SELECT column_name FROM information_schema.columns WHERE table_schema = $2 AND table_name = $1`, [table, schema]);
      if (!rows.length) throw new Error(`Table ${table} is missing in public or ${schema}`);
      const columns = rows.map((row) => `"${row.column_name}"`).join(", ");
      const { rowCount } = await client.query(`INSERT INTO "${schema}"."${table}" (${columns}) SELECT ${columns} FROM public."${table}"`);
      console.info(`复制 ${table}：${rowCount} 行`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await admin.end();
  }
}

// 模型调用准入（Redis，按供应商与模型计数，与 API、Worker 共用）拒绝时按 retryAfter 等待后重试，不计入失败；
// 全量重建约每篇一次调用，会持续占满准入额度，期间线上问答的查询 Embedding 可能被拒绝而降级为关键词检索。
const ADMISSION_RETRIES = 30;
async function admitted<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await call(); }
    catch (error) {
      if (!(error instanceof AdmissionError) || attempt >= ADMISSION_RETRIES) throw error;
      await new Promise((done) => setTimeout(done, Math.max(1, error.retryAfter) * 1000 + Math.random() * 1000));
    }
  }
}

/** 与 Worker 的 embedDocument 相同：模型调用在事务外，回写前比对 processing_version。 */
async function embedDocument(documentId: string, embedding: ModelSelection): Promise<void> {
  const { version, chunks, summary } = await withTransaction(async (tx) => {
    const target = await lockDocument(tx, documentId);
    if (!target || target.processingStatus !== "chunked") throw new Error("Document is not chunked");
    return { version: target.processingVersion, chunks: await listDocumentChunks(documentId, tx), summary: await getSummaryInput(documentId, tx) };
  });
  if (!chunks.length) throw new Error("Document has no chunks");
  const vectors = await withRetry(() => admitted(() => embedChunks(embedding, [...chunks.map(embeddingInput), ...(summary ? [summary] : [])])));
  const summaryVector = summary ? vectors.pop()! : null;
  await withTransaction(async (tx) => {
    const target = await lockDocument(tx, documentId);
    if (!target || target.processingVersion !== version) throw new Error("Document changed during embedding");
    await saveDocumentEmbeddings(tx, documentId, chunks, vectors, embedding, summaryVector);
  });
}

try {
  const fresh = await prepareSchema();
  useEvaluationSchema(schema);
  await migrate();
  if (fresh) await copyTables();
  else console.info(`沿用已有的实验 schema ${schema}（--reset 重新从业务库复制）`);

  const db = getDb();
  const embedding = requireEmbeddingModel(usableModel(await getModelSelection("embedding")));
  // 检索范围内的文章（ready、非重复主文档）中，尚未按目标规则切片或尚未向量化的。
  const eligible = and(eq(documents.status, "ready"), isNull(documents.duplicateOf), ne(documents.processingStatus, "duplicate"));
  const pending = await db.select({ id: documents.id }).from(documents)
    .where(and(eligible, or(sql`${documents.chunkerVersion} IS DISTINCT FROM ${chunker}`, ne(documents.embeddingStatus, "ready"))))
    .orderBy(documents.createdAt, documents.id);
  console.info(`实验 schema ${schema}：切片规则 ${chunker}，待处理 ${pending.length} 篇，Embedding ${embedding.model}，并发 ${concurrency}`);

  const queue = pending.map((row) => row.id);
  const failures: string[] = [];
  let done = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        // 文档级咨询锁与业务库共用键名，业务 Worker 恰好处理同一篇时稍后重试。
        const { embed } = await withRetry(() => withTransaction((tx) => processDocument(tx, id!, chunker)));
        for (const target of embed) await embedDocument(target, embedding);
      } catch (error) {
        failures.push(`${id}：${message(error)}`);
      }
      done += 1;
      if (done % 50 === 0 || done === pending.length) console.info(`[${done}/${pending.length}] ${Math.round((performance.now() - started) / 1000)}s，失败 ${failures.length}`);
    }
  }));
  if (failures.length) console.warn(`失败 ${failures.length} 篇（再次运行会重试）：\n${failures.slice(0, 20).join("\n")}`);

  const [[articles], [embedded], [sections], [chunks]] = await Promise.all([
    db.select({ total: count() }).from(documents).where(eligible),
    db.select({ total: count() }).from(documents).where(and(eligible, eq(documents.embeddingStatus, "ready"), eq(documents.chunkerVersion, chunker))),
    db.select({ total: count() }).from(documentSections),
    db.select({ total: count(), chars: sql<number>`coalesce(sum(length(${documentChunks.content})), 0)::int`, embedded: sql<number>`count(*) FILTER (WHERE ${isNotNull(documentChunks.embedding)})::int` }).from(documentChunks),
  ]);
  console.info(`完成：文章 ${articles.total} 篇，按规则 ${chunker} 切片并向量化 ${embedded.total} 篇；父块 ${sections.total} 个，切片 ${chunks.total} 个（已向量化 ${chunks.embedded}，平均 ${chunks.total ? Math.round(chunks.chars / chunks.total) : 0} 字）`);
  if (embedded.total < articles.total) process.exitCode = 1;
} finally {
  await closeModelAdmissionLimiter();
  await closeDatabase();
}
