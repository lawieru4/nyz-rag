import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adjudicationMessages, adjudicationTargets, lenientMetrics, lenientRank, parseAdjudication, summarizeLenient, type AdjudicationTable,
} from "../src/evaluation-adjudication.js";
import { failedResult, type RunQuestion, type VariantResult } from "../src/evaluation-run.js";
import type { CorpusArticle } from "../src/synthetic-questions.js";

const result = (articles: string[], source = "S"): VariantResult => {
  const index = articles.indexOf(source);
  return { articles, chunks: [], context: [], rank: index >= 0 ? index + 1 : null, contextHit: false, evidenceHit: null, retrievalMs: 1, warnings: [] };
};

const question = (id: string, rerank: VariantResult, overrides: Partial<RunQuestion> = {}): RunQuestion => ({
  id, question: `问题${id}`, type: "fact", specificity: "low", split: "dev", lexicalOverlap: 0.3, sourceArticleKeys: ["S"], results: { rerank }, ...overrides,
});

const article: CorpusArticle = {
  articleKey: "A", title: "表面包覆提升循环稳定性", category: "科研", contentHash: "h", metadata: null,
  content: "经过 1000 次循环后，包覆样品的容量保持率为 92%，未包覆样品仅为 75%。",
};

test("only articles ranked before the source, within the top 10, are adjudicated", () => {
  const keys = Array.from({ length: 12 }, (_, index) => `A${index + 1}`);
  assert.deepEqual(adjudicationTargets(result(["S", "A1"])), []);
  assert.deepEqual(adjudicationTargets(result(["A1", "A2", "S"])), ["A1", "A2"]);
  assert.deepEqual(adjudicationTargets(result(keys)), keys.slice(0, 10), "source missing: top 10");
  assert.deepEqual(adjudicationTargets(result([...keys, "S"])), keys.slice(0, 10), "source beyond 10: capped");
});

test("the lenient rank is the first answerable article, counting only verified yes verdicts", () => {
  const ranked = result(["A1", "A2", "A3", "S"]);
  assert.equal(lenientRank(ranked, {}), 4);
  assert.equal(lenientRank(ranked, { A1: { verdict: "partial", verified: true }, A2: { verdict: "yes", verified: false }, A3: { verdict: "yes", verified: true } }), 3);
  assert.equal(lenientRank(result(["A1", "A2"]), { A2: { verdict: "yes", verified: true } }), 2);
  assert.equal(lenientRank(result(["A1", "A2"]), {}), null);
});

test("lenient metrics sit beside the strict ones and count rescued and unjudged questions", () => {
  const table: AdjudicationTable = { q2: { A1: { verdict: "yes", verified: true } }, q3: { A1: { verdict: "no", verified: false } } };
  const pairs: Array<[RunQuestion, VariantResult]> = [
    [question("q1", result(["S"])), result(["S"])],
    [question("q2", result(["A1", "S"])), result(["A1", "S"])],
    // A2 尚未复判。
    [question("q3", result(["A1", "A2"])), result(["A1", "A2"])],
  ];
  const metrics = lenientMetrics(pairs, table);
  assert.deepEqual(metrics.strictHitAt, { 1: 0.3333, 5: 0.6667, 10: 0.6667 });
  assert.deepEqual(metrics.hitAt, { 1: 0.6667, 5: 0.6667, 10: 0.6667 });
  assert.equal(metrics.strictMrr, 0.5);
  assert.equal(metrics.mrr, 0.6667);
  assert.equal(metrics.rescued, 1);
  assert.equal(metrics.unjudged, 1);
});

test("lenient summaries use the same evaluated questions as strict metrics and group them", () => {
  const questions = [
    question("q1", result(["A1", "S"])),
    question("q2", result(["S"]), { specificity: "high" }),
    question("q3", result(["A1"]), { excluded: "来源文章不在语料中" }),
    question("q4", failedResult("rerank failed")),
  ];
  const summary = summarizeLenient(questions, "rerank", { q1: { A1: { verdict: "yes", verified: true } } });
  assert.equal(summary.overall.questions, 2);
  assert.equal(summary.overall.hitAt["1"], 1);
  assert.equal(summary.groups.specificity.low.rescued, 1);
  assert.equal(summary.groups.specificity.high.rescued, 0);
});

test("the adjudication prompt shows only the question and the candidate article", () => {
  const [system, user] = adjudicationMessages("包覆后容量保持率能提高多少？", article);
  assert.match(system.content, /yes/);
  for (const text of ["问题：包覆后容量保持率能提高多少？", "标题：表面包覆提升循环稳定性", article.content]) assert.ok(user.content.includes(text), text);
  assert.doesNotMatch(user.content, /参考答案|证据：/);
});

test("adjudication evidence is verified like evidence hits: any segment covered after normalization", () => {
  const parsed = parseAdjudication({ analysis: " 分析 ", verdict: "YES", answer: "从 75% 提高到 92%", evidence: ["包覆样品的容量保持率为92%", 1, " "] }, article);
  assert.deepEqual(parsed, { verdict: "yes", answer: "从 75% 提高到 92%", evidence: ["包覆样品的容量保持率为92%"], verified: true, analysis: "分析" });
  assert.equal(parseAdjudication({ verdict: "yes", evidence: ["掺杂后的倍率性能提升了一倍", "包覆样品的容量保持率为92%"] }, article).verified, true, "one covered segment is enough");
  assert.equal(parseAdjudication({ verdict: "yes", evidence: ["1. 经过\"1000\"次循环后，包覆样品的容量保持率为 92%"] }, article).verified, true, "list markers and quote styles are ignored");
  assert.equal(parseAdjudication({ verdict: "yes", evidence: ["掺杂后的倍率性能提升了一倍"] }, article).verified, false, "made-up evidence");
  assert.equal(parseAdjudication({ verdict: "yes", evidence: ["表面包覆提升循环稳定性"] }, article).verified, true, "titles count as article text");
  assert.equal(parseAdjudication({ verdict: "yes", evidence: [] }, article).verified, false);
  assert.throws(() => parseAdjudication({ verdict: "maybe" }, article), /verdict/);
});
