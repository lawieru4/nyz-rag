import assert from "node:assert/strict";
import test from "node:test";
import type { Queue } from "bullmq";
import { documentJobId, documentQueueService, sourceJobId } from "../src/queue.js";

test("document jobs share IDs and source jobs retain their task identity", async () => {
  const calls: unknown[][] = [];
  const queue = { add: async (...args: unknown[]) => { calls.push(args); } } as unknown as Queue;
  let closed = false;
  const service = documentQueueService(queue, async () => { closed = true; });
  await service.enqueueDocument("embed-document", "doc-1");
  await service.enqueueDocument("reprocess-document", "doc-1");
  await service.enqueueSource("src-1", "CR-1");
  assert.deepEqual(calls, [
    ["embed-document", { documentId: "doc-1" }, { jobId: documentJobId("doc-1"), removeOnComplete: true, removeOnFail: true }],
    ["reprocess-document", { documentId: "doc-1" }, { jobId: documentJobId("doc-1"), removeOnComplete: true, removeOnFail: true }],
    ["sync-source", { sourceId: "src-1", taskId: "CR-1" }, { jobId: sourceJobId("CR-1"), removeOnComplete: true, removeOnFail: true }],
  ]);
  await service.close();
  assert.equal(closed, true);
});

test("duplicate checks cover document jobs and source sync jobs without blocking other sources", async () => {
  const ids = new Set<string>();
  const jobs: Array<{ name: string; data: { sourceId: string } }> = [];
  const states: unknown[] = [];
  const queue = {
    getJob: async (id: string) => ids.has(id) ? {} : undefined,
    getJobs: async (types: string[]) => { states.push(types); return jobs; },
  } as unknown as Queue;
  const service = documentQueueService(queue, async () => {});
  const document = { id: "doc-1", sourceId: "src-1" };
  assert.equal(await service.hasDocumentJob(document), false);
  ids.add(documentJobId(document.id));
  assert.equal(await service.hasDocumentJob(document), true);
  ids.clear();
  jobs.push({ name: "sync-source", data: { sourceId: "src-1" } });
  assert.equal(await service.hasDocumentJob(document), true);
  assert.equal(await service.hasDocumentJob({ ...document, sourceId: "src-2" }), false);
  assert.equal(await service.hasSourceJob("src-1"), true);
  assert.equal(await service.hasSourceJob("src-2"), false);
  assert.deepEqual(states.at(-1), ["active", "waiting", "delayed", "paused"]);
});

test("enqueue failures propagate to the route for persisted state recovery", async () => {
  const queue = { add: async () => { throw new Error("queue unavailable"); } } as unknown as Queue;
  const service = documentQueueService(queue, async () => {});
  await assert.rejects(service.enqueueDocument("embed-document", "doc-1"), /queue unavailable/);
  await assert.rejects(service.enqueueSource("src-1", "CR-1"), /queue unavailable/);
});
