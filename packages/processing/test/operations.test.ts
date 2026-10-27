import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { closeDatabase, getPool, migrate, withTransaction } from "../src/db.js";
import {
  activeOperation, adoptLegacyJob, claimOperation, completeOperation, failOperation, insertOperation, LeaseLostError, listDueOperations, listStaleDispatched,
  getOperationBacklog, markDispatched, operationJobId, pruneOperations, recoverExpiredOperations, renewLease, requeueOperation, saveOwnedSyncState, touchDispatched,
} from "../src/operations.js";
import { processDocument } from "../src/process.js";
import { createSource, createTask, deleteDocument, getSourceSyncState, markSourceSynced, requestDocumentOperation, scheduleDueSources, scheduleEmbeddings, updateSourceStatus, updateTask, upsertDocument } from "../src/repository.js";
import { syncArticles } from "../src/article/sync.js";
import { ArticleApiError } from "../src/article/client.js";
import { ARTICLE_LIST_URL, articleDocument } from "./article-fixtures.js";

const LEASE = 60_000;

test("operations: outbox writes, dispatch, claims, leases, retries, recovery and legacy adoption", { skip: process.env.NYZ_INTEGRATION_TEST !== "1", timeout: 60000 }, async () => {
  const previousUrl = process.env.DATABASE_URL;
  const admin = new pg.Pool({ connectionString: previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag" });
  const schema = `nyz_operations_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag");
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  const row = async (sql: string, params: unknown[] = []) => (await getPool().query(sql, params)).rows[0];
  const operation = (id: string) => row("SELECT * FROM operations WHERE id = $1", [id]);
  try {
    await migrate();
    const source = await createSource({ name: "Operations", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "" });
    const createDocument = (key: string, body = `${key}的研究进展与结论。`) => withTransaction(async (tx) => {
      const id = await upsertDocument(tx, articleDocument(source.id, key, key, body));
      await processDocument(tx, id);
      return id;
    });

    // 同步任务与操作同一事务写入；同一来源只能有一个活动操作，任务 ID 为 UUID。
    const task = (await createTask(source))!;
    assert.match(task.id, /^[0-9a-f-]{36}$/);
    assert.equal(await createTask(source), null, "one active sync per source");
    const syncRef = (await activeOperation("source", source.id))!;
    assert.equal((await row("SELECT operation_id FROM crawl_tasks WHERE id = $1", [task.id])).operation_id, syncRef.id);

    // 投递：到期的 pending 入队后标为 dispatched；认领要求 step 一致，重复投递只有第一次认领成功。
    assert.deepEqual((await listDueOperations(10)).map((item) => item.id), [syncRef.id]);
    assert.equal(operationJobId(syncRef), `op-${syncRef.id}-0`);
    await markDispatched(syncRef);
    assert.equal((await operation(syncRef.id)).status, "dispatched");
    assert.deepEqual(await listDueOperations(10), []);
    assert.equal(await claimOperation(syncRef.id, 1, "worker-a", LEASE), null, "a job for another step is ignored");
    const sync = (await claimOperation(syncRef.id, 0, "worker-a", LEASE))!;
    assert.equal(sync.owner, "worker-a");
    assert.equal(await claimOperation(syncRef.id, 0, "worker-b", LEASE), null, "duplicate deliveries are skipped");
    await markDispatched(syncRef);
    assert.equal((await operation(syncRef.id)).status, "running", "a late dispatch mark does not override a claim");

    // 来源同步执行中：该来源的文档不能重新处理、向量化或删除。
    const documentId = await createDocument("doc-a");
    assert.equal(await requestDocumentOperation(documentId, "embed-document"), "busy");
    await assert.rejects(deleteDocument(documentId), /being processed/);

    // 只有持有租约的执行者能写同步游标与改变状态。
    const stranger = { ...sync, owner: "worker-b" };
    assert.equal(await renewLease(stranger, LEASE), false);
    assert.equal(await renewLease(sync, LEASE), true);
    await assert.rejects(saveOwnedSyncState(stranger, source.id, {}), LeaseLostError);
    await saveOwnedSyncState(sync, source.id, { remoteTotal: 3 });
    assert.equal((await row("SELECT sync_state FROM data_sources WHERE id = $1", [source.id])).sync_state.remoteTotal, 3);
    await assert.rejects(withTransaction((tx) => completeOperation(tx, stranger)), LeaseLostError);

    // 租约过期：回到 pending（step、attempt 加一），任务回到等待中；旧执行者之后的写入被拒绝。
    await getPool().query("UPDATE operations SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [sync.id]);
    assert.deepEqual(await recoverExpiredOperations(3), { requeued: 1, failed: 0 });
    assert.deepEqual(await row("SELECT status, step, attempt FROM operations WHERE id = $1", [sync.id]), { status: "pending", step: 1, attempt: 1 });
    assert.equal((await row("SELECT status FROM crawl_tasks WHERE id = $1", [task.id])).status, "等待中");
    await assert.rejects(saveOwnedSyncState(sync, source.id, {}), LeaseLostError);
    await assert.rejects(withTransaction((tx) => completeOperation(tx, sync)), LeaseLostError);
    // 次数用完的过期操作记为失败，任务同时标为失败。
    const resumed = (await claimOperation(sync.id, 1, "worker-b", LEASE))!;
    await getPool().query("UPDATE crawl_tasks SET status = '运行中' WHERE id = $1", [task.id]);
    await getPool().query("UPDATE operations SET lease_expires_at = now() - interval '1 second', attempt = 2 WHERE id = $1", [resumed.id]);
    assert.deepEqual(await recoverExpiredOperations(3), { requeued: 0, failed: 1 });
    assert.equal((await operation(sync.id)).status, "failed");
    assert.match((await row("SELECT status, error FROM crawl_tasks WHERE id = $1", [task.id])).error, /租约过期/);
    assert.equal((await row("SELECT status FROM crawl_tasks WHERE id = $1", [task.id])).status, "失败");

    // 文档级操作：状态与操作同一事务写入；已有活动操作时 busy；不存在的文档 not-found。
    assert.equal(await requestDocumentOperation(documentId, "embed-document"), "created");
    assert.equal((await row("SELECT embedding_status FROM documents WHERE id = $1", [documentId])).embedding_status, "queued");
    assert.equal(await requestDocumentOperation(documentId, "reprocess-document"), "busy");
    assert.equal(await requestDocumentOperation("missing", "embed-document"), "not-found");
    await assert.rejects(deleteDocument(documentId), /being processed/, "documents with active operations cannot be deleted");

    // 临时失败：回到 pending 并延后（不到期不投递），attempt 加一；最终失败写入文档向量状态。
    const embedRef = (await activeOperation("document", documentId))!;
    let embed = (await claimOperation(embedRef.id, 0, "worker-a", LEASE))!;
    await withTransaction((tx) => requeueOperation(tx, embed, { delayMs: 60_000, error: "HTTP 503" }));
    assert.deepEqual(await row("SELECT status, step, attempt, error, run_after > now() AS later FROM operations WHERE id = $1", [embed.id]), { status: "pending", step: 1, attempt: 1, error: "HTTP 503", later: true });
    assert.deepEqual(await listDueOperations(10), []);
    await getPool().query("UPDATE operations SET run_after = now() WHERE id = $1", [embed.id]);
    embed = (await claimOperation(embed.id, 1, "worker-a", LEASE))!;
    assert.equal(embed.attempt, 1);
    await withTransaction((tx) => failOperation(tx, embed, "HTTP 400"));
    assert.deepEqual(await row("SELECT embedding_status, embedding_error FROM documents WHERE id = $1", [documentId]), { embedding_status: "failed", embedding_error: "HTTP 400" });
    assert.equal(await activeOperation("document", documentId), null);

    // 重新处理完成后转为向量化：kind 改变、attempt 归零；失败写入处理状态。
    assert.equal(await requestDocumentOperation(documentId, "reprocess-document"), "created");
    assert.equal((await row("SELECT processing_status FROM documents WHERE id = $1", [documentId])).processing_status, "pending");
    const reprocess = (await claimOperation((await activeOperation("document", documentId))!.id, 0, "worker-a", LEASE))!;
    await getPool().query("UPDATE operations SET attempt = 1 WHERE id = $1", [reprocess.id]);
    await withTransaction((tx) => requeueOperation(tx, reprocess, { delayMs: 0, kind: "embed-document" }));
    assert.deepEqual(await row("SELECT kind, step, attempt FROM operations WHERE id = $1", [reprocess.id]), { kind: "embed-document", step: 1, attempt: 0 });
    const continued = (await claimOperation(reprocess.id, 1, "worker-a", LEASE))!;
    await withTransaction((tx) => completeOperation(tx, continued));
    const failedReprocess = await withTransaction(async (tx) => (await insertOperation(tx, "reprocess-document", documentId))!);
    await withTransaction(async (tx) => failOperation(tx, (await claimOperation(failedReprocess.id, 0, "worker-a", LEASE))!, "parse error"));
    assert.deepEqual(await row("SELECT processing_status, processing_error FROM documents WHERE id = $1", [documentId]), { processing_status: "failed", processing_error: "parse error" });

    // 自动向量化：已有活动操作的文档不重复安排。
    const other = await createDocument("doc-b");
    await withTransaction((tx) => scheduleEmbeddings(tx, [other]));
    await withTransaction((tx) => scheduleEmbeddings(tx, [other]));
    assert.equal((await row("SELECT count(*)::int AS count FROM operations WHERE target_id = $1 AND status = 'pending'", [other])).count, 1);
    assert.equal((await row("SELECT embedding_status FROM documents WHERE id = $1", [other])).embedding_status, "queued");

    // 积压：到期未开始的为排队，延后的为等待重试；失败只统计 24 小时内的（上面的同步、向量化与重新处理各失败一次）。
    const due = await row("SELECT run_after FROM operations WHERE target_id = $1 AND status = 'pending'", [other]);
    assert.deepEqual(await getOperationBacklog(), { queued: 1, running: 0, delayed: 0, failedLastDay: 3, oldestQueuedAt: due.run_after.toISOString() });
    await getPool().query("UPDATE operations SET run_after = now() + interval '1 minute' WHERE target_id = $1 AND status = 'pending'", [other]);
    await getPool().query("UPDATE operations SET finished_at = now() - interval '25 hours' WHERE id = $1", [sync.id]);
    assert.deepEqual(await getOperationBacklog(), { queued: 0, running: 0, delayed: 1, failedLastDay: 2, oldestQueuedAt: null });
    await getPool().query("UPDATE operations SET run_after = now() WHERE target_id = $1 AND status = 'pending'", [other]);

    // 调度只运行已启用且频率可识别的来源；并发 Worker 与手动同步复用同一个事务/outbox。
    const scheduled = await createSource({ name: "Scheduled", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "每小时" });
    const paused = await createSource({ name: "Paused", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "每天" });
    const manual = await createSource({ name: "Manual", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "手动" });
    const blank = await createSource({ name: "Blank", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "" });
    const unknown = await createSource({ name: "Unknown", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "daily" });
    for (const item of [scheduled, manual, blank, unknown]) await updateSourceStatus(item.id, "运行中");
    assert.deepEqual(await Promise.all([scheduleDueSources(), scheduleDueSources()]).then((counts) => counts.sort()), [0, 1]);
    const taskCount = async (id: string) => (await row("SELECT count(*)::int AS count FROM crawl_tasks WHERE source_id = $1", [id])).count;
    assert.equal(await taskCount(scheduled.id), 1);
    for (const item of [paused, manual, blank, unknown]) assert.equal(await taskCount(item.id), 0);
    assert.equal(await scheduleDueSources(), 0, "active work is not duplicated");
    const finishScheduled = async (failure: boolean) => {
      const ref = (await activeOperation("source", scheduled.id))!;
      const claimed = (await claimOperation(ref.id, ref.step, "scheduler-test", LEASE))!;
      await withTransaction(async (tx) => {
        if (failure) await failOperation(tx, claimed, "token invalid");
        else {
          await completeOperation(tx, claimed);
          await markSourceSynced(scheduled.id, tx);
          const current = await row("SELECT id FROM crawl_tasks WHERE operation_id = $1", [ref.id]);
          await updateTask(current.id, { status: "已完成" }, tx);
        }
      });
    };
    await finishScheduled(true);
    assert.equal(await scheduleDueSources(), 0, "a failed task consumes its cadence, even with no successful sync");
    const ageTasks = (hours: number) => getPool().query("UPDATE crawl_tasks SET created_at = now() - $2 * interval '1 hour' WHERE source_id = $1", [scheduled.id, hours]);
    for (const [frequency, hours] of [["每小时", 1], ["每 6 小时", 6], ["每天", 24]] as const) {
      await getPool().query("UPDATE data_sources SET frequency = $2 WHERE id = $1", [scheduled.id, frequency]);
      await ageTasks(hours - 0.01);
      assert.equal(await scheduleDueSources(), 0, `${frequency}: not yet due`);
      await ageTasks(hours + 0.01);
      assert.equal(await scheduleDueSources(), 1, `${frequency}: due after a failure`);
      await finishScheduled(true);
      assert.equal(await scheduleDueSources(), 0, "repeated scheduler ticks do not create endless failed tasks");
    }
    await ageTasks(25);
    await updateSourceStatus(scheduled.id, "已暂停");
    assert.equal(await createTask(scheduled, { scheduled: true }), null, "stale scheduler candidates recheck pause under lock");
    await updateSourceStatus(scheduled.id, "运行中");
    const beforeRace = await taskCount(scheduled.id);
    const race = await Promise.all([scheduleDueSources(), createTask(scheduled), scheduleDueSources()]);
    assert.equal(await taskCount(scheduled.id), beforeRace + 1, "manual and scheduled races create one task/outbox pair");
    assert.ok(race.some(Boolean));
    await finishScheduled(false);
    await ageTasks(25);
    assert.equal(await scheduleDueSources(), 0, "successful completion anchors the next interval for long tasks");
    await getPool().query("UPDATE data_sources SET synced_at = now() - interval '25 hours' WHERE id = $1", [scheduled.id]);
    assert.equal(await scheduleDueSources(), 1, "durable database times remain due across scheduler invocations");
    await finishScheduled(true);
    await ageTasks(25);
    await getPool().query("UPDATE data_sources SET frequency = '手动' WHERE id = $1", [scheduled.id]);
    assert.equal(await createTask(scheduled, { scheduled: true }), null, "stale candidates recheck frequency");
    assert.equal(await scheduleDueSources(), 0);
    assert.ok(await createTask(scheduled), "manual sources still accept explicit sync");
    await finishScheduled(true);

    // 完整列表遍历也不是删除确认：缺席、404 和权限错误均保留现有正文与切片。
    const safe = await createSource({ name: "Safety", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "手动" });
    await withTransaction(async (tx) => {
      for (const key of ["absent", "404", "permission"]) {
        const id = await upsertDocument(tx, articleDocument(safe.id, key, key, `${key}的历史内容。`));
        await processDocument(tx, id);
      }
    });
    const snapshot = async () => (await getPool().query("SELECT d.*, (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM document_chunks c WHERE c.document_id = d.id) AS chunks FROM documents d WHERE d.source_id = $1 ORDER BY d.id", [safe.id])).rows;
    const original = await snapshot();
    const safeTask = (await createTask(safe))!;
    const safeRef = (await activeOperation("source", safe.id))!;
    const safeClaim = (await claimOperation(safeRef.id, 0, "safety-test", LEASE))!;
    await assert.rejects(syncArticles({
      state: { backfillDone: true }, known: new Map(), limit: 10, overlapPages: 1,
      client: { list: async () => ({ items: [{ _key: "404" }, { _key: "permission" }] }) }, pause: async () => {},
      process: async (item) => { throw new ArticleApiError(item._key === "404" ? "HTTP 404" : "permission denied", item._key !== "404"); },
      saveState: (state) => saveOwnedSyncState(safeClaim, safe.id, state),
    }), /permission denied/);
    assert.deepEqual((await getSourceSyncState(safe.id)).retryKeys, ["404", "permission"]);
    await syncArticles({
      state: await getSourceSyncState(safe.id), known: new Map(), limit: 10, overlapPages: 1,
      client: { list: async () => ({ items: [] }) }, pause: async () => {}, process: async () => assert.fail("no details"),
      saveState: (state) => saveOwnedSyncState(safeClaim, safe.id, state),
    });
    assert.ok((await getSourceSyncState(safe.id)).lastFullInspectionAt);
    assert.deepEqual(await snapshot(), original, "even a complete traversal with missing articles leaves all local data intact");
    await withTransaction(async (tx) => { await completeOperation(tx, safeClaim); await updateTask(safeTask.id, { status: "已完成" }, tx); });

    // 已投递但队列中没有 job（Redis 数据丢失）的操作由投递器确认后重新投递。
    const lost = (await activeOperation("document", other))!;
    await markDispatched(lost);
    await getPool().query("UPDATE operations SET dispatched_at = now() - interval '1 hour' WHERE id = $1", [lost.id]);
    assert.deepEqual((await listStaleDispatched(60_000)).map((item) => item.id), [lost.id]);
    await touchDispatched(lost);
    assert.deepEqual(await listStaleDispatched(60_000), []);

    // 删除主文档：接替的重复文档在同一事务内建立重新处理操作。
    const shared = "钠离子电池正极材料的研究进展与产业化前景。".repeat(4);
    const primary = await createDocument("primary", shared);
    const duplicate = await createDocument("duplicate", shared);
    assert.equal((await row("SELECT duplicate_of FROM documents WHERE id = $1", [duplicate])).duplicate_of, primary);
    assert.deepEqual(await deleteDocument(primary), { promotedId: duplicate });
    assert.deepEqual(await row("SELECT kind, status FROM operations WHERE target_id = $1", [duplicate]), { kind: "reprocess-document", status: "pending" });

    // 清理：每个目标只保留最近若干条已结束的操作。
    for (let index = 0; index < 4; index += 1) {
      const extra = await withTransaction(async (tx) => (await insertOperation(tx, "embed-document", documentId))!);
      await withTransaction(async (tx) => completeOperation(tx, (await claimOperation(extra.id, 0, "worker-a", LEASE))!));
    }
    const finished = async () => (await row("SELECT count(*)::int AS count FROM operations WHERE target_id = $1 AND finished_at IS NOT NULL", [documentId])).count;
    assert.equal(await finished(), 7);
    assert.ok(await pruneOperations(3, 24 * 60 * 60_000) >= 4);
    assert.equal(await finished(), 3);

    // 升级前的队列任务：转为等价的操作；延迟重试保留次数与执行时间；目标已有活动操作或不存在时不重复建立。
    const legacySource = await createSource({ name: "Legacy", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "" });
    await getPool().query("INSERT INTO crawl_tasks (id, source_id, source_name, status) VALUES ('CR-legacy', $1, 'Legacy', '等待中')", [legacySource.id]);
    assert.equal(await adoptLegacyJob({ name: "sync-source", data: { sourceId: legacySource.id, taskId: "CR-legacy" } }), true);
    assert.equal((await row("SELECT operation_id FROM crawl_tasks WHERE id = 'CR-legacy'")).operation_id, (await activeOperation("source", legacySource.id))!.id);
    assert.equal(await adoptLegacyJob({ name: "sync-source", data: { sourceId: legacySource.id, taskId: "CR-legacy" } }), false, "already adopted");
    const legacyDocument = await createDocument("legacy");
    const runAfter = new Date(Date.now() + 120_000);
    assert.equal(await adoptLegacyJob({ name: "reprocess-document", data: { documentId: legacyDocument, embedRetry: 2 }, runAfter }), true);
    const adopted = await row("SELECT kind, attempt, run_after FROM operations WHERE target_id = $1 AND status = 'pending'", [legacyDocument]);
    assert.deepEqual([adopted.kind, adopted.attempt, adopted.run_after.getTime()], ["embed-document", 2, runAfter.getTime()], "a delayed retry only embeds");
    assert.equal((await row("SELECT embedding_status FROM documents WHERE id = $1", [legacyDocument])).embedding_status, "queued");
    assert.equal(await adoptLegacyJob({ name: "embed-document", data: { documentId: legacyDocument } }), false);
    assert.equal(await adoptLegacyJob({ name: "embed-document", data: { documentId: "missing" } }), false);

    // 迁移 0021 的数据转换：升级时进行中的同步任务、待重新处理与向量排队中的文档转为操作。
    const migration = await readFile(new URL("../migrations/0021_operations.sql", import.meta.url), "utf8");
    const conversions = migration.split("--> statement-breakpoint").filter((statement) => statement.includes("gen_random_uuid"));
    assert.equal(conversions.length, 3);
    await getPool().query("DELETE FROM operations");
    const migrated = await createSource({ name: "Migrated", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "" });
    await getPool().query("UPDATE crawl_tasks SET status = '已完成'");
    await getPool().query("INSERT INTO crawl_tasks (id, source_id, source_name, status) VALUES ('CR-running', $1, 'Migrated', '运行中')", [migrated.id]);
    await getPool().query("UPDATE documents SET processing_status = 'chunked', embedding_status = 'ready'");
    await getPool().query("UPDATE documents SET processing_status = 'pending', embedding_status = 'queued' WHERE id = $1", [documentId]);
    await getPool().query("UPDATE documents SET embedding_status = 'processing' WHERE id = $1", [other]);
    for (const statement of conversions) await getPool().query(statement);
    const converted = (await getPool().query("SELECT kind, target_id, status FROM operations ORDER BY kind")).rows;
    assert.deepEqual(converted.map((item) => [item.kind, item.target_id, item.status]), [
      ["embed-document", other, "pending"], ["reprocess-document", documentId, "pending"], ["sync-source", migrated.id, "pending"],
    ], "a document waiting for reprocessing is embedded by that operation");
    assert.deepEqual(await row("SELECT status, operation_id IS NOT NULL AS linked FROM crawl_tasks WHERE id = 'CR-running'"), { status: "等待中", linked: true });
    assert.equal((await row("SELECT embedding_status FROM documents WHERE id = $1", [other])).embedding_status, "queued");
  } finally {
    await closeDatabase();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
