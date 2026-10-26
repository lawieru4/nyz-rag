import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { setImmediate } from "node:timers/promises";
import { mock, test } from "node:test";
import * as processing from "@nyz-rag/processing";
import type { ChatChunk, ChatMessage, ChatModel } from "@nyz-rag/processing";
import type { ChatSessionMessage, KnowledgeBaseRecord } from "@nyz-rag/types";

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
let knowledgeBases: KnowledgeBaseRecord[] = [];
let sessionHistory: ChatSessionMessage[] = [];
// The query rewrite call is routed by its system prompt; answer calls go to `stream`.
let rewriteStream: ChatModel["streamChat"];
let rewriteSelections: processing.ModelSelection[] = [];
let rewriteSetting: processing.ModelSelection | null = null;
let searchedTerms: string[][] = [];
const isRewrite = (messages: ChatMessage[]) => messages[0].content.includes("问题改写器");

// Keep the real retrieval/context/prompt/citation functions; replace only storage
// and the external model boundary. Both production route handlers run unchanged.
mock.module("@nyz-rag/processing", { namedExports: {
  ...processing,
  getModelSelections: async () => ({ chat: configured ? selection : null, embedding: null, rerank: null, review: null, rewrite: rewriteSetting }),
  keywordSearchChunks: async (terms: string[]) => { searchedTerms.push(terms); return hits; },
  listKnowledgeBases: async () => knowledgeBases,
  getChatSession: async () => ({ id: sessionId, title: "Test", messageCount: 0, createdAt: "", updatedAt: "" }),
  listSessionMessages: async () => sessionHistory,
  createChatMessage: async (value: Saved) => { saved.push(value); },
  createChatModel: (selection: processing.ModelSelection) => ({ model: "mock-chat", streamChat: (messages: ChatMessage[], options?: { signal?: AbortSignal }) => {
    if (isRewrite(messages)) {
      rewriteSelections.push(selection);
      return rewriteStream(messages, options);
    }
    prompt = messages;
    return stream(messages, options);
  } }),
} });

const { buildTestApp, memoryAuthStore, memoryUsers, userAuth, userHeaders } = await import("./auth-helpers.js");

function makeApp() {
  saved.length = 0;
  hits = [hit];
  configured = true;
  knowledgeBases = [];
  sessionHistory = [];
  rewriteSelections = [];
  rewriteSetting = null;
  searchedTerms = [];
  rewriteStream = async function* () { assert.fail("no history, no query rewrite"); };
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
      // An out-of-range citation stops reading the provider stream, so its trailing usage never arrives.
      assert.equal(saved[0].promptTokens, /\[[02]\]/.test(text) ? undefined : 20, "provider usage is retained when output is rejected after completion");
      assert.equal(typeof saved[0].firstTokenMs, sse ? "number" : "undefined");
      assert.ok(prompt[0].content.includes(refusal));
      if (sse) {
        if (accepted) assert.equal(tokens(response.body), result.answer);
        assert.equal(events(response.body).filter((event) => event.event === "source").length, 1);
        assert.doesNotMatch(tokens(response.body), /\[[02]\]/, "out-of-range citations are never streamed");
      } else if (!accepted) assert.doesNotMatch(response.body, /REJECTED_/);
    } finally { await app.close(); }
  });
});

test("provider failure after streamed tokens is replaced by cautious evidence in done", async () => {
  for (const sse of [false, true]) {
    const app = makeApp();
    stream = async function* () {
      yield { type: "token", text: "REJECTED_PARTIAL [1]" };
      throw new Error("provider failed");
    };
    try {
      const response = await send(app, sse);
      assert.equal(response.statusCode, 200);
      assert.equal(saved[0].answerMode, "extractive");
      assert.match(saved[0].answer, /未验证其是否足以回答问题/);
      if (sse) {
        assert.equal(tokens(response.body), "REJECTED_PARTIAL [1]", "streamed text is not followed by fallback tokens");
        assert.equal(events(response.body).find((event) => event.event === "done")!.data.answer, saved[0].answer);
      } else assert.doesNotMatch(response.body, /REJECTED_PARTIAL/);
    } finally { await app.close(); }
  }
});

test("AdmissionError after streamed output stays an error, without fallback or save", async () => {
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
      if (sse) {
        assert.deepEqual(events(response.body).filter((event) => event.event !== "source"), [
          { event: "token", data: { content: "REJECTED_ADMISSION [1]" } },
          { event: "error", data: { error: "Model busy" } },
        ]);
      } else {
        assert.doesNotMatch(response.body, /REJECTED_ADMISSION/);
        assert.equal(response.headers["retry-after"], "7");
        assert.deepEqual(response.json(), { error: "Model busy" });
      }
    } finally { await app.close(); }
  }
});

test("an out-of-range citation stops generation before it is streamed", async () => {
  const app = makeApp();
  let requested = 0;
  let closed = false;
  stream = async function* () {
    try {
      for (const text of ["Answer [", "1] then [1", "，", "3] tail", "UNREACHED"]) { requested++; yield { type: "token", text }; }
    } finally { closed = true; }
  };
  try {
    const response = await send(app, true);
    assert.equal(tokens(response.body), "Answer [1] then ", "held-back partial citation is dropped with the invalid one");
    assert.equal(requested, 4, "provider stream is not read after the invalid citation");
    assert.ok(closed, "provider stream is closed");
    assert.equal(saved[0].answerMode, "extractive");
    assert.equal(events(response.body).find((event) => event.event === "done")!.data.answer, saved[0].answer);
  } finally { await app.close(); }
});

test("with citation check off, non-empty answers are accepted as before and streamed in full", async (t) => {
  const knowledgeBase: KnowledgeBaseRecord = {
    id: "kb-1", name: "KB", description: "", topK: 5, similarityThreshold: 0.3, rerankEnabled: false, citationCheck: false,
    maxContextLength: 6000, prompt: "", model: "", createdAt: "", updatedAt: "",
  };
  for (const [label, text, accepted] of [
    ["no citation", "Plain answer", true],
    ["out-of-range citation", "Answer [3] more", true],
    ["empty", "  ", false],
  ] as const) for (const sse of [false, true]) await t.test(`${label}, SSE=${sse}`, async () => {
    const app = makeApp();
    knowledgeBases = [knowledgeBase];
    stream = async function* () {
      yield { type: "token", text: text.slice(0, 8) };
      yield { type: "token", text: text.slice(8) };
      yield { type: "usage", promptTokens: 20, completionTokens: 10 };
    };
    try {
      const response = await send(app, sse);
      const result = sse ? events(response.body).find((event) => event.event === "done")!.data : response.json();
      const context = processing.buildAnswerContext([{ ...hit, keywordScore: 1 }], 6000);
      assert.equal(result.answerMode, accepted ? "generated" : "extractive");
      assert.equal(result.answer, accepted ? text : processing.extractiveAnswer(context, false));
      assert.match(processing.extractiveAnswer(context, false), /未经模型生成/);
      assert.equal(saved[0].promptTokens, 20, "the provider stream is read to the end");
      assert.ok(!prompt[0].content.includes(processing.INSUFFICIENT_EVIDENCE_ANSWER), "lenient prompt has no fixed refusal");
      if (sse) assert.equal(tokens(response.body), text);
    } finally { await app.close(); }
  });
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

test("SSE streams tokens as they arrive, measures first token, and discards on disconnect", { timeout: 10000 }, async (t) => {
  for (const disconnect of [false, true]) await t.test(`disconnect=${disconnect}`, async (t) => {
    const app = makeApp();
    let yielded!: () => void;
    let finish!: () => void;
    let aborted!: () => void;
    let handled!: () => void;
    let drained!: () => void;
    const firstYield = new Promise<void>((resolve) => { yielded = resolve; });
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
      yield { type: "token", text: "Streamed answer " } satisfies ChatChunk;
      yielded();
      await pending;
      now = 900;
      // Deliberately keep yielding after abort: even an uncooperative provider
      // must not cause more text to be emitted or persisted after disconnect.
      try { yield { type: "token", text: "[1]" } satisfies ChatChunk; }
      finally { drained(); }
    };
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      let received = "";
      let closeClient!: () => void;
      let sawToken!: () => void;
      const token = new Promise<void>((resolve) => { sawToken = resolve; });
      const responseDone = new Promise<void>((resolve, reject) => {
        const client = httpRequest(`${address}/api/chat/sessions/${sessionId}/stream`, { method: "POST", headers: { ...userHeaders, "content-type": "application/json" } }, (response) => {
          closeClient = () => { response.destroy(); resolve(); };
          response.on("data", (chunk) => { received += chunk.toString(); if (received.includes("event: token")) sawToken(); });
          response.on("end", resolve);
          response.on("error", reject);
        });
        client.on("error", reject);
        client.end(JSON.stringify({ question: "Question" }));
      });
      await Promise.all([token, firstYield]);
      assert.equal(tokens(received), "Streamed answer ", "first token arrives before the model finishes");
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
        assert.equal(tokens(received), "Streamed answer [1]");
        assert.equal(saved[0].firstTokenMs, 100, "measured at the first streamed token");
        assert.equal(saved[0].answerMode, "generated");
      }
    } finally { finish(); await app.close(); }
  });
});

test("follow-ups retrieve with the rewritten question, answer with the original, and fall back on rewrite failure", async (t) => {
  const previous: ChatSessionMessage = {
    id: "m1", question: "介绍一种正极材料", answer: "磷酸锰铁锂是一种正极材料 [1]。", answerMode: "generated", rating: null, createdAt: "",
    sources: [{ documentId: "doc-1", title: "磷酸锰铁锂研究进展", url: "https://example.test/a" }],
  };
  const answered: ChatModel["streamChat"] = async function* () { yield { type: "token", text: "Supported answer [1]" }; };
  const followUp = (app: ReturnType<typeof makeApp>) => app.inject({
    method: "POST", url: `/api/chat/sessions/${sessionId}/stream`, headers: userHeaders, payload: { question: "它的循环寿命怎么样？" },
  });

  await t.test("rewritten", async () => {
    const app = makeApp();
    sessionHistory = [previous];
    stream = answered;
    let rewritePrompt: ChatMessage[] = [];
    rewriteStream = async function* (messages) {
      rewritePrompt = messages;
      yield { type: "token", text: "磷酸锰铁锂的循环寿命如何？" };
      yield { type: "usage", promptTokens: 150, completionTokens: 9 };
    };
    try {
      const response = await followUp(app);
      assert.equal(events(response.body).find((event) => event.event === "done")!.data.answerMode, "generated");
      assert.deepEqual(searchedTerms, [processing.searchTerms("磷酸锰铁锂的循环寿命如何？")]);
      assert.match(rewritePrompt[1].content, /参考文章：《磷酸锰铁锂研究进展》/);
      assert.deepEqual(rewriteSelections.map(({ temperature, maxTokens }) => ({ temperature, maxTokens })), [{ temperature: 0, maxTokens: processing.REWRITE_MAX_TOKENS }]);
      assert.ok(prompt.at(-1)!.content.endsWith("问题：它的循环寿命怎么样？"), "the answer model gets the original question");
      assert.ok(prompt.some((message) => message.role === "user" && message.content === previous.question), "and the history");
      assert.equal(saved[0].question, "它的循环寿命怎么样？");
      assert.equal(saved[0].retrievalQuery, "磷酸锰铁锂的循环寿命如何？");
      assert.equal(typeof saved[0].rewriteMs, "number");
      assert.deepEqual([saved[0].rewritePromptTokens, saved[0].rewriteCompletionTokens], [150, 9]);
      assert.equal(saved[0].promptTokens, undefined, "answer usage stays separate from rewrite usage");
    } finally { await app.close(); }
  });

  for (const [label, rewrite] of [
    ["provider failure", async function* () { throw new Error("provider failed"); }],
    ["unusable output", async function* () { yield { type: "token", text: "这是一段回答\n而不是问题" }; }],
  ] as const) await t.test(label, async () => {
    const app = makeApp();
    sessionHistory = [previous];
    stream = answered;
    rewriteStream = rewrite as ChatModel["streamChat"];
    try {
      const response = await followUp(app);
      assert.equal(events(response.body).find((event) => event.event === "done")!.data.answerMode, "generated");
      assert.deepEqual(searchedTerms, [processing.searchTerms("它的循环寿命怎么样？")]);
      assert.equal(saved[0].retrievalQuery, undefined);
      assert.equal(typeof saved[0].rewriteMs, "number", "the attempt is still timed");
      assert.equal(saved[0].rewritePromptTokens, undefined);
    } finally { await app.close(); }
  });

  await t.test("AdmissionError stays an error without saving", async () => {
    const app = makeApp();
    sessionHistory = [previous];
    stream = async function* () { assert.fail("no answer after a rejected rewrite"); };
    rewriteStream = async function* () { throw new processing.AdmissionError(429, 3, "Model busy"); };
    try {
      const response = await followUp(app);
      assert.deepEqual(events(response.body), [{ event: "error", data: { error: "Model busy" } }]);
      assert.equal(saved.length, 0);
    } finally { await app.close(); }
  });

  await t.test("a configured rewrite model is used with its own settings, even without a chat model", async () => {
    const app = makeApp();
    sessionHistory = [previous];
    configured = false;
    rewriteSetting = { ...selection, model: "mock-rewrite", temperature: 0.1, maxTokens: 512 };
    rewriteStream = async function* () { yield { type: "token", text: "磷酸锰铁锂的循环寿命如何？" }; };
    try {
      await followUp(app);
      assert.deepEqual(rewriteSelections.map(({ model, temperature, maxTokens }) => ({ model, temperature, maxTokens })), [{ model: "mock-rewrite", temperature: 0.1, maxTokens: 512 }]);
      assert.deepEqual(searchedTerms, [processing.searchTerms("磷酸锰铁锂的循环寿命如何？")]);
      assert.equal(saved[0].answerMode, "extractive");
    } finally { await app.close(); }
  });

  await t.test("no rewrite or chat model means no rewrite", async () => {
    const app = makeApp();
    sessionHistory = [previous];
    configured = false;
    try {
      await followUp(app);
      assert.deepEqual(searchedTerms, [processing.searchTerms("它的循环寿命怎么样？")]);
      assert.equal(saved[0].rewriteMs, undefined);
    } finally { await app.close(); }
  });
});
