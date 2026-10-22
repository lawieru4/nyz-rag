import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelProviderRecord } from "@nyz-rag/types";
import { createChatModel, createRerankModel } from "../src/models.js";
import { buildAnswerContext, buildChatMessages, extractiveAnswer, NO_MATCH_ANSWER, retrieve, retrievedChunkRecords, type ChunkHit } from "../src/rag.js";
import { metadataScore, metadataSearchFields, metadataSearchTerms, metadataTermWeights, searchTerms, termCounts } from "../src/search-terms.js";

const hit = (chunkId: string, score: number, overrides: Partial<ChunkHit> = {}): ChunkHit => ({
  chunkId, documentId: `doc-${chunkId}`, title: `标题${chunkId}`, url: `https://example.test/${chunkId}`, content: `正文${chunkId}`, context: `文章：标题${chunkId}`,
  sectionPath: [], contentType: "text", score, ...overrides,
});
const settings = { topK: 3, similarityThreshold: 0.5, rerankEnabled: false, maxContextLength: 1000 };

function provider(overrides: Partial<ModelProviderRecord> = {}): ModelProviderRecord {
  return {
    id: "provider-1", name: "Compatible", provider: "compatible", baseUrl: "https://models.example/v1", chatModel: "chat-model", embeddingModel: "", rerankModel: "rerank-model",
    temperature: 0.2, maxTokens: 256, credentialEnv: "RETRIEVAL_TEST_API_KEY", enabled: true, isDefault: true, createdAt: "", updatedAt: "", ...overrides,
  };
}

function mockFetch(context: { after(fn: () => void): void }, handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const oldKey = process.env.RETRIEVAL_TEST_API_KEY;
  const oldFetch = globalThis.fetch;
  context.after(() => {
    if (oldKey === undefined) delete process.env.RETRIEVAL_TEST_API_KEY;
    else process.env.RETRIEVAL_TEST_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  });
  process.env.RETRIEVAL_TEST_API_KEY = "test-secret";
  globalThis.fetch = (async (input, init) => handler(String(input), init)) as typeof fetch;
}

test("search terms normalize formulas and full-width text into bigrams and words", () => {
  assert.deepEqual(searchTerms("Na₀.₉FeO₂ 正极"), ["na0.9feo2", "正极"]);
  assert.deepEqual(searchTerms("钠离子，Ｌｉ 与 x"), ["钠离", "离子", "li", "与"]);
  assert.deepEqual(searchTerms(`${"a".repeat(65)} ab`), ["ab"], "overlong tokens are skipped");
  assert.equal(termCounts("电池电池").get("电池"), 2);
});

test("metadata search fields weight project fields and keywords without double counting", () => {
  const metadata = {
    sourceMeta: { keywords: ["锂硫电池", "硫正极"] },
    projectMeta: { name: "锂硫电池项目", principal: "Yi Cui（崔屹）", institution: "Stanford University", keywords: ["硫正极", "预锂化"] },
  };
  assert.deepEqual(metadataSearchFields(metadata), { projectName: "锂硫电池项目", principal: "Yi Cui（崔屹）", institution: "Stanford University", keywords: "锂硫电池\n硫正极\n预锂化" });
  assert.deepEqual(metadataSearchFields({ sourceMeta: { keywords: null }, projectMeta: null }), {}, "legacy and non-project metadata");
  assert.deepEqual(metadataSearchFields(null), {});
  assert.ok(!metadataSearchTerms(metadata).includes("池硫"), "adjacent keywords do not form cross-keyword bigrams");
  const weights = metadataTermWeights(metadata);
  assert.equal(weights.get("崔屹"), 1);
  assert.equal(weights.get("stanford"), 0.8);
  assert.equal(weights.get("预锂"), 0.5);
  assert.equal(weights.get("锂硫"), 1, "a term in several fields takes the highest weight");
  assert.equal(metadataScore(metadata, [{ term: "崔屹", idf: 2 }, { term: "锂硫", idf: 1 }, { term: "钠离", idf: 5 }]), 3);
  assert.equal(metadataScore(null, [{ term: "崔屹", idf: 2 }]), 0);
});

test("retrieve fuses keyword and vector hits, applies the threshold and reranks", async () => {
  const keyword = [hit("a", 9), hit("b", 5)];
  const vector = [hit("b", 0.9), hit("c", 0.6), hit("d", 0.4)];
  const fused = await retrieve("钠离子电池", settings, { keywordSearch: async () => keyword, vectorSearch: async () => vector });
  assert.deepEqual(fused.chunks.map((chunk) => chunk.chunkId), ["b", "a", "c"], "a chunk found by both channels ranks first; d is below the threshold");
  assert.equal(fused.chunks[0].keywordScore, 5);
  assert.equal(fused.chunks[0].vectorScore, 0.9);

  let rerankInput: string[] = [];
  const reranked = await retrieve("钠离子电池", { ...settings, rerankEnabled: true, topK: 2 }, {
    keywordSearch: async () => keyword,
    vectorSearch: async () => vector,
    rerank: async (_query, documents, topN) => { rerankInput = documents; assert.equal(topN, 2); return [{ index: 2, score: 0.99 }, { index: 0, score: 0.5 }]; },
  });
  assert.equal(rerankInput[0], "文章：标题b\n\n正文b", "rerank sees the context prefix and content");
  assert.deepEqual(reranked.chunks.map((chunk) => [chunk.chunkId, chunk.rerankScore]), [["c", 0.99], ["b", 0.5]]);
});

test("retrieve degrades to keyword results when the vector search or rerank fails", async () => {
  const result = await retrieve("电池", { ...settings, rerankEnabled: true }, {
    keywordSearch: async () => [hit("a", 3), hit("b", 2)],
    vectorSearch: async () => { throw new Error("The embedding request failed with HTTP 500."); },
    rerank: async () => { throw new Error("The rerank request failed with HTTP 500."); },
  });
  assert.deepEqual(result.chunks.map((chunk) => chunk.chunkId), ["a", "b"]);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /HTTP 500/);

  let called = false;
  const empty = await retrieve("？！", settings, { keywordSearch: async () => { called = true; return []; } });
  assert.equal(empty.chunks.length, 0);
  assert.equal(called, false, "questions without terms skip the keyword search");
});

test("answer context groups citations by article and respects the length limit", () => {
  const chunks = [
    { ...hit("a", 0), documentId: "doc-1", title: "文章一", content: "甲".repeat(40), sectionPath: ["结论"], repostSource: "某公众号" },
    { ...hit("b", 0), documentId: "doc-2", title: "文章二", content: "乙".repeat(80) },
    { ...hit("c", 0), documentId: "doc-1", title: "文章一", content: "丙".repeat(30) },
  ];
  const context = buildAnswerContext(chunks, 100);
  assert.deepEqual(context.chunks.map((chunk) => [chunk.chunkId, chunk.citation]), [["a", 1], ["c", 1]], "chunks that do not fit are skipped");
  assert.deepEqual(context.sources, [{ documentId: "doc-1", title: "文章一", url: "https://example.test/a", repostSource: "某公众号" }]);
  assert.equal(buildAnswerContext([{ ...hit("x", 0), content: "长".repeat(300) }], 100).chunks[0].content.length, 100, "the first chunk is truncated");

  const [system, user] = buildChatMessages("", "如何提升寿命？", context);
  assert.equal(system.role, "system");
  assert.match(system.content, /\[1\]/);
  assert.match(user.content, /^参考资料：\n\n\[1\] 《文章一》 章节：结论\n甲+/);
  assert.match(user.content, /问题：如何提升寿命？$/);
  assert.doesNotMatch(system.content, /之前的对话/);

  const history = Array.from({ length: 4 }, (_, index) => ({ question: `问题${index}`, answer: `回答${index}[1][2]${index === 3 ? "长".repeat(600) : ""}` }));
  const withHistory = buildChatMessages("", "它的寿命呢？", context, history);
  assert.deepEqual(withHistory.map((message) => message.role), ["system", "user", "assistant", "user", "assistant", "user", "assistant", "user"], "only the last three turns are kept");
  assert.equal(withHistory[1].content, "问题1");
  assert.equal(withHistory[2].content, "回答1", "old citation numbers are removed");
  assert.equal(withHistory[6].content.length, 502, "long answers are truncated");
  assert.match(withHistory[0].content, /之前的对话/);
  assert.match(withHistory[7].content, /^参考资料：[\s\S]*问题：它的寿命呢？$/);
  assert.match(extractiveAnswer(context), /\[1\] 《文章一》：甲+/);
  assert.equal(extractiveAnswer({ chunks: [], sources: [] }), NO_MATCH_ANSWER);
  assert.deepEqual(retrievedChunkRecords(context)[0], { chunkId: "a", documentId: "doc-1", citation: 1, title: "文章一", sectionPath: ["结论"], excerpt: "甲".repeat(40), score: 0 });
});

test("chat model streams tokens and usage from server-sent events", async (context) => {
  let request: { url: string; body: Record<string, unknown> } | undefined;
  mockFetch(context, (url, init) => {
    request = { url, body: JSON.parse(String(init?.body)) };
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "钠离子" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: "电池[1]" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\r\n\r\ndata: [DONE]\n\n`,
    ].join("");
    // 把事件拆成跨边界的小块，覆盖缓冲逻辑。
    const bytes = new TextEncoder().encode(events);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const chunks = [];
  for await (const chunk of createChatModel(provider()).streamChat([{ role: "user", content: "问题" }])) chunks.push(chunk);
  assert.equal(request?.url, "https://models.example/v1/chat/completions");
  assert.equal(request?.body.model, "chat-model");
  assert.equal(request?.body.temperature, 0.2);
  assert.equal(request?.body.max_tokens, 256);
  assert.equal(request?.body.stream, true);
  assert.deepEqual(chunks, [{ type: "token", text: "钠离子" }, { type: "token", text: "电池[1]" }, { type: "usage", promptTokens: 12, completionTokens: 3 }]);
});

test("chat and rerank errors hide provider bodies; rerank results are validated", async (context) => {
  mockFetch(context, () => new Response("sensitive provider body test-secret", { status: 401 }));
  const consume = async () => { for await (const _chunk of createChatModel(provider()).streamChat([{ role: "user", content: "问题" }])) { /* drain */ } };
  await assert.rejects(consume(), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /chat request failed with HTTP 401/);
    assert.doesNotMatch(error.message, /sensitive|test-secret/);
    return true;
  });
  await assert.rejects(createRerankModel(provider()).rerank("q", ["a", "b"]), /rerank request failed with HTTP 401/);

  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.1 }, { index: 1, relevance_score: 0.8 }] }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await createRerankModel(provider()).rerank("q", ["a", "b"], 5), [{ index: 1, score: 0.8 }, { index: 0, score: 0.1 }]);
  assert.equal(body.top_n, 2);
  globalThis.fetch = (async () => new Response(JSON.stringify({ output: { results: [{ index: 3, relevance_score: 0.5 }] } }), { status: 200 })) as typeof fetch;
  await assert.rejects(createRerankModel(provider()).rerank("q", ["a", "b"]), /invalid results/);
});
