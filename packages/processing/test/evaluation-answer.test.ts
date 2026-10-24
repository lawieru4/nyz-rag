import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerMetrics, citationStats, citedNumbers, compareAnswerRuns, judgeMessages, parseJudgement, summarizeAnswers, type AnswerItem, type Judgement,
} from "../src/evaluation-answer.js";
import { runVariant, runVariantWithContext } from "../src/evaluation-run.js";
import { buildAnswerContext, buildChatMessages, referenceText, type ChunkHit, type RetrievalDependencies } from "../src/rag.js";

const judgement = (faithful: number | null, complete: number | null, citation: number | null = 5, refused = false): Judgement => ({
  scores: { faithful, complete, citation }, refused, analysis: "", unsupported: [], missing: [],
});

const item = (id: string, overrides: Partial<AnswerItem> = {}): AnswerItem => ({
  id, question: `问题${id}`, type: "fact", specificity: "high", split: "dev", lexicalOverlap: 0.5, sourceArticleKeys: ["A"], at: "2026-10-24T00:00:00.000Z",
  retrieval: { rank: 1, contextHit: true, evidenceHit: true, evidenceFull: true, contextChars: 100, context: [], references: "", retrievalMs: 10, warnings: [] },
  answerMode: "generated", answer: "回答 [1]",
  citations: { cited: [1], invalid: [], sourceCitation: 1, sourceCited: true },
  generation: { model: "chat", firstTokenMs: 100, totalMs: 1000, promptTokens: 3000, completionTokens: 200 },
  judgement: judgement(5, 5), judgeUsage: { promptTokens: 4000, completionTokens: 300 },
  ...overrides,
});

test("citations are parsed in the bracket forms models write and checked against the context", () => {
  assert.deepEqual(citedNumbers("结论一[2][1]。结论二 [1, 3]，另见[4、2]；数组 a[i] 与 [x] 不算。"), [1, 2, 3, 4]);
  const sources = [{ articleKey: "B" }, { articleKey: "A" }];
  assert.deepEqual(citationStats("见 [2]。", sources, ["A"]), { cited: [2], invalid: [], sourceCitation: 2, sourceCited: true });
  assert.deepEqual(citationStats("见 [1][3]。", sources, ["A"]), { cited: [1, 3], invalid: [3], sourceCitation: 2, sourceCited: false });
  assert.deepEqual(citationStats("见 [1]。", sources, ["C"]), { cited: [1], invalid: [], sourceCitation: null, sourceCited: false });
});

test("the judge sees the same references as the chat model and never the run settings", () => {
  const hit = (chunkId: string, documentId: string, content: string): ChunkHit => ({
    chunkId, documentId, title: `标题${documentId}`, url: "", content, context: "", sectionPath: ["结果"], contentType: "text", score: 1,
  });
  const context = buildAnswerContext([{ ...hit("c1", "d1", "第一段"), score: 1 }, { ...hit("c2", "d2", "第二段"), score: 0.5 }], 1000);
  const references = referenceText(context);
  assert.match(references, /^\[1\] 《标题d1》 章节：结果\n第一段\n\n\[2\] 《标题d2》/);
  assert.ok(buildChatMessages("", "问题？", context).at(-1)!.content.includes(references), "chat prompt embeds the same reference text");
  const messages = judgeMessages({ question: "问题？", referenceAnswer: "参考答案", evidence: ["证据一"], references, answer: "回答 [1]" });
  assert.equal(messages.length, 2);
  for (const text of ["问题：问题？", "参考答案：参考答案", "1. 证据一", references, "回答 [1]"]) assert.ok(messages[1].content.includes(text), text);
  assert.doesNotMatch(messages[1].content, /topK|budget|上下文组装/);
});

test("judgements keep valid 1-5 integer scores and reject outputs without any score", () => {
  const parsed = parseJudgement({ analysis: " 分析 ", scores: { faithful: 5, complete: 3.5, citation: "4" }, refused: true, unsupported: ["说法", 1, " "], missing: "x" });
  assert.deepEqual(parsed, { scores: { faithful: 5, complete: null, citation: null }, refused: true, analysis: "分析", unsupported: ["说法"], missing: [] });
  assert.throws(() => parseJudgement({ scores: { faithful: 0 } }), /得分/);
  assert.throws(() => parseJudgement({}), /得分/);
});

test("metrics count only answered questions and separate citation rates by whether the source was in context", () => {
  const items = [
    item("s1"),
    // 来源文章不在上下文中，回答引用了其他文章；忠实但不完整。
    item("s2", {
      specificity: "low", retrieval: { ...item("s2").retrieval!, rank: null, contextHit: false, evidenceHit: false },
      citations: { cited: [1], invalid: [], sourceCitation: null, sourceCited: false }, judgement: judgement(5, 1, 4, true),
    }),
    // 来源文章在上下文中但没被引用，还有无效编号；分数缺失计为未通过。
    item("s3", { citations: { cited: [1, 9], invalid: [9], sourceCitation: 2, sourceCited: false }, judgement: judgement(3, null) }),
    item("s4", { excluded: "来源文章 A 不在语料中", retrieval: undefined, answer: undefined, generation: undefined, judgement: undefined, judgeUsage: undefined }),
    item("s5", { error: { stage: "judge", message: "超时" }, judgement: undefined }),
  ];
  const metrics = answerMetrics(items);
  assert.equal(metrics.questions, 3);
  assert.equal(metrics.contextHit, 0.6667);
  assert.equal(metrics.sourceCited, 0.3333);
  assert.equal(metrics.sourceCitedInContext, 0.5);
  assert.equal(metrics.invalidCitation, 0.3333);
  assert.equal(metrics.judged, 3);
  assert.deepEqual(metrics.scores, { faithful: 4.33, complete: 3, citation: 4.67 });
  assert.deepEqual(metrics.pass, { faithful: 0.6667, complete: 0.3333, citation: 1 });
  assert.equal(metrics.refused, 0.3333);

  const summary = summarizeAnswers(items);
  assert.deepEqual(summary.reliability, { total: 5, excluded: 1, errors: 1, noContext: 0, degraded: 0 });
  assert.deepEqual(Object.keys(summary.groups.specificity), ["high", "low"]);
  assert.equal(summary.groups.specificity.low.pass.complete, 0);
  assert.equal(summary.generation.promptTokens, 3000);
  // 失败题的用量仍计入合计（已经产生费用）。
  assert.deepEqual(summary.usage.judge, { promptTokens: 16000, completionTokens: 1200 });

  const noContext = summarizeAnswers([item("s6", { answerMode: "no-context", generation: undefined, citations: undefined, judgement: undefined, judgeUsage: undefined })]);
  assert.equal(noContext.reliability.noContext, 1);
  assert.equal(noContext.overall.judged, 0);
  assert.equal(noContext.overall.pass.faithful, null);
});

test("comparisons pair questions judged in both runs and list pass/fail changes", () => {
  const a = [item("s1"), item("s2", { judgement: judgement(3, 5) }), item("s3"), item("s4", { error: { stage: "generation", message: "x" } })];
  const b = [
    item("s1", { judgement: judgement(5, 2), citations: { cited: [2], invalid: [], sourceCitation: 1, sourceCited: false } }),
    item("s2"),
    item("s3", { error: { stage: "judge", message: "x" } }),
    item("s4"),
  ];
  const comparison = compareAnswerRuns(a, b);
  assert.equal(comparison.questions, 2);
  assert.deepEqual(comparison.changes.faithful.gained.map((change) => [change.id, change.from, change.to]), [["s2", 3, 5]]);
  assert.deepEqual(comparison.changes.complete.lost.map((change) => [change.id, change.from, change.to]), [["s1", 5, 2]]);
  assert.deepEqual(comparison.sourceCited.lost.map((change) => change.id), ["s1"]);
  assert.equal(comparison.a.overall.pass.faithful, 0.5);
  assert.equal(comparison.b.overall.pass.faithful, 1);
});

test("runVariantWithContext returns the assembled context behind the recorded ids", async () => {
  const hit = (chunkId: string, documentId: string): ChunkHit => ({
    chunkId, documentId, title: documentId, url: "", content: `正文${chunkId}`, context: "", sectionPath: [], contentType: "text", score: 1,
  });
  const dependencies: RetrievalDependencies = { keywordSearch: async () => [hit("k1", "doc-B"), hit("k2", "doc-A")] };
  const question = { question: "问题", type: "fact" as const, labels: [{ articleKey: "A", relevance: 3 as const, evidence: ["正文k2"] }] };
  const settings = { topK: 1, similarityThreshold: 0.5, rerankEnabled: false, maxContextLength: 1000 };
  const articleKeyOf = (id: string) => id.replace("doc-", "");
  const { result, context } = await runVariantWithContext(question, "keyword", settings, dependencies, articleKeyOf, { mode: "budget" });
  assert.deepEqual(context.chunks.map((chunk) => chunk.chunkId), result.context.map((chunk) => chunk.chunkId));
  assert.deepEqual(result, await runVariant(question, "keyword", settings, dependencies, articleKeyOf, { mode: "budget" }).then((value) => ({ ...value, retrievalMs: result.retrievalMs })));
});
