import assert from "node:assert/strict";
import { test } from "node:test";
import { effectScope } from "vue";
import { ApiError, type ApiClient, type StreamCallbacks } from "@nyz-rag/api-client";
import type { ChatSessionMessage, ChatSessionRecord, RetrievalFilters } from "@nyz-rag/types";
import { useChatSession } from "../src/composables/useChatSession.ts";

const record: ChatSessionRecord = { id: "session-1", title: "History", messageCount: 1, createdAt: "2026-10-24", updatedAt: "2026-10-24" };
const saved: ChatSessionMessage = {
  id: "message-1", question: "Question", answer: "Original answer", answerMode: "generated",
  sources: [{ documentId: "doc-1", title: "Article", url: "https://example.com", excerpts: [{ sectionPath: ["Section"], text: "Evidence" }] }],
  rating: "positive", createdAt: "2026-10-24",
};

function apiError(status: number) {
  return new ApiError(status, `HTTP ${status}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup({ saved: savedSession }: { saved?: string } = {}) {
  const requests: { path: string; init?: RequestInit }[] = [];
  const errors: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const streams: { path: string; init: RequestInit }[] = [];
  const storage = new Map<string, string>();
  let filters: RetrievalFilters | undefined;
  let sessionChanges = 0;
  let contentChanges = 0;
  let requestError: Error | null = null;
  let runStream: (init: RequestInit, callbacks: StreamCallbacks) => Promise<void> = async () => {};
  const client: Pick<ApiClient, "request" | "stream"> = {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      requests.push({ path, init });
      await gates.get(path);
      if (requestError) throw requestError;
      if (path.endsWith("/messages")) return { session: { ...record, id: path.split("/")[4] }, messages: [structuredClone(saved)] } as T;
      if (path.includes("?pageSize")) return { sessions: [record] } as T;
      return record as T;
    },
    async stream(path, init, callbacks) {
      streams.push({ path, init });
      await runStream(init, callbacks);
    },
  };
  const scope = effectScope();
  const chat = scope.run(() => useChatSession({
    client,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
    },
    currentFilters: () => filters,
    onSessionChange: () => { sessionChanges++; },
    onContentChange: async () => { contentChanges++; },
    onError: (message) => { errors.push(message); },
  }))!;
  if (savedSession) storage.set("nyz-rag:session", savedSession);
  await chat.initialize(async () => {});
  return {
    chat, requests, streams, storage, scope, errors,
    /** 让该路径的请求挂起，直到调用返回的函数。 */
    hold(path: string) {
      const gate = deferred();
      gates.set(path, gate.promise);
      return () => { gates.delete(path); gate.resolve(); };
    },
    setFilters(value: RetrievalFilters) { filters = value; },
    setStream(value: typeof runStream) { runStream = value; },
    failRequests(error: Error | null = new Error("Request failed")) { requestError = error; },
    get sessionChanges() { return sessionChanges; },
    get contentChanges() { return contentChanges; },
  };
}

test("asking creates a session, forwards filters and uses done as the final saved answer", async (t) => {
  const h = await setup();
  t.after(() => h.scope.stop());
  h.setFilters({ categories: ["Energy"] });
  h.setStream(async (_, callbacks) => {
    assert.equal(h.chat.busy.value, true);
    assert.equal(h.chat.turns.value[0].streaming, true);
    callbacks.onEvent({ event: "source", data: { ...saved.sources[0], citation: 1 } });
    assert.deepEqual(h.chat.turns.value[0].sources, saved.sources);
    callbacks.onEvent({ event: "token", data: { content: "Partial answer" } });
    assert.equal(h.chat.turns.value[0].answer, "Partial answer");
    callbacks.onEvent({ event: "done", data: saved });
  });
  h.chat.question.value = "  Question  ";
  await h.chat.ask();
  assert.equal(h.chat.question.value, "");
  assert.equal(h.chat.sessionId.value, record.id);
  assert.equal(h.storage.get("nyz-rag:session"), record.id);
  assert.equal(h.streams[0].path, "/api/chat/sessions/session-1/stream");
  assert.deepEqual(JSON.parse(String(h.streams[0].init.body)), { question: "Question", filters: { categories: ["Energy"] } });
  assert.deepEqual(h.chat.turns.value[0], { ...saved, streaming: false });
  assert.equal(h.chat.busy.value, false);
  assert.equal(h.contentChanges, 3);
  assert.equal(h.requests.filter(({ init }) => init?.method === "POST").length, 1);
});

test("stop leaves an unsaved turn, blocks session changes while streaming, and next ask replaces it", async (t) => {
  const h = await setup();
  t.after(() => h.scope.stop());
  const started = deferred();
  h.setStream(async (init, callbacks) => {
    callbacks.onEvent({ event: "token", data: { content: "Partial" } });
    started.resolve();
    await new Promise<void>((resolve) => init.signal!.addEventListener("abort", () => resolve(), { once: true }));
  });
  h.chat.question.value = "First";
  const pending = h.chat.ask();
  await started.promise;
  const count = h.requests.length;
  await h.chat.openSession("other");
  h.chat.newSession();
  h.chat.question.value = "Second";
  await h.chat.ask();
  await h.chat.regenerate();
  assert.equal(h.requests.length, count);
  assert.equal(h.streams.length, 1);
  assert.equal(h.chat.sessionId.value, record.id);
  h.chat.stop();
  await pending;
  assert.equal(h.streams[0].init.signal!.aborted, true);
  assert.equal(h.chat.turns.value[0].id, undefined);
  assert.equal(h.chat.turns.value[0].notice, "已停止生成，本轮回答未保存。");
  assert.equal(h.chat.busy.value, false);
  h.setStream(async (_, callbacks) => { callbacks.onEvent({ event: "done", data: { ...saved, question: "Second" } }); });
  await h.chat.ask();
  assert.equal(h.chat.turns.value.length, 1);
  assert.equal(h.chat.turns.value[0].question, "Second");
});

for (const failure of ["error", "incomplete", "abort"] as const) {
  test(`regeneration restores the saved answer, sources and rating after ${failure}`, async (t) => {
    const h = await setup();
    t.after(() => h.scope.stop());
    await h.chat.openSession(record.id);
    h.setStream(async (_, callbacks) => {
      assert.equal(h.chat.turns.value[0].answer, "");
      assert.equal(h.chat.turns.value[0].rating, null);
      callbacks.onEvent({ event: "token", data: { content: "Replacement" } });
      if (failure === "error") callbacks.onEvent({ event: "error", data: { error: "Model failed" } });
      else if (failure === "incomplete") callbacks.onIncomplete("Disconnected");
      else h.chat.stop();
    });
    await h.chat.regenerate();
    assert.deepEqual(JSON.parse(String(h.streams[0].init.body)), { regenerate: saved.id });
    assert.deepEqual(h.chat.turns.value[0], {
      ...saved, streaming: false, copied: false, notice: "重新生成未完成，已保留原回答。",
    });
    assert.equal(h.chat.busy.value, false);
  });
}

test("successful regeneration replaces the saved turn and clears its feedback", async (t) => {
  const h = await setup();
  t.after(() => h.scope.stop());
  await h.chat.openSession(record.id);
  const replacement = { ...saved, id: "message-2", answer: "New answer", rating: null };
  h.setStream(async (_, callbacks) => { callbacks.onEvent({ event: "done", data: replacement }); });
  await h.chat.regenerate();
  assert.equal(h.chat.turns.value.length, 1);
  assert.deepEqual(h.chat.turns.value[0], { ...replacement, streaming: false, copied: false, notice: undefined });
});

test("unsaved turns retry as a question and incomplete streams retain their notice", async (t) => {
  const h = await setup();
  t.after(() => h.scope.stop());
  h.chat.turns.value.push({ question: "Retry", answer: "Partial", sources: [], rating: null, notice: "Stopped" });
  h.setStream(async (_, callbacks) => { callbacks.onIncomplete("Disconnected"); });
  await h.chat.regenerate();
  assert.deepEqual(JSON.parse(String(h.streams[0].init.body)), { question: "Retry" });
  assert.equal(h.chat.turns.value[0].notice, "Disconnected");
  assert.equal(h.chat.turns.value[0].id, undefined);
});

test("session opening, restoring and clearing notify the page and retain persistence behavior", async (t) => {
  const h = await setup();
  t.after(() => h.scope.stop());
  await h.chat.openSession(record.id);
  assert.equal(h.sessionChanges, 1);
  assert.equal(h.contentChanges, 1);
  assert.deepEqual(h.chat.turns.value[0], saved);
  h.chat.newSession();
  assert.equal(h.chat.sessionId.value, null);
  assert.equal(h.chat.turns.value.length, 0);
  assert.equal(h.storage.has("nyz-rag:session"), false);
  assert.equal(h.sessionChanges, 2);

  const restored = await setup({ saved: record.id });
  t.after(() => restored.scope.stop());
  // Let the restored history request and page notification settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restored.chat.sessionId.value, record.id);
  assert.deepEqual(restored.requests.map(({ path }) => path), ["/api/chat/sessions?pageSize=30", "/api/chat/sessions/session-1/messages"]);
});

test("asking waits for the identity to be resolved and claims busy before the first await", async (t) => {
  const identity = deferred();
  const h = await setup();
  t.after(() => h.scope.stop());
  h.chat.ready.value = false;
  h.chat.question.value = "Too early";
  await h.chat.ask();
  assert.equal(h.chat.question.value, "Too early");
  assert.equal(h.streams.length, 0);
  const initializing = h.chat.initialize(() => identity.promise);
  assert.equal(h.chat.ready.value, false);
  identity.resolve();
  await initializing;
  h.setStream(async (_, callbacks) => { callbacks.onEvent({ event: "done", data: saved }); });
  const pending = h.chat.ask();
  assert.equal(h.chat.busy.value, true);
  await pending;
  assert.equal(h.streams.length, 1);
});

test("only the latest session request applies, and new sessions or asking invalidate pending ones", async (t) => {
  const h = await setup();
  t.after(() => h.scope.stop());
  const releaseA = h.hold("/api/chat/sessions/a/messages");
  const openA = h.chat.openSession("a");
  await h.chat.openSession("b");
  releaseA();
  await openA;
  assert.equal(h.chat.sessionId.value, "b");
  assert.equal(h.storage.get("nyz-rag:session"), "b");
  assert.equal(h.requests.find(({ path }) => path.endsWith("/a/messages"))!.init!.signal!.aborted, true);

  const releaseC = h.hold("/api/chat/sessions/c/messages");
  const openC = h.chat.openSession("c");
  h.chat.newSession();
  releaseC();
  await openC;
  assert.equal(h.chat.sessionId.value, null);
  assert.equal(h.chat.turns.value.length, 0);

  const releaseD = h.hold("/api/chat/sessions/d/messages");
  const openD = h.chat.openSession("d");
  h.setStream(async (_, callbacks) => { callbacks.onEvent({ event: "done", data: { ...saved, question: "Asked" } }); });
  h.chat.question.value = "Asked";
  await h.chat.ask();
  releaseD();
  await openD;
  assert.equal(h.chat.sessionId.value, record.id);
  assert.equal(h.chat.turns.value[0].question, "Asked");
  assert.deepEqual(h.errors, []);
});

test("transient history errors keep the session while missing sessions are cleared", async (t) => {
  const h = await setup();
  t.after(() => h.scope.stop());
  await h.chat.openSession(record.id);
  await h.chat.loadSessions();
  h.failRequests(apiError(503));
  await h.chat.openSession(record.id);
  assert.equal(h.chat.sessionId.value, record.id);
  assert.equal(h.storage.get("nyz-rag:session"), record.id);
  assert.equal(h.chat.turns.value.length, 1);
  await h.chat.loadSessions();
  assert.equal(h.chat.sessionError.value, "历史会话加载失败");
  assert.deepEqual(h.chat.sessions.value, [record]);

  h.failRequests(apiError(404));
  await h.chat.openSession(record.id);
  assert.equal(h.chat.sessionId.value, null);
  assert.equal(h.storage.has("nyz-rag:session"), false);
  assert.deepEqual(h.chat.sessions.value, []);
  assert.deepEqual(h.errors, ["会话加载失败，请稍后重试", "会话不存在或已删除"]);

  h.failRequests(null);
  await h.chat.loadSessions();
  assert.equal(h.chat.sessionError.value, "");
});

test("restoring is silent for a missing session but reports transient failures and keeps the saved id", async (t) => {
  for (const [status, kept, errors] of [[404, false, []], [500, true, ["上次的会话加载失败，请稍后刷新重试"]]] as const) {
    const h = await setup();
    t.after(() => h.scope.stop());
    h.storage.set("nyz-rag:session", record.id);
    h.failRequests(apiError(status));
    await h.chat.initialize(async () => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.storage.has("nyz-rag:session"), kept);
    assert.deepEqual(h.errors, errors);
  }
});

test("signing out discards pending session and list responses from the previous identity", async (t) => {
  const h = await setup();
  t.after(() => h.scope.stop());
  await h.chat.openSession(record.id);
  const releaseDetail = h.hold("/api/chat/sessions/other/messages");
  const releaseList = h.hold("/api/chat/sessions?pageSize=30");
  const opening = h.chat.openSession("other");
  const listing = h.chat.loadSessions();
  h.chat.identityChanged("signed-out");
  assert.equal(h.chat.sessionId.value, null);
  assert.deepEqual(h.chat.sessions.value, []);
  releaseDetail();
  releaseList();
  await Promise.all([opening, listing]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.chat.sessionId.value, null);
  assert.equal(h.chat.turns.value.length, 0);
  const lists = h.requests.filter(({ path }) => path.includes("?pageSize"));
  assert.equal(lists.at(-2)!.init!.signal!.aborted, true);
  assert.equal(lists.at(-1)!.init!.signal!.aborted, false);
});

test("scope disposal aborts an active request", async () => {
  const h = await setup();
  const started = deferred();
  h.setStream(async (init) => {
    started.resolve();
    await new Promise<void>((resolve) => init.signal!.addEventListener("abort", () => resolve(), { once: true }));
  });
  h.chat.question.value = "Question";
  const pending = h.chat.ask();
  await started.promise;
  h.scope.stop();
  await pending;
  assert.equal(h.streams[0].init.signal!.aborted, true);
  assert.equal(h.chat.busy.value, false);
});
