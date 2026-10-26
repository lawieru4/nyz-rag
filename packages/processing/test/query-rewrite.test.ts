import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatChunk, ChatMessage, ChatModel } from "../src/models.js";
import type { ModelSelection } from "../src/provider.js";
import { buildRewriteMessages, parseRewrite, REWRITE_MAX_TOKENS, rewriteModelSelection, rewriteQuestion } from "../src/query-rewrite.js";

const history = [
  { question: "介绍一种新型正极材料", answer: "磷酸锰铁锂（LMFP）是一种正极材料 [1]，能量密度高于磷酸铁锂 [2]。", sourceTitles: ["磷酸锰铁锂研究进展", "正极材料综述"] },
];

function model(output: string[], seen?: { messages?: ChatMessage[]; signal?: AbortSignal }): ChatModel {
  return {
    model: "mock",
    async *streamChat(messages, options) {
      if (seen) Object.assign(seen, { messages, signal: options?.signal });
      for (const text of output) yield { type: "token", text } satisfies ChatChunk;
      yield { type: "usage", promptTokens: 120, completionTokens: 12 };
    },
  };
}

test("rewrite prompt puts history and the latest question in one user message, without old citation numbers", () => {
  const messages = buildRewriteMessages("它的循环寿命怎么样？", history);
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  assert.match(messages[0].content, /原样输出最新问题/);
  const user = messages[1].content;
  assert.match(user, /用户：介绍一种新型正极材料/);
  assert.match(user, /助手：磷酸锰铁锂（LMFP）是一种正极材料，能量密度高于磷酸铁锂。/);
  assert.match(user, /参考文章：《磷酸锰铁锂研究进展》、《正极材料综述》/);
  assert.ok(user.endsWith("最新问题：它的循环寿命怎么样？"));
  assert.doesNotMatch(user, /\[\d\]/);
});

test("rewrite prompt keeps only the last turns and truncates long answers", () => {
  const turns = Array.from({ length: 5 }, (_, index) => ({ question: `问题${index}`, answer: "长".repeat(600) }));
  const user = buildRewriteMessages("继续", turns)[1].content;
  assert.doesNotMatch(user, /问题0|问题1/);
  assert.match(user, /第 1 轮\n用户：问题2/);
  assert.match(user, /长{500}……/);
  assert.doesNotMatch(user, /长{501}/);
});

test("parseRewrite strips think blocks, prefixes and quotes, and rejects unusable output", () => {
  assert.equal(parseRewrite("  磷酸锰铁锂的循环寿命如何？ ", "它呢？"), "磷酸锰铁锂的循环寿命如何？");
  assert.equal(parseRewrite("<think>先找指代</think>\n改写后的问题：「磷酸锰铁锂的循环寿命如何？」", "它呢？"), "磷酸锰铁锂的循环寿命如何？");
  assert.equal(parseRewrite("“LiFePO4 的压实密度”", "它呢？"), "LiFePO4 的压实密度");
  assert.equal(parseRewrite("", "它呢？"), null);
  assert.equal(parseRewrite("<think>x</think>", "它呢？"), null);
  assert.equal(parseRewrite("第一行\n第二行", "它呢？"), null, "multi-line output is an answer, not a query");
  assert.equal(parseRewrite("长".repeat(204), "它呢？"), null);
  assert.equal(parseRewrite("长".repeat(203), "它呢？"), "长".repeat(203));
  assert.equal(parseRewrite("原样输出最新问题，因为无法确定“它”指代的对象。", "它由哪两种物相构成？"), null, "explaining the task is not a query");
  assert.equal(parseRewrite("该问题无需改写", "它呢？"), null);
  assert.equal(parseRewrite("为什么无法确定富锂正极的氧释放温度？", "那为什么无法确定？"), "为什么无法确定富锂正极的氧释放温度？");
});

test("rewriteQuestion collects the stream and usage, passes a signal, and skips the call without history", async () => {
  const seen: { messages?: ChatMessage[]; signal?: AbortSignal } = {};
  assert.deepEqual(await rewriteQuestion(model(["磷酸锰铁锂", "的循环寿命如何？"], seen), "它的循环寿命怎么样？", history), { query: "磷酸锰铁锂的循环寿命如何？", promptTokens: 120, completionTokens: 12 });
  assert.ok(seen.signal, "a timeout signal is always applied");
  assert.equal(seen.messages?.length, 2);

  const controller = new AbortController();
  controller.abort();
  await rewriteQuestion(model(["x"], seen), "q", history, controller.signal);
  assert.ok(seen.signal?.aborted, "caller abort is combined with the timeout");

  const unused: ChatModel = { model: "mock", streamChat: () => assert.fail("no history, no rewrite call") };
  assert.deepEqual(await rewriteQuestion(unused, "独立问题", []), { query: "独立问题" });
  assert.deepEqual(await rewriteQuestion(model(["一\n二"]), "它呢？", history), { query: null, promptTokens: 120, completionTokens: 12 }, "usage is kept for unusable output");
});

test("the rewrite model setting wins; otherwise the chat model is used at temperature 0 with a short output cap", () => {
  const provider = { id: "p1", name: "Local", provider: "compatible", baseUrl: "http://127.0.0.1:8000/v1", credentialEnv: "", hasApiKey: false, enabled: true, createdAt: "", updatedAt: "" };
  const chat: ModelSelection = { provider, model: "chat-model", temperature: 0.7, maxTokens: 2048 };
  const rewrite: ModelSelection = { provider, model: "rewrite-model", temperature: 0.2, maxTokens: 512 };
  assert.deepEqual(rewriteModelSelection({ chat, rewrite }), rewrite);
  assert.deepEqual(rewriteModelSelection({ chat, rewrite: null }), { ...chat, temperature: 0, maxTokens: REWRITE_MAX_TOKENS });
  // A rewrite model whose credential is unavailable counts as unset.
  const unusable = { ...rewrite, provider: { ...provider, credentialEnv: "NYZ_TEST_UNLISTED_KEY" } };
  assert.equal(rewriteModelSelection({ chat, rewrite: unusable })?.model, "chat-model");
  assert.equal(rewriteModelSelection({ chat: null, rewrite: null }), null);
});
