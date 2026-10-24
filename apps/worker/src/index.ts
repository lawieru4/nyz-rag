import { setTimeout as delay } from "node:timers/promises";
import { DelayedError, Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import {
  ARTICLE_TOKEN_SETTING, backfillContentHashes, closeDatabase, closeModelAdmissionLimiter, createArticleClient, DocumentBusyError, embedChunks, embeddingInput, embeddingRetryDelay, embeddingRetryDelays,
  failActiveTask, failStaleEmbedding, getSource, getSourceSyncState,
  getModelSelection, getSummaryInput, getTask, listActiveTaskIds, listArticleVersions, listDocumentChunks, listStaleEmbeddingIds, listMissingSummaryEmbeddings, lockDocument, markSourceSynced, migrate, modelAdmissionConfig, normalizeUrl, processDocument,
  readSecretSetting, reindexChunkSearchTerms, reindexDocumentMetadataTerms, requireEmbeddingModel, saveDocumentEmbeddings, saveSourceSyncState, saveSummaryEmbedding, setEmbeddingState, setProcessingState,
  startTask, syncArticles, updateTask, upsertDocument, withDocumentWork, withTransaction, type Database, type ProcessDocumentResult,
} from "@nyz-rag/processing";
import type { DataSourceRecord } from "@nyz-rag/types";

modelAdmissionConfig();
const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
// 文章接口：请求间隔与超时、单次同步最多处理的文章数，以及头部扫描在连续多少页无变化后结束。
const requestDelayMs = Math.max(1000, Number.parseInt(process.env.NYZ_ARTICLE_REQUEST_DELAY_MS ?? "1000", 10) || 1000);
const requestTimeoutMs = Math.max(1000, Number.parseInt(process.env.NYZ_ARTICLE_REQUEST_TIMEOUT_MS ?? "15000", 10) || 15000);
const articleSyncLimit = Math.max(1, Math.min(5000, Number.parseInt(process.env.NYZ_ARTICLE_SYNC_LIMIT ?? "200", 10) || 200));
const articleOverlapPages = Math.max(1, Math.min(20, Number.parseInt(process.env.NYZ_ARTICLE_OVERLAP_PAGES ?? "2", 10) || 2));
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message.slice(0, 500) : fallback;
// 向量化遇到临时错误时由队列稍后重试的等待（毫秒，逗号分隔；空字符串不重试）。
const embedRetryDelays = embeddingRetryDelays(process.env.NYZ_EMBED_RETRY_DELAYS_MS);

const queueName = process.env.DOCUMENT_QUEUE_NAME ?? "document-processing";
const queue = new Queue(queueName, { connection });
// 与 API queue.ts 的 jobId 一致：API 据 document-<id> 判断文档已有任务。
const documentJobId = (id: string) => `document-${id}`;
const sourceJobId = (taskId: string) => `sync-${taskId}`;

/** 向量化遇到临时错误：文档已记为排队中，由调用方安排第 `retry` 次重试。 */
class EmbeddingRetry extends Error {
  constructor(readonly documentId: string, readonly retry: number, readonly delayMs: number, message: string) { super(message); }
}

const waitText = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.ceil(ms / 1000)} 秒`;

/** @param retried 此前已自动重试的次数。 */
async function embedDocument(documentId: string, db: Database, retried = 0) {
  try {
    // 模型调用放在事务外；回写时用 processing_version 确认切片没有被重新生成。
    const { version, chunks, summary } = await db.transaction(async (tx) => {
      const target = await lockDocument(tx, documentId);
      if (!target) throw new Error("Document no longer exists");
      const chunks = await listDocumentChunks(documentId, tx);
      if (target.processingStatus !== "chunked" || !chunks.length) throw new Error("Document must have chunks before embedding");
      await setEmbeddingState(documentId, "processing", null, tx);
      return { version: target.processingVersion, chunks, summary: await getSummaryInput(documentId, tx) };
    });
    const embedding = requireEmbeddingModel(await getModelSelection("embedding", db));
    // 文章级向量（标题 + 摘要）与切片在同一次调用中生成，保证同模型同维度。
    const vectors = await embedChunks(embedding, [...chunks.map(embeddingInput), ...(summary ? [summary] : [])]);
    const summaryVector = summary ? vectors.pop()! : null;
    await db.transaction(async (tx) => {
      const target = await lockDocument(tx, documentId);
      if (!target || target.processingStatus !== "chunked" || target.processingVersion !== version) {
        throw new Error("Document changed during embedding; retry after processing finishes");
      }
      await saveDocumentEmbeddings(tx, documentId, chunks, vectors, embedding, summaryVector);
    });
  } catch (error) {
    const message = errorMessage(error, "Embedding failed");
    const delayMs = embeddingRetryDelay(error, retried, embedRetryDelays);
    if (delayMs === null) {
      await setEmbeddingState(documentId, "failed", message, db);
      throw error;
    }
    await setEmbeddingState(documentId, "queued", `第 ${retried + 1} 次向量化失败，${waitText(delayMs)}后自动重试：${message}`, db);
    throw new EmbeddingRetry(documentId, retried + 1, delayMs, message);
  }
}

/** 安排其他文档的延迟重试；文档已有任务（同 jobId 入队被忽略）时由那个任务处理。 */
async function enqueueEmbeddingRetry({ documentId, retry, delayMs }: EmbeddingRetry) {
  try {
    await queue.add("embed-document", { documentId, embedRetry: retry }, { jobId: documentJobId(documentId), delay: delayMs, removeOnComplete: true, removeOnFail: true });
  } catch {
    console.error(`Failed to schedule embedding retry for document ${documentId}`);
    await setEmbeddingState(documentId, "failed", "自动重试入队失败，请手动重新向量化").catch(() => undefined);
  }
}

/**
 * 当前任务的 jobId 就是 document-<本文档>，同 ID 入队会被忽略：把当前任务改为只向量化并延后执行，
 * ID 不变，API 在等待期间仍能据此判断文档已有任务。须在释放文档锁之后调用。
 */
async function delayForEmbeddingRetry(job: Job, token: string | undefined, { documentId, retry, delayMs }: EmbeddingRetry): Promise<never> {
  await job.updateData({ documentId, embedRetry: retry });
  await job.moveToDelayed(Date.now() + delayMs, token);
  throw new DelayedError();
}

/**
 * 切片后自动向量化：本文档（重复文档除外）及接替为主文档的文档。失败不影响已保存的内容；
 * 临时错误安排延迟重试，其中 `ownDocumentId`（当前任务的文档）的重试返回给调用方处理。
 */
async function autoEmbedDocuments({ embed }: ProcessDocumentResult, db: Database, ownDocumentId?: string): Promise<EmbeddingRetry | undefined> {
  if (!embed.length) return;
  if (!await getModelSelection("embedding", db)) return;
  let own: EmbeddingRetry | undefined;
  for (const documentId of embed) {
    try {
      await embedDocument(documentId, db);
    } catch (error) {
      console.error(`Embedding failed for document ${documentId}`);
      if (!(error instanceof EmbeddingRetry)) continue;
      if (documentId === ownDocumentId) own = error;
      else await enqueueEmbeddingRetry(error);
    }
  }
  return own;
}

const duplicateNote = (count: number) => count ? `${count} 篇与已有文档内容相同，标记为重复，未切片和向量化` : "";

async function syncArticleSource(source: DataSourceRecord, taskId: string) {
  // token 在管理后台配置，每次同步时读取，修改后无需重启 Worker。
  const client = createArticleClient({ listUrl: source.url, token: await readSecretSetting(ARTICLE_TOKEN_SETTING) ?? "", timeoutMs: requestTimeoutMs });
  let duplicates = 0;
  const result = await syncArticles({
    client,
    known: await listArticleVersions(source.id),
    state: await getSourceSyncState(source.id),
    limit: articleSyncLimit,
    overlapPages: articleOverlapPages,
    pause: () => delay(requestDelayMs),
    saveState: (state) => saveSourceSyncState(source.id, state),
    onProgress: ({ processed, failed }) => updateTask(taskId, {
      processedCount: processed, failedCount: failed, progress: Math.min(95, Math.round((processed + failed) / articleSyncLimit * 100)),
    }),
    process: async (item) => {
      const detail = await client.detail(item._key);
      const url = normalizeUrl(client.articleUrl(detail._key))!;
      const processed = await withDocumentWork(async (db, lock) => {
        const result = await db.transaction(async (tx) => {
          const id = await upsertDocument(tx, {
            sourceId: source.id, externalId: detail._key, url, title: detail.title?.trim() || detail._key, content: "",
            rawJson: detail, sourceUpdatedAt: detail.updateTime ? new Date(detail.updateTime) : null, status: "ready",
          });
          await lock(id);
          const result = await processDocument(tx, id);
          for (const target of result.embed) await lock(target);
          return result;
        });
        await autoEmbedDocuments(result, db);
        return result;
      });
      if (processed.duplicateOf) duplicates += 1;
    },
  });
  console.info(`Source ${source.id}: ${result.processed} articles synced, ${result.failures.length} failed, ${result.pages} list pages${result.limitReached ? ", limit reached" : ""}`);
  if (result.failures.length && !result.processed) throw new Error(`${result.failures.length} 篇文章同步失败：${result.failures[0].error}`);
  const notes = [
    result.failures.length ? `${result.failures.length} 篇失败，下次同步重试（${result.failures[0].articleKey}：${result.failures[0].error}）` : "",
    result.limitReached ? `已达单次上限 ${articleSyncLimit} 篇，再次同步继续` : "",
    duplicateNote(duplicates),
  ].filter(Boolean);
  return { count: result.processed, note: notes.length ? notes.join("；") : null };
}

async function reprocessDocument(documentId: string) {
  return withDocumentWork(async (db, lock) => {
    await lock(documentId);
    try {
      const result = await db.transaction(async (tx) => {
        const result = await processDocument(tx, documentId);
        for (const target of result.embed) await lock(target);
        return result;
      });
      return { result, retry: await autoEmbedDocuments(result, db, documentId) };
    } catch (error) {
      if (!(error instanceof DocumentBusyError)) await setProcessingState(documentId, "failed", errorMessage(error, "Document processing failed"), db);
      throw error;
    }
  });
}

async function syncSource(sourceId: string, taskId: string) {
  const [task, source] = await Promise.all([getTask(taskId), getSource(sourceId)]);
  if (!task || !source) throw new Error("source or task not found");
  // 任务已结束（例如启动对账时队列中找不到它而被标为失败）则不再执行，避免与同一来源的新任务并行。
  if (!await startTask(taskId, articleSyncLimit)) {
    console.warn(`Task ${taskId} is no longer active; skipped`);
    return null;
  }
  try {
    const { count, note } = await syncArticleSource(source, taskId);
    await withTransaction(async (tx) => {
      await markSourceSynced(sourceId, tx);
      // 部分失败或达到单次上限时任务仍算完成，说明写在 error 字段供管理端展示。
      await updateTask(taskId, { status: "已完成", progress: 100, error: note }, tx);
    });
    return count;
  } catch (error) {
    await updateTask(taskId, { status: "失败", error: errorMessage(error, "Unknown sync error") });
    throw error;
  }
}

/** 升级前的文档没有正文指纹（或按旧规则计算），启动时在后台补齐；只补指纹，已有的重复内容在下次重新处理时判定。 */
async function backfillHashes() {
  let batches = 0;
  for (let cursor = await backfillContentHashes("", 500); cursor; cursor = await backfillContentHashes(cursor, 500)) batches += 1;
  if (batches) console.info(`Backfilled document content hashes (${batches} batches)`);
}

/** 升级前的切片与文档没有关键词检索词项，启动时在后台补齐；也可手动运行 pnpm db:reindex-search。 */
async function backfillSearchTerms() {
  for (const [label, reindex] of [["chunk", reindexChunkSearchTerms], ["document metadata", reindexDocumentMetadataTerms]] as const) {
    let cursor = "";
    let batches = 0;
    for (let last = await reindex(cursor, 500, { onlyMissing: true }); last; last = await reindex(cursor, 500, { onlyMissing: true })) {
      cursor = last;
      batches += 1;
    }
    if (batches) console.info(`Backfilled ${label} search terms (${batches} batches)`);
  }
}

/**
 * 升级前已向量化的文章没有文章级向量，启动时在后台用当前 Embedding 模型补齐（只处理与当前模型一致的文档，
 * 其余文档需重新向量化）；回写时校验切片版本与模型，与并发任务冲突的文档跳过，由后续向量化任务生成。
 */
async function backfillSummaryEmbeddings() {
  const embedding = await getModelSelection("embedding");
  if (!embedding) return;
  const model = embedding.model.trim();
  let saved = 0;
  for (let cursor: string | null = ""; cursor !== null;) {
    const batch = await listMissingSummaryEmbeddings(cursor, 32, model);
    if (batch.items.length) {
      const vectors = await embedChunks(embedding, batch.items.map((item) => item.input));
      for (const [index, item] of batch.items.entries()) if (await saveSummaryEmbedding(item.id, item.version, vectors[index], model)) saved += 1;
    }
    cursor = batch.cursor;
  }
  if (saved) console.info(`Backfilled ${saved} document summary embeddings`);
}

/**
 * 启动时与队列对账，只检查 1 分钟以前的记录（避开 API 写库与入队之间的窗口）：
 * - 等待中/运行中的任务没有对应 job（API 写库后入队前退出、Redis 数据丢失等）时会一直占住来源的同步互斥，标为失败；
 * - 向量排队中/向量化中的文档没有对应 job（同步中途 Worker 退出等）时会一直显示为进行中、不能手动重试，标为失败。
 */
async function reconcileWithQueue() {
  let tasks = 0;
  for (const taskId of await listActiveTaskIds(60_000)) {
    if (await queue.getJob(sourceJobId(taskId))) continue;
    if (await failActiveTask(taskId, "队列中没有对应的同步任务，已标为失败，请重新同步")) tasks += 1;
  }
  let embeddings = 0;
  for (const documentId of await listStaleEmbeddingIds(60_000)) {
    if (await queue.getJob(documentJobId(documentId))) continue;
    if (await failStaleEmbedding(documentId, "向量化已中断（队列中没有对应任务），请重新向量化")) embeddings += 1;
  }
  if (tasks || embeddings) console.warn(`Marked ${tasks} orphaned sync tasks and ${embeddings} interrupted embeddings as failed`);
}

await migrate();
await reconcileWithQueue();
void backfillHashes().catch((error: unknown) => console.error("Content hash backfill failed", errorMessage(error, "unknown error")));
void backfillSearchTerms().catch((error: unknown) => console.error("Search term backfill failed", errorMessage(error, "unknown error")));
void backfillSummaryEmbeddings().catch((error: unknown) => console.error("Summary embedding backfill failed", errorMessage(error, "unknown error")));
const worker = new Worker(queueName, async (job, token) => {
  if (job.name === "sync-source") {
    const count = await syncSource(job.data.sourceId, job.data.taskId);
    return count === null ? { status: "skipped" } : { status: "ready", documentsProcessed: count };
  }
  // 文档级任务；embedRetry 为第几次自动重试向量化（包括由重新处理任务延后而来的）。
  const { documentId, embedRetry } = job.data as { documentId: string; embedRetry?: number };
  if (job.name === "embed-document" || embedRetry !== undefined) {
    const retry = await withDocumentWork(async (db, lock) => {
      await lock(documentId);
      try {
        await embedDocument(documentId, db, embedRetry ?? 0);
      } catch (error) {
        if (error instanceof EmbeddingRetry) return error;
        throw error;
      }
    });
    if (retry) return delayForEmbeddingRetry(job, token, retry);
    return { status: "embedded", documentId };
  }
  const { result: { duplicateOf, chunks }, retry } = await reprocessDocument(documentId);
  if (retry) return delayForEmbeddingRetry(job, token, retry);
  return duplicateOf ? { status: "duplicate", documentId, duplicateOf } : { status: "chunked", documentId, chunks };
}, { connection, concurrency: 1 });

worker.on("completed", (job) => console.info(`Job ${job.id} completed`));
worker.on("failed", (job, error) => {
  console.error(`Job ${job?.id} failed`, error.message);
  // 处理函数内的失败已写入任务；卡住超过重试次数等由 BullMQ 判定的失败不经过处理函数，在这里补记。
  if (job?.name === "sync-source") void failActiveTask(job.data.taskId, errorMessage(error, "Unknown sync error")).catch(() => console.error(`Failed to update task ${job.data.taskId}`));
});

const shutdown = async () => { await worker.close(); await queue.close(); await connection.quit(); await closeDatabase(); await closeModelAdmissionLimiter(); };
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
console.info(`NYZ RAG worker listening on ${queueName} queue`);
