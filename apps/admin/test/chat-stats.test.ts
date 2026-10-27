import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatStatsSummary } from "@nyz-rag/types";
import { duration, fallbackBreakdown, percent } from "../src/views/chat-stats.ts";

const summary: ChatStatsSummary = {
  questions: 20, extractive: 6, fallbacks: { no_chat_model: 0, no_context: 1, model_error: 3, citation_rejected: 0, empty_answer: 0 }, negative: 2,
  totalMsP50: 850, totalMsP95: 4200, firstTokenMsP50: null, firstTokenMsP95: null, promptTokens: 100, completionTokens: 40, rewritePromptTokens: 5, rewriteCompletionTokens: 1,
};

test("fallback breakdown lists recorded reasons and early unrecorded ones by count", () => {
  assert.deepEqual(fallbackBreakdown(summary), [
    { label: "模型调用失败", count: 3, share: "50.0%" },
    { label: "未记录原因（早期问答）", count: 2, share: "33.3%" },
    { label: "没有召回片段", count: 1, share: "16.7%" },
  ]);
  assert.deepEqual(fallbackBreakdown({ ...summary, extractive: 0, fallbacks: { ...summary.fallbacks, no_context: 0, model_error: 0 } }), []);
});

test("rates and durations have placeholders for empty data", () => {
  assert.equal(percent(6, 20), "30.0%");
  assert.equal(percent(0, 0), "—");
  assert.equal(duration(850), "850 ms");
  assert.equal(duration(4200), "4.2 s");
  assert.equal(duration(null), "—");
});
