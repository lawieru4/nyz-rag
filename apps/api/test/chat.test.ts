import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { setImmediate } from "node:timers/promises";
import { mock, test } from "node:test";
import * as processing from "@nyz-rag/processing";
import type { ChatChunk, ChatMessage, ChatModel } from "@nyz-rag/processing";

const sessionId = "00000000-0000-4000-8000-000000000001";
const hit: processing.ChunkHit = {
  chunkId: "chunk-1", documentId: "doc-1", title: "Evidence", url: "https://example.test/article",
  content: "Retrieved evidence excerpt.", context: "", sectionPath: [], contentType: "text", score: 1,
};
const selection: processing.ModelSelection = {
  model: "mock-chat", temperature: 0.2, maxTokens: 256,
  provider: { id: "p1", name: "Mock", provider: "compatible", baseUrl: "https://example.test/v1", credentialEnv: "", hasApiKey: false, enabled: true, createdAt: "", updatedAt: "" },
};
type Saved = Parameters<typeof processing.createChatMessage>[0];
const saved: Saved[] = [];
let hits = [hit];
let configured = true;
let stream: ChatModel["streamChat"];
let prompt: ChatMessage[] = [];

// Keep the real retrieval/context/prompt/citation functions; replace only storage
// and the external model boundary. Both production route handlers run unchanged.
mock.module("@nyz-rag/processing", { namedExports: {
  ...processing,
  getModelSelections: async () => ({ chat: configured ? selection : null, embedding: null, rerank: null }),
  keywordSearchChunks: async () => hits,
  listKnowledgeBases: async () => [],
  getChatSession: async () => ({ id: sessionId, title: "Test", messageCount: 0, createdAt: "", updatedAt: "" }),
  listSessionMessages: async () => [],
  createChatMessage: async (value: Saved) => { saved.push(value); },
  createChatModel: () => ({ model: "mock-chat", streamChat: (messages: ChatMessage[], options?: { signal?: AbortSignal }) => {
    prompt = messages;
    return stream(messages, options);
  } }),
} });

const { buildTestApp, memoryAuthStore, memoryUsers, userAuth, userHeaders } = await import("./auth-helpers.js");

function makeApp() {
  saved.length = 0;
  hits = [hit];
  configured = true;
  return buildTestApp({ userAuth, userAuthStore: memoryAuthStore(), users: memoryUsers().repository, mailer: null });
}

const events = (body: string) => [...body.matchAll(/event: (\w+)\ndata: (.+)\n\n/g)].map((match) => ({ event: match[1], data: JSON.parse(match[2]) }));
const tokens = (body: string) => events(body).filter((event) => event.event === "token").map((event) => event.data.content).join("");
const send = (app: ReturnType<typeof makeApp>, sse: boolean) => app.inject({
  method: "POST", url: sse ? `/api/chat/sessions/${sessionId}/stream` : "/api/chat", headers: userHeaders, payload: { question: "What does the evidence say?" },
});

test("single-answer and SSE use the same citation presence/ID gate and exact refusal", async (t) => {
  const refusal = processing.INSUFFICIENT_EVIDENCE_ANSWER;
  for (const [label, text, accepted] of [
    ["valid", "Supported answer [1]", true],
    ["grouped valid", "Supported answer [1，1][1、1]", true],
    ["invalid high ID", "REJECTED_HIGH [1][2]", false],
    ["zero ID", "REJECTED_ZERO [0]", false],
    ["missing", "REJECTED_MISSING", false],
    ["empty", "  ", false],
    ["fixed refusal", refusal, true],
    ["refusal with suffix", `${refusal}REJECTED_SUFFIX`, false],
    ["refusal with prefix", `REJECTED_PREFIX${refusal}`, false],
    ["refusal with invalid citation", `${refusal}[2]`, false],
  ] as const) for (const sse of [false, true]) await t.test(`${label}, SSE=${sse}`, async () => {
    const app = makeApp();
    stream = async function* () {
      yield { type: "token", text: text.slice(0, 4) };
      yield { type: "token", text: text.slice(4) };
      yield { type: "usage", promptTokens: 20, completionTokens: 10 };
    };
    try {
      const response = await send(app, sse);
      assert.equal(response.statusCode, 200, response.body);
      const result = sse ? events(response.body).find((event) => event.event === "done")!.data : response.json();
      assert.equal(result.answerMode, accepted ? "generated" : "extractive");
      assert.equal(result.answer, accepted ? text : processing.extractiveAnswer(processing.buildAnswerContext([{ ...hit, keywordScore: 1 }], 6000)));
      assert.equal(saved.length, 1);
      assert.equal(saved[0].answer, result.answer);
      assert.equal(saved[0].model, accepted ? "mock-chat" : undefined);
      assert.equal(saved[0].promptTokens, 20, "provider usage is retained even when output is rejected");
      assert.equal(typeof saved[0].firstTokenMs, sse ? "number" : "undefined");
      assert.ok(prompt[0].content.includes(refusal));
      if (sse) {
        assert.equal(tokens(response.body), result.answer);
        assert.equal(events(response.body).filter((event) => event.event === "source").length, 1);
      }
      if (!accepted) assert.doesNotMatch(response.body, /REJECTED_/);
    } finally { await app.close(); }
  });
});

test("provider failure after buffered tokens emits only cautious evidence", async () => {
  for (const sse of [false, true]) {
    const app = makeApp();
    stream = async function* () {
      yield { type: "token", text: "REJECTED_PARTIAL [1]" };
      throw new Error("provider failed");
    };
    try {
      const response = await send(app, sse);
      assert.equal(response.statusCode, 200);
      assert.doesNotMatch(response.body, /REJECTED_PARTIAL/);
      assert.equal(saved[0].answerMode, "extractive");
      assert.match(saved[0].answer, /未验证其是否足以回答问题/);
      if (sse) assert.equal(tokens(response.body), saved[0].answer);
    } finally { await app.close(); }
  }
});

test("AdmissionError after buffered output stays an error, without fallback or save", async () => {
  for (const status of [429, 503] as const) for (const sse of [false, true]) {
    const app = makeApp();
    stream = async function* () {
      yield { type: "token", text: "REJECTED_ADMISSION [1]" };
      throw new processing.AdmissionError(status, 7, "Model busy");
    };
    try {
      const response = await send(app, sse);
      assert.equal(response.statusCode, sse ? 200 : status);
      assert.equal(saved.length, 0);
      assert.doesNotMatch(response.body, /REJECTED_ADMISSION/);
      if (sse) {
        assert.equal(tokens(response.body), "");
        assert.deepEqual(events(response.body).filter((event) => event.event !== "source"), [{ event: "error", data: { error: "Model busy" } }]);
      } else {
        assert.equal(response.headers["retry-after"], "7");
        assert.deepEqual(response.json(), { error: "Model busy" });
      }
    } finally { await app.close(); }
  }
});

test("no context or no configured model keeps the extractive path without calling the provider", async () => {
  for (const noContext of [false, true]) {
    const app = makeApp();
    if (noContext) hits = [];
    else configured = false;
    stream = async function* () { assert.fail("provider should not be called"); };
    try {
      const response = await send(app, true);
      assert.equal(saved[0].answerMode, "extractive");
      assert.equal(tokens(response.body), saved[0].answer);
      if (noContext) assert.equal(saved[0].answer, processing.NO_MATCH_ANSWER);
    } finally { await app.close(); }
  }
});

test("SSE buffers until completion, measures emitted text, and discards on disconnect", { timeout: 10000 }, async (t) => {
  for (const disconnect of [false, true]) await t.test(`disconnect=${disconnect}`, async (t) => {
    const app = makeApp();
    let buffered!: () => void;
    let finish!: () => void;
    let aborted!: () => void;
    let handled!: () => void;
    let drained!: () => void;
    const buffering = new Promise<void>((resolve) => { buffered = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const abort = new Promise<void>((resolve) => { aborted = resolve; });
    const complete = new Promise<void>((resolve) => { handled = resolve; });
    const streamFinished = new Promise<void>((resolve) => { drained = resolve; });
    app.addHook("onResponse", async () => { handled(); });
    let now = 0;
    t.mock.method(performance, "now", () => now);
    stream = async function* (_messages, options) {
      options!.signal!.addEventListener("abort", () => { aborted(); finish(); }, { once: true });
      now = 100;
      yield { type: "token", text: "Buffered accepted answer [1]" } satisfies ChatChunk;
      buffered();
      await pending;
      now = 900;
      // Deliberately finish normally on abort: even an uncooperative provider
      // must not cause buffered text to be emitted or persisted after disconnect.
      drained();
    };
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      let received = "";
      let closeClient!: () => void;
      let sawSource!: () => void;
      const source = new Promise<void>((resolve) => { sawSource = resolve; });
      const responseDone = new Promise<void>((resolve, reject) => {
        const client = httpRequest(`${address}/api/chat/sessions/${sessionId}/stream`, { method: "POST", headers: { ...userHeaders, "content-type": "application/json" } }, (response) => {
          closeClient = () => { response.destroy(); resolve(); };
          response.on("data", (chunk) => { received += chunk.toString(); if (received.includes("event: source")) sawSource(); });
          response.on("end", resolve);
          response.on("error", reject);
        });
        client.on("error", reject);
        client.end(JSON.stringify({ question: "Question" }));
      });
      await Promise.all([source, buffering]);
      assert.equal(tokens(received), "", "no token before validation completes");
      assert.doesNotMatch(received, /Buffered accepted/);
      if (disconnect) {
        closeClient();
        await abort;
      } else finish();
      await responseDone;
      if (disconnect) {
        await streamFinished;
        await setImmediate(); // Let the route discard the completed aborted result.
      } else await complete;
      if (disconnect) assert.equal(saved.length, 0);
      else {
        assert.equal(tokens(received), "Buffered accepted answer [1]");
        assert.equal(saved[0].firstTokenMs, 900, "not the provider's buffered arrival at 100ms");
        assert.equal(saved[0].answerMode, "generated");
      }
    } finally { finish(); await app.close(); }
  });
});
