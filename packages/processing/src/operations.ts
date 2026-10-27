// 后台操作（outbox）的状态机：业务状态与操作在同一事务内写入，Worker 的投递器把到期的操作投递到 BullMQ，
// Worker 按 step 认领并持有租约执行，结束时在同一事务内写入结果与业务状态。DB → 队列至少投递一次，重复投递由认领条件挡住。
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { getDb, withTransaction, type Executor } from "./db.js";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { crawlTasks, dataSources, documents, operations, type OperationKind } from "./schema.js";
import type { ArticleSourceSyncState, OperationBacklog } from "@nyz-rag/types";

export interface OperationRef {
  id: string;
  kind: OperationKind;
  step: number;
}

/** Worker 认领到的操作：只有持有租约的 owner 能改变它的状态。 */
export interface ClaimedOperation extends OperationRef {
  targetId: string;
  attempt: number;
  owner: string;
}

/** 租约已过期并被回收（或操作已结束），当前执行者不能再写入。 */
export class LeaseLostError extends Error {
  constructor() { super("Operation lease lost; another worker owns it now"); }
}

/** 投递到队列的 jobId：同一 step 重复投递会被 BullMQ 忽略，回到 pending 后换新的 jobId。 */
export const operationJobId = (operation: Pick<OperationRef, "id" | "step">) => `op-${operation.id}-${operation.step}`;

const ACTIVE = ["pending", "dispatched", "running"] as const;
const targetTypeOf = (kind: OperationKind) => kind === "sync-source" ? "source" as const : "document" as const;
const ref = { id: operations.id, kind: operations.kind, step: operations.step };
const interval = (ms: number) => sql`make_interval(secs => ${ms / 1000})`;

/**
 * 插入操作；同一目标已有活动操作时返回 null（部分唯一索引）。须在修改业务状态的同一事务内调用。
 * attempt / runAfter 只在接管旧队列任务时指定。
 */
export async function insertOperation(tx: Executor, kind: OperationKind, targetId: string, options: { attempt?: number; runAfter?: Date } = {}): Promise<OperationRef | null> {
  const [row] = await tx.insert(operations)
    .values({ id: randomUUID(), kind, targetType: targetTypeOf(kind), targetId, attempt: options.attempt ?? 0, ...(options.runAfter ? { runAfter: options.runAfter } : {}) })
    .onConflictDoNothing().returning(ref);
  return row ?? null;
}

/** 目标当前的活动操作。 */
export async function activeOperation(targetType: "source" | "document", targetId: string, db: Executor = getDb()) {
  const [row] = await db.select({ ...ref, status: operations.status }).from(operations)
    .where(and(eq(operations.targetType, targetType), eq(operations.targetId, targetId), inArray(operations.status, ACTIVE)));
  return row ?? null;
}

/** 来源正在执行同步（文档级操作与删除在此期间返回 409，避免与同步争用同一篇文档）。 */
export async function sourceSyncRunning(sourceId: string, db: Executor = getDb()): Promise<boolean> {
  return (await activeOperation("source", sourceId, db))?.status === "running";
}

// ---- 投递器 ----

/** 到期的待投递操作（按到期时间）。 */
export async function listDueOperations(limit: number, db: Executor = getDb()): Promise<OperationRef[]> {
  return db.select(ref).from(operations).where(and(eq(operations.status, "pending"), lte(operations.runAfter, sql`now()`)))
    .orderBy(asc(operations.runAfter)).limit(limit);
}

/** 入队后标为已投递；Worker 已经认领（running）或 step 已变化时不变。 */
export async function markDispatched(operation: OperationRef, db: Executor = getDb()): Promise<void> {
  await db.update(operations).set({ status: "dispatched", dispatchedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(operations.id, operation.id), eq(operations.step, operation.step), eq(operations.status, "pending")));
}

/** 投递超过 `olderThanMs` 仍未开始的操作，供投递器确认队列中仍有对应 job（Redis 数据丢失时重新投递）。 */
export async function listStaleDispatched(olderThanMs: number, db: Executor = getDb()): Promise<OperationRef[]> {
  return db.select(ref).from(operations)
    .where(and(eq(operations.status, "dispatched"), lt(operations.dispatchedAt, sql`now() - ${interval(olderThanMs)}`)));
}

/** 确认（或重新投递）后刷新投递时间，下次超时后再检查。 */
export async function touchDispatched(operation: OperationRef, db: Executor = getDb()): Promise<void> {
  await db.update(operations).set({ dispatchedAt: sql`now()` })
    .where(and(eq(operations.id, operation.id), eq(operations.step, operation.step), eq(operations.status, "dispatched")));
}

// ---- 执行 ----

/** 认领 job 对应的操作并取得租约；操作已在执行、已结束或 step 不符（重复、过期的投递）时返回 null。 */
export async function claimOperation(id: string, step: number, owner: string, leaseMs: number, db: Executor = getDb()): Promise<ClaimedOperation | null> {
  const [row] = await db.update(operations)
    .set({ status: "running", leaseOwner: owner, leaseExpiresAt: sql`now() + ${interval(leaseMs)}`, updatedAt: sql`now()` })
    .where(and(eq(operations.id, id), eq(operations.step, step), inArray(operations.status, ["pending", "dispatched"])))
    .returning({ ...ref, targetId: operations.targetId, attempt: operations.attempt });
  return row ? { ...row, owner } : null;
}

/** 续租；返回 false 表示租约已被回收。 */
export async function renewLease(operation: ClaimedOperation, leaseMs: number, db: Executor = getDb()): Promise<boolean> {
  const rows = await db.update(operations).set({ leaseExpiresAt: sql`now() + ${interval(leaseMs)}` })
    .where(owned(operation)).returning({ id: operations.id });
  return rows.length > 0;
}

const owned = (operation: ClaimedOperation) =>
  and(eq(operations.id, operation.id), eq(operations.status, "running"), eq(operations.leaseOwner, operation.owner));

async function transition(tx: Executor, operation: ClaimedOperation, values: PgUpdateSetSource<typeof operations>): Promise<void> {
  const rows = await tx.update(operations)
    .set({ ...values, leaseOwner: null, leaseExpiresAt: null, updatedAt: sql`now()` })
    .where(owned(operation)).returning({ id: operations.id });
  if (!rows.length) throw new LeaseLostError();
}

export async function completeOperation(tx: Executor, operation: ClaimedOperation): Promise<void> {
  await transition(tx, operation, { status: "succeeded", error: null, finishedAt: sql`now()` });
}

/** 操作失败：同时把失败写到业务状态（同步任务、文档处理或向量化状态）。 */
export async function failOperation(tx: Executor, operation: ClaimedOperation, error: string): Promise<void> {
  await transition(tx, operation, { status: "failed", error, finishedAt: sql`now()` });
  await recordFailure(tx, operation, error);
}

/**
 * 回到 pending，`delayMs` 后再次投递：向量化临时错误的重试（attempt 加一），
 * 或重新处理完成后转为向量化（指定 kind，attempt 归零）。
 */
export async function requeueOperation(tx: Executor, operation: ClaimedOperation, options: { delayMs: number; error?: string | null; kind?: OperationKind }): Promise<void> {
  await transition(tx, operation, {
    status: "pending", step: sql`${operations.step} + 1`, runAfter: sql`now() + ${interval(options.delayMs)}`, dispatchedAt: null,
    error: options.error ?? null, ...(options.kind ? { kind: options.kind, attempt: 0 } : { attempt: sql`${operations.attempt} + 1` }),
  });
}

/** 操作最终失败时的业务状态；只改仍处于进行中的记录。 */
async function recordFailure(tx: Executor, operation: Pick<ClaimedOperation, "id" | "kind" | "targetId">, error: string): Promise<void> {
  if (operation.kind === "sync-source") {
    await tx.update(crawlTasks).set({ status: "失败", error })
      .where(and(eq(crawlTasks.operationId, operation.id), inArray(crawlTasks.status, ["等待中", "运行中"])));
  } else if (operation.kind === "reprocess-document") {
    await tx.update(documents).set({ processingStatus: "failed", processingError: error }).where(eq(documents.id, operation.targetId));
  } else {
    await tx.update(documents).set({ embeddingStatus: "failed", embeddingError: error, embeddingUpdatedAt: sql`now()` })
      .where(and(eq(documents.id, operation.targetId), inArray(documents.embeddingStatus, ["queued", "processing"])));
  }
}

/** 同步游标只由持有租约的同步操作写入，避免失去租约的旧执行者把游标写回去。 */
export async function saveOwnedSyncState(operation: ClaimedOperation, sourceId: string, state: ArticleSourceSyncState, db: Executor = getDb()): Promise<void> {
  const rows = await db.update(dataSources).set({ syncState: state })
    .where(and(eq(dataSources.id, sourceId), sql`EXISTS (SELECT 1 FROM ${operations} WHERE ${owned(operation)})`))
    .returning({ id: dataSources.id });
  if (!rows.length) throw new LeaseLostError();
}

// ---- 积压 ----

/**
 * 操作积压：排队（已到期未开始）、执行中、延后重试、24 小时内失败的数量与最早的排队时间。
 * 返回到期时间而不是等待时长，管理端推送只在内容变化时发送。
 */
export async function getOperationBacklog(db: Executor = getDb()): Promise<OperationBacklog> {
  const { rows: [row] } = await db.execute<{ queued: number; running: number; delayed: number; failed: number; oldest: string | null }>(sql`
    SELECT
      count(*) FILTER (WHERE status IN ('pending', 'dispatched') AND run_after <= now())::int AS queued,
      count(*) FILTER (WHERE status = 'running')::int AS running,
      count(*) FILTER (WHERE status = 'pending' AND run_after > now())::int AS delayed,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      min(run_after) FILTER (WHERE status IN ('pending', 'dispatched') AND run_after <= now()) AS oldest
    FROM ${operations}
    WHERE status IN ('pending', 'dispatched', 'running') OR (status = 'failed' AND finished_at >= now() - interval '24 hours')`);
  return {
    queued: row.queued, running: row.running, delayed: row.delayed, failedLastDay: row.failed,
    // 原始 SQL 不经过列映射，时间为数据库字符串。
    oldestQueuedAt: row.oldest ? new Date(row.oldest).toISOString() : null,
  };
}

// ---- 回收与清理 ----

/**
 * 租约过期的执行中操作（Worker 崩溃、失联）：回到 pending 重新执行（attempt 加一，与向量化重试共用次数），
 * 已执行 `maxAttempts` 次的记为失败。返回重新排队与失败的数量。
 */
export async function recoverExpiredOperations(maxAttempts: number): Promise<{ requeued: number; failed: number }> {
  return withTransaction(async (tx) => {
    const expired = await tx.select({ id: operations.id, kind: operations.kind, targetId: operations.targetId, attempt: operations.attempt }).from(operations)
      .where(and(eq(operations.status, "running"), lt(operations.leaseExpiresAt, sql`now()`))).for("update", { skipLocked: true });
    let failed = 0;
    for (const operation of expired) {
      const error = "Worker 中断（租约过期）";
      if (operation.attempt + 1 >= maxAttempts) {
        await tx.update(operations).set({ status: "failed", error: `${error}，已重试 ${operation.attempt} 次`, leaseOwner: null, leaseExpiresAt: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(operations.id, operation.id));
        await recordFailure(tx, operation, `${error}，请重新执行`);
        failed += 1;
        continue;
      }
      await tx.update(operations).set({
        status: "pending", step: sql`${operations.step} + 1`, attempt: sql`${operations.attempt} + 1`, runAfter: sql`now()`, dispatchedAt: null,
        leaseOwner: null, leaseExpiresAt: null, error, updatedAt: sql`now()`,
      }).where(eq(operations.id, operation.id));
      // 进度显示回到排队中。
      if (operation.kind === "sync-source") {
        await tx.update(crawlTasks).set({ status: "等待中", error: `${error}，已重新排队` })
          .where(and(eq(crawlTasks.operationId, operation.id), eq(crawlTasks.status, "运行中")));
      } else if (operation.kind === "embed-document") {
        await tx.update(documents).set({ embeddingStatus: "queued", embeddingError: `${error}，已重新排队`, embeddingUpdatedAt: sql`now()` })
          .where(and(eq(documents.id, operation.targetId), eq(documents.embeddingStatus, "processing")));
      }
    }
    return { requeued: expired.length - failed, failed };
  });
}

/** 已结束的操作：每个目标只保留最近 `keepPerTarget` 条，且不超过 `retainMs`。返回删除数。 */
export async function pruneOperations(keepPerTarget: number, retainMs: number, db: Executor = getDb()): Promise<number> {
  const { rowCount } = await db.execute(sql`
    DELETE FROM ${operations} WHERE ${operations.id} IN (
      SELECT id FROM (
        SELECT id, finished_at, row_number() OVER (PARTITION BY target_type, target_id ORDER BY finished_at DESC, id) AS rank
        FROM ${operations} WHERE status IN ('succeeded', 'failed')
      ) ranked WHERE rank > ${keepPerTarget} OR finished_at < now() - ${interval(retainMs)}
    )`);
  return rowCount ?? 0;
}

// ---- 升级前的队列任务 ----

export interface LegacyJob {
  name: string;
  data: { sourceId?: string; taskId?: string; documentId?: string; embedRetry?: number };
  /** 延迟任务的执行时间。 */
  runAfter?: Date;
}

/**
 * 升级前入队（或升级期间由旧版 API 入队）的 job 没有 operationId：转为等价的操作，调用方随后删除原 job。
 * 迁移已为当时进行中的工作建立操作，这里只补上之后出现的；目标已有活动操作时不重复建立。返回是否新建了操作。
 */
export async function adoptLegacyJob(job: LegacyJob): Promise<boolean> {
  return withTransaction(async (tx) => {
    if (job.name === "sync-source") {
      if (!job.data.taskId) return false;
      const [task] = await tx.select({ id: crawlTasks.id, sourceId: crawlTasks.sourceId }).from(crawlTasks)
        .where(and(eq(crawlTasks.id, job.data.taskId), inArray(crawlTasks.status, ["等待中", "运行中"]), sql`${crawlTasks.operationId} IS NULL`)).for("update");
      if (!task) return false;
      const operation = await insertOperation(tx, "sync-source", task.sourceId);
      await tx.update(crawlTasks).set(operation ? { operationId: operation.id, status: "等待中" } : { status: "失败", error: "同一来源已有同步任务，此任务已取消" })
        .where(eq(crawlTasks.id, task.id));
      return Boolean(operation);
    }
    const documentId = job.data.documentId;
    if (!documentId) return false;
    const [document] = await tx.select({ id: documents.id }).from(documents).where(eq(documents.id, documentId));
    if (!document) return false;
    // 旧版的延迟重试（embedRetry）只做向量化。
    const embedOnly = job.name === "embed-document" || job.data.embedRetry !== undefined;
    const operation = await insertOperation(tx, embedOnly ? "embed-document" : "reprocess-document", documentId, { attempt: job.data.embedRetry ?? 0, runAfter: job.runAfter });
    if (operation && embedOnly) {
      await tx.update(documents).set({ embeddingStatus: "queued", embeddingUpdatedAt: sql`now()` }).where(eq(documents.id, documentId));
    }
    return Boolean(operation);
  });
}
