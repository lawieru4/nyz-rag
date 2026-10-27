import assert from "node:assert/strict";
import { test } from "node:test";
import { backlogStatus } from "../src/views/sources.ts";

const backlog = { queued: 0, running: 0, delayed: 0, failedLastDay: 0, oldestQueuedAt: null };
const now = Date.parse("2026-10-27T12:00:00Z");

test("backlog shows counts and flags failures", () => {
  const status = backlogStatus({ ...backlog, queued: 2, running: 1, failedLastDay: 3 }, now);
  assert.deepEqual(status.items.map((item) => [item.label, item.value, Boolean(item.danger)]), [
    ["排队", 2, false], ["执行中", 1, false], ["等待重试", 0, false], ["24 小时内失败", 3, true],
  ]);
  assert.equal(status.stalled, null);
});

test("operations queued for too long point at the worker", () => {
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  assert.equal(backlogStatus({ ...backlog, queued: 1, oldestQueuedAt: at(4) }, now).stalled, null);
  assert.equal(backlogStatus({ ...backlog, queued: 1, oldestQueuedAt: at(5) }, now).stalled, "最早一项已排队 5 分钟，请确认 Worker 正在运行");
  assert.match(backlogStatus({ ...backlog, queued: 1, oldestQueuedAt: at(150) }, now).stalled!, /2 小时/);
  assert.match(backlogStatus({ ...backlog, queued: 1, oldestQueuedAt: at(3 * 1440) }, now).stalled!, /3 天/);
});
