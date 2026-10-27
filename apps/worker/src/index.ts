import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import {
  adoptLegacyJob, ARTICLE_TOKEN_SETTING, backfillContentHashes, claimOperation, closeDatabase, closeModelAdmissionLimiter, completeOperation, createArticleClient, DocumentBusyError,
  embedChunks, embeddingInput, embeddingRetryDelay, embeddingRetryDelays, failOperation, getModelSelection, getSource, getSourceSyncState, getSummaryInput, getTaskByOperation,
  LeaseLostError, listArticleVersions, listDocumentChunks, listDueOperations, listMissingSummaryEmbeddings, listStaleDispatched, lockDocument, lockEmbeddingTarget, markDispatched, markSourceSynced, migrate,
  modelAdmissionConfig, normalizeUrl, operationJobId, processDocument, pruneOperations, readSecretSetting, recoverExpiredOperations, reindexChunkSearchTerms, reindexDocumentMetadataTerms,
   renewLease, requeueOperation, requireEmbeddingModel, saveDocumentEmbeddings, saveOwnedSyncState, saveSummaryEmbedding, scheduleDueSources, scheduleEmbeddings, setEmbeddingState, startTask, syncArticles,
  touchDispatched, updateTask, upsertDocument, withDocumentWork, withTransaction, type ClaimedOperation, type Database, type Executor, type OperationRef,
} from "@nyz-rag/processing";
import type { DataSourceRecord } from "@nyz-rag/types";
import { writeHeartbeat } from "./heartbeat.js";

modelAdmissionConfig();
const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
// 文章接口：请求间隔与超时、单次同步最多处理的文章数，以及头部扫描在连续多少页无变化后结束。
const requestDelayMs = Math.max(1000, Number.parseInt(process.env.NYZ_ARTICLE_REQUEST_DELAY_MS ?? "1000", 10) || 1000);
const requestTimeoutMs = Math.max(1000, Number.parseInt(process.env.NYZ_ARTICLE_REQUEST_TIMEOUT_MS ?? "15000", 10) || 15000);
const articleSyncLimit = Math.max(1, Math.min(5000, Number.parseInt(process.env.NYZ_ARTICLE_SYNC_LIMIT ?? "200", 10) || 200));
const articleOverlapPages = Math.max(1, Math.min(20, Number.parseInt(process.env.NYZ_ARTICLE_OVERLAP_PAGES ?? "2", 10) || 2));
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message.slice(0, 500) : fallback;
// 向量化遇到临时错误时由操作稍后重试的等待（毫秒，逗号分隔；空字符串不重试）。
const embedRetryDelays = embeddingRetryDelays(process.env.NYZ_EMBED_RETRY_DELAYS_MS);
// 操作租约：执行期间每 1/4 租约续租一次；超过租约未续（Worker 崩溃、失联）的操作由任一 Worker 回收重新执行，最多执行 3 次。
const leaseMs = Math.max(1000, Number.parseInt(process.env.NYZ_OPERATION_LEASE_MS ?? "60000", 10) || 60000);
const MAX_OPERATION_ATTEMPTS = 3;
// 投递器每秒投递到期的操作；每 1/4 租约回收过期租约、确认已投递的 job 仍在队列中。已结束的操作每个目标保留 10 条、最多 30 天。
const DISPATCH_INTERVAL_MS = 1000;
const sweepIntervalMs = Math.max(DISPATCH_INTERVAL_MS, leaseMs / 4);
const PRUNE_INTERVAL_MS = 60 * 60_000;
const SOURCE_SCHEDULE_INTERVAL_MS = 30_000;
const owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

const queueName = process.env.DOCUMENT_QUEUE_NAME ?? "document-processing";
const queue = new Queue(queueName, { connection });

const waitText = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.ceil(ms / 1000)} 秒`;

async function embeddingConfigured(db?: Executor) {
  return Boolean(await getModelSelection("embedding", db));
}

/**
 * 向量化（持有文档锁时调用）。模型调用放在事务外；回写时用 processing_version 确认切片没有被重新生成。
 * `onStart` 收到开始时的切片版本。
 */
async function embedDocument(documentId: string, db: Database, onStart: (version: number) => void) {
  const { version, chunks, summary } = await db.transaction(async (tx) => {
    const target = await lockDocument(tx, documentId);
    if (!target) throw new Error("Document no longer exists");
    const chunks = await listDocumentChunks(documentId, tx);
    if (target.processingStatus !== "chunked" || !chunks.length) throw new Error("Document must have chunks before embedding");
    await setEmbeddingState(documentId, "processing", null, tx);
    return { version: target.processingVersion, chunks, summary: await getSummaryInput(documentId, tx) };
  });
  onStart(version);
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
}

/**
 * embed-document：成功则完成；临时错误（见 embeddingRetryDelay）回到 pending 延后重试，其他错误记为失败。
 * 执行期间文档被同步重新切片（向量状态被重置为 pending，安排向量化时因本操作仍在进行而跳过）时，立即按新切片重新执行。
 */
async function runEmbed(operation: ClaimedOperation) {
  const documentId = operation.targetId;
  let started: number | undefined;
  const failure = await withDocumentWork(async (db, lock) => {
    await lock(documentId);
    try {
      await embedDocument(documentId, db, (version) => { started = version; });
      return null;
    } catch (error) {
      return error;
    }
  });
  await withTransaction(async (tx) => {
    const current = await lockEmbeddingTarget(tx, documentId);
    // 只有开始后确实重新切片过（版本变化）才重新执行，不会因其他原因反复执行。
    if (started !== undefined && current?.processingStatus === "chunked" && current.processingVersion !== started && current.embeddingStatus === "pending") {
      await requeueOperation(tx, operation, { delayMs: 0, kind: "embed-document" });
      await setEmbeddingState(documentId, "queued", null, tx);
      return;
    }
    if (!failure) return completeOperation(tx, operation);
    console.error(`Embedding failed for document ${documentId}`);
    const message = errorMessage(failure, "Embedding failed");
    const delayMs = embeddingRetryDelay(failure, operation.attempt, embedRetryDelays);
    if (delayMs === null) return failOperation(tx, operation, message);
    await requeueOperation(tx, operation, { delayMs, error: message });
    await setEmbeddingState(documentId, "queued", `第 ${operation.attempt + 1} 次向量化失败，${waitText(delayMs)}后自动重试：${message}`, tx);
  });
}

/**
 * reprocess-document：重新清洗切片；本文档（不是重复文档时）在同一操作中继续向量化（转为 embed-document，等待期间 API 仍返回 409），
 * 接替为主文档的其他文档另行安排向量化。未配置 Embedding 模型时只切片。
 */
async function runReprocess(operation: ClaimedOperation) {
  const documentId = operation.targetId;
  const failure = await withDocumentWork(async (db, lock) => {
    await lock(documentId);
    try {
      await db.transaction(async (tx) => {
        const result = await processDocument(tx, documentId);
        for (const target of result.embed) await lock(target);
        const embed = await embeddingConfigured(tx) ? result.embed : [];
        await scheduleEmbeddings(tx, embed.filter((id) => id !== documentId));
        if (embed.includes(documentId)) {
          await requeueOperation(tx, operation, { delayMs: 0, kind: "embed-document" });
          await setEmbeddingState(documentId, "queued", null, tx);
        } else {
          await completeOperation(tx, operation);
        }
      });
      return null;
    } catch (error) {
      if (error instanceof DocumentBusyError || error instanceof LeaseLostError) throw error;
      return error;
    }
  });
  if (failure) await withTransaction((tx) => failOperation(tx, operation, errorMessage(failure, "Document processing failed")));
}

const duplicateNote = (count: number) => count ? `${count} 篇与已有文档内容相同，标记为重复，未切片和向量化` : "";

async function syncArticleSource(source: DataSourceRecord, taskId: string, operation: ClaimedOperation) {
  // token 在管理后台配置，每次同步时读取，修改后无需重启 Worker。
  const client = createArticleClient({ listUrl: source.url, token: await readSecretSetting(ARTICLE_TOKEN_SETTING) ?? "", timeoutMs: requestTimeoutMs });
  const embed = await embeddingConfigured();
  let duplicates = 0;
  const result = await syncArticles({
    client,
    known: await listArticleVersions(source.id),
    state: await getSourceSyncState(source.id),
    limit: articleSyncLimit,
    overlapPages: articleOverlapPages,
    pause: () => delay(requestDelayMs),
    // 失去租约（已被回收、由其他 Worker 重新执行）时写入被拒绝并中止本次同步。
    saveState: (state) => saveOwnedSyncState(operation, source.id, state),
    onProgress: ({ processed, failed }) => updateTask(taskId, {
      processedCount: processed, failedCount: failed, progress: Math.min(95, Math.round((processed + failed) / articleSyncLimit * 100)),
    }),
    process: async (item) => {
      const detail = await client.detail(item._key);
      const url = normalizeUrl(client.articleUrl(detail._key))!;
      const processed = await withDocumentWork(async (db, lock) => db.transaction(async (tx) => {
        const id = await upsertDocument(tx, {
          sourceId: source.id, externalId: detail._key, url, title: detail.title?.trim() || detail._key, content: "",
          rawJson: detail, sourceUpdatedAt: detail.updateTime ? new Date(detail.updateTime) : null, status: "ready",
        });
        await lock(id);
        const result = await processDocument(tx, id);
        for (const target of result.embed) await lock(target);
        // 向量化作为独立操作与切片同一事务提交，同步结束后由队列逐篇执行，失败可单独重试。
        if (embed) await scheduleEmbeddings(tx, result.embed);
        return result;
      }));
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

/** sync-source：按增量同步来源的文章；部分失败或达到单次上限时任务仍算完成，说明写在 error 字段供管理端展示。 */
async function runSync(operation: ClaimedOperation) {
  const task = await getTaskByOperation(operation.id);
  const source = task ? await getSource(task.sourceId) : null;
  if (!task || !source) return withTransaction((tx) => failOperation(tx, operation, "来源或同步任务不存在"));
  await startTask(task.id, articleSyncLimit);
  try {
    const { note } = await syncArticleSource(source, task.id, operation);
    await withTransaction(async (tx) => {
      await completeOperation(tx, operation);
      await markSourceSynced(source.id, tx);
      await updateTask(task.id, { status: "已完成", progress: 100, error: note }, tx);
    });
  } catch (error) {
    if (error instanceof LeaseLostError) throw error;
    await withTransaction((tx) => failOperation(tx, operation, errorMessage(error, "Unknown sync error")));
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
 * 升级前已向量化的文章没有文章级向量，启动时在后台用当前 Embedding 模型补齐（只处理与当前供应商、模型一致的文档，
 * 其余文档需重新向量化）；回写时校验切片版本与向量空间，与并发任务冲突的文档跳过，由后续向量化任务生成。
 */
async function backfillSummaryEmbeddings() {
  const embedding = await getModelSelection("embedding");
  if (!embedding) return;
  const space = { providerId: embedding.provider.id, model: embedding.model };
  let saved = 0;
  for (let cursor: string | null = ""; cursor !== null;) {
    const batch = await listMissingSummaryEmbeddings(cursor, 32, space);
    if (batch.items.length) {
      const vectors = await embedChunks(embedding, batch.items.map((item) => item.input));
      for (const [index, item] of batch.items.entries()) if (await saveSummaryEmbedding(item.id, item.version, vectors[index], space)) saved += 1;
    }
    cursor = batch.cursor;
  }
  if (saved) console.info(`Backfilled ${saved} document summary embeddings`);
}

const handlers = { "sync-source": runSync, "reprocess-document": runReprocess, "embed-document": runEmbed } as const;

/** 执行期间定时续租；续租失败说明租约已被回收，之后的状态写入会被拒绝（LeaseLostError）。 */
function keepLease(operation: ClaimedOperation) {
  let warned = false;
  const timer = setInterval(() => {
    void renewLease(operation, leaseMs).then((renewed) => {
      if (!renewed && !warned) { warned = true; console.warn(`Lost the lease of operation ${operation.id}`); }
    }, () => undefined);
  }, leaseMs / 4);
  return () => clearInterval(timer);
}

const enqueue = (operation: OperationRef) => queue.add(operation.kind, { operationId: operation.id, step: operation.step },
  { jobId: operationJobId(operation), removeOnComplete: true, removeOnFail: true });

/**
 * 投递器（每个 Worker 都运行；同一 step 重复投递时 jobId 相同会被忽略，执行时再由认领条件去重）：
 * 到期的 pending 操作入队后标为 dispatched。
 */
async function dispatchDue() {
  for (const operation of await listDueOperations(100)) {
    await enqueue(operation);
    await markDispatched(operation);
  }
}

/**
 * 租约过期的 running 操作回到 pending（或次数用完记为失败）；
 * 已投递超过一个租约周期仍未开始、队列中又没有对应 job 的操作（Redis 数据丢失等）重新入队。
 */
async function sweep() {
  const { requeued, failed } = await recoverExpiredOperations(MAX_OPERATION_ATTEMPTS);
  if (requeued || failed) console.warn(`Recovered expired operations: ${requeued} requeued, ${failed} failed`);
  for (const operation of await listStaleDispatched(leaseMs)) {
    if (!await queue.getJob(operationJobId(operation))) {
      console.warn(`Operation ${operation.id} has no queued job; dispatching again`);
      await enqueue(operation);
    }
    await touchDispatched(operation);
  }
}

let stopped = false;
function every(intervalMs: number, label: string, run: () => Promise<unknown>) {
  void (async () => {
    while (!stopped) {
      try { await run(); } catch (error) { console.error(`${label} failed`, errorMessage(error, "unknown error")); }
      await delay(intervalMs);
    }
  })();
}

const adoptLegacy = (job: Job) => adoptLegacyJob({ name: job.name, data: job.data, runAfter: job.delay ? new Date(job.timestamp + job.delay) : undefined });

/** 升级前入队的 job（没有 operationId）转为操作后删除；之后才出现的（旧版 API）由处理函数在执行时转换。 */
async function adoptLegacyJobs() {
  let adopted = 0;
  for (const job of await queue.getJobs(["waiting", "delayed", "prioritized", "paused"])) {
    if (!job || job.data?.operationId !== undefined) continue;
    if (await adoptLegacy(job)) adopted += 1;
    await job.remove().catch(() => undefined);
  }
  if (adopted) console.info(`Adopted ${adopted} legacy queue jobs as operations`);
}

await migrate();
await adoptLegacyJobs();
void backfillHashes().catch((error: unknown) => console.error("Content hash backfill failed", errorMessage(error, "unknown error")));
void backfillSearchTerms().catch((error: unknown) => console.error("Search term backfill failed", errorMessage(error, "unknown error")));
void backfillSummaryEmbeddings().catch((error: unknown) => console.error("Summary embedding backfill failed", errorMessage(error, "unknown error")));

const worker = new Worker(queueName, async (job) => {
  const { operationId, step } = job.data as { operationId?: string; step?: number };
  if (operationId === undefined || step === undefined) {
    await adoptLegacy(job);
    return { status: "adopted" };
  }
  // 重复或过期的投递（操作已在执行、已结束或 step 已变化）直接跳过。
  const operation = await claimOperation(operationId, step, owner, leaseMs);
  if (!operation) return { status: "skipped" };
  const stopLease = keepLease(operation);
  try {
    await handlers[operation.kind](operation);
  } catch (error) {
    // 租约已被回收：操作由新的执行者负责。其他异常（数据库不可用等）使 job 失败，操作留在 running，租约过期后回收重试。
    if (error instanceof LeaseLostError) return { status: "lease-lost" };
    throw error;
  } finally {
    stopLease();
  }
  return { status: "done" };
}, { connection, concurrency: 1 });

worker.on("completed", (job) => console.info(`Job ${job.id} completed`));
worker.on("failed", (job, error) => console.error(`Job ${job?.id} failed`, error.message));

// 投递成功、Redis 可用且队列消费者在运行时写入心跳（容器健康检查读取）。
every(DISPATCH_INTERVAL_MS, "Operation dispatch", async () => {
  await dispatchDue();
  await connection.ping();
  if (worker.isRunning()) await writeHeartbeat();
});
every(SOURCE_SCHEDULE_INTERVAL_MS, "Source scheduling", () => scheduleDueSources());
every(sweepIntervalMs, "Operation sweep", sweep);
every(PRUNE_INTERVAL_MS, "Operation pruning", () => pruneOperations(10, 30 * 24 * 60 * 60_000));

const shutdown = async () => { stopped = true; await worker.close(); await queue.close(); await connection.quit(); await closeDatabase(); await closeModelAdmissionLimiter(); };
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
console.info(`NYZ RAG worker listening on ${queueName} queue`);
