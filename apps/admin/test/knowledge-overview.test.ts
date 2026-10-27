import assert from "node:assert/strict";
import { test } from "node:test";
import type { KnowledgeOverview } from "@nyz-rag/types";
import { createKnowledgeOverview } from "../src/knowledge-overview.ts";
import { usePending } from "../src/composables/usePending.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function overview(name: string): KnowledgeOverview {
  return {
    sources: [{
      id: `source-${name}`, name, url: "https://example.com/articles", kind: "文章 API", frequency: "每天", status: "运行中",
      documentCount: 1, remoteTotal: null, backfillDone: false, failedCount: 0, updatedAt: null,
    }],
    tasks: [],
    stats: { documents: 1, chunks: 1, sources: 1 },
  } as unknown as KnowledgeOverview;
}

function setup() {
  const requests: Array<ReturnType<typeof deferred<KnowledgeOverview>> & { signal: AbortSignal }> = [];
  const store = createKnowledgeOverview((signal) => {
    const request = { ...deferred<KnowledgeOverview>(), signal };
    requests.push(request);
    return request.promise;
  });
  const names = () => store.sources.value.map((source) => source.name);
  return { store, requests, names };
}

test("only the latest overview request applies", async () => {
  const { store, requests, names } = setup();
  const first = store.load();
  const second = store.load();
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve(overview("second"));
  requests[0].resolve(overview("first"));
  await Promise.all([first, second]);
  assert.deepEqual(names(), ["second"]);
});

test("a pushed snapshot received while a request is in flight supersedes its result", async () => {
  const { store, requests, names } = setup();
  const loading = store.load();
  assert.equal(store.applySnapshot(JSON.stringify(overview("pushed")), store.generation()), true);
  requests[0].resolve(overview("stale"));
  await loading;
  assert.deepEqual(names(), ["pushed"]);

  // A request started after the snapshot applies normally.
  const next = store.load();
  requests[1].resolve(overview("fresh"));
  await next;
  assert.deepEqual(names(), ["fresh"]);
});

test("the operation backlog follows the latest overview and is cleared on reset", () => {
  const { store } = setup();
  const operations = { queued: 1, running: 0, delayed: 0, failedLastDay: 0, oldestQueuedAt: "2026-10-27T12:00:00.000Z" };
  store.applySnapshot(JSON.stringify(overview("valid")), store.generation());
  assert.equal(store.operations.value, null);
  store.applySnapshot(JSON.stringify({ ...overview("valid"), operations }), store.generation());
  assert.deepEqual(store.operations.value, operations);
  store.reset();
  assert.equal(store.operations.value, null);
});

test("malformed snapshots are ignored", () => {
  const { store, names } = setup();
  store.applySnapshot(JSON.stringify(overview("valid")), store.generation());
  assert.equal(store.applySnapshot("{not json", store.generation()), false);
  assert.equal(store.applySnapshot(JSON.stringify({ sources: null }), store.generation()), false);
  assert.deepEqual(names(), ["valid"]);
});

test("reset discards in-flight requests, their errors and snapshots from earlier watchers", async () => {
  const { store, requests, names } = setup();
  const watcher = store.generation();
  const succeeding = store.load();
  store.reset();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(overview("before logout"));
  await succeeding;
  assert.deepEqual(names(), []);

  const failing = store.load();
  store.reset();
  requests[1].reject(new Error("Unauthorized"));
  await failing;

  assert.equal(store.applySnapshot(JSON.stringify(overview("old watcher")), watcher), false);
  assert.deepEqual(names(), []);
});

test("failures of the current request are reported to the caller", async () => {
  const { store, requests } = setup();
  const loading = store.load();
  requests[0].reject(new Error("Unavailable"));
  await assert.rejects(loading, /Unavailable/);
});

test("pending writes ignore repeated triggers for the same id until settled", async () => {
  const { isPending, run } = usePending();
  const gate = deferred<void>();
  let calls = 0;
  const first = run("a", async () => { calls++; await gate.promise; });
  await run("a", async () => { calls++; });
  assert.equal(isPending("a"), true);
  await run("b", async () => { calls++; });
  assert.equal(calls, 2);
  gate.resolve();
  await first;
  assert.equal(isPending("a"), false);
  await assert.rejects(run("a", async () => { throw new Error("Failed"); }), /Failed/);
  assert.equal(isPending("a"), false);
});
