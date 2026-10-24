import assert from "node:assert/strict";
import { test } from "node:test";
import type { EvaluationQuestion } from "../src/evaluation.js";
import {
  compareRuns, comparisonWarnings, evidenceCoverage, failedResult, overlapBucket, percentile, RANKING_DEPTH, runVariant, summarizeVariant, variantDependencies,
  type RetrievalVariant, type RunQuestion, type RunRecord, type VariantResult,
} from "../src/evaluation-run.js";
import type { ChunkHit, RetrievalDependencies } from "../src/rag.js";

const EVIDENCE = "Li(110) 晶面拥有 0.5 MPa 的最低屈服强度。";

const hit = (chunkId: string, documentId: string, score: number, content = `正文${chunkId}`): ChunkHit => ({
  chunkId, documentId, title: `标题${documentId}`, url: `https://example.test/${documentId}`, content, context: "", sectionPath: [], contentType: "text", score,
});
const settings = { topK: 2, similarityThreshold: 0.5, rerankEnabled: false, maxContextLength: 1000 };
const question = (overrides: Partial<EvaluationQuestion> = {}): EvaluationQuestion => ({
  id: "s0001", question: "锂的 (110) 晶面屈服强度是多少？", history: [], filters: null, type: "fact", specificity: "high", source: "synthetic", split: "dev", answerable: true,
  labels: [{ articleKey: "A", relevance: 3, evidence: [EVIDENCE] }], ...overrides,
});
const articleKeyOf = (documentId: string) => documentId.replace("doc-", "");

/** 记录每路召回的调用次数，Rerank 把顺序反过来。 */
function fakeDependencies() {
  const calls = { keyword: 0, vector: 0, summary: 0, rerank: 0 };
  const dependencies: RetrievalDependencies = {
    async keywordSearch() { calls.keyword += 1; return [hit("k1", "doc-B", 9), hit("k2", "doc-A", 8, `前文。${EVIDENCE}`)]; },
    async vectorSearch() { calls.vector += 1; return [hit("v1", "doc-C", 0.9), hit("v2", "doc-B", 0.4)]; },
    async summarySearch() { calls.summary += 1; return [hit("s1", "doc-D", 0.8)]; },
    async rerank(_query, texts, topN) { calls.rerank += 1; return texts.map((_text, index) => ({ index, score: index })).reverse().slice(0, topN); },
  };
  return { calls, dependencies };
}

test("variants inject only their own recall routes and only rerank calls the reranker", async () => {
  const expected: Record<RetrievalVariant, [number, number, number, number]> = {
    keyword: [1, 0, 0, 0], vector: [0, 1, 0, 0], summary: [0, 0, 1, 0], fused: [1, 1, 1, 0], rerank: [1, 1, 1, 1],
  };
  for (const [variant, counts] of Object.entries(expected) as Array<[RetrievalVariant, [number, number, number, number]]>) {
    const { calls, dependencies } = fakeDependencies();
    await runVariant(question(), variant, settings, dependencies, articleKeyOf);
    assert.deepEqual([calls.keyword, calls.vector, calls.summary, calls.rerank], counts, variant);
  }
  assert.throws(() => variantDependencies("vector", { keywordSearch: async () => [] }), /embedding/);
  assert.throws(() => variantDependencies("rerank", { ...fakeDependencies().dependencies, rerank: undefined }), /rerank/);
});

test("a variant result ranks articles, separates the answer context and checks evidence", async () => {
  const { dependencies } = fakeDependencies();
  const keyword = await runVariant(question(), "keyword", settings, dependencies, articleKeyOf);
  assert.deepEqual(keyword.articles, ["B", "A"]);
  assert.equal(keyword.rank, 2);
  assert.deepEqual(keyword.context.map((chunk) => chunk.articleKey), ["B", "A"], "context takes the knowledge base topK");
  assert.equal(keyword.contextHit, true);
  assert.equal(keyword.evidenceHit, true);
  assert.equal(keyword.chunks[0].keywordScore, 9);

  // 向量召回低于阈值的切片被过滤，来源文章不在排名中。
  const vector = await runVariant(question(), "vector", settings, dependencies, articleKeyOf);
  assert.deepEqual(vector.articles, ["C"]);
  assert.equal(vector.rank, null);
  assert.equal(vector.contextHit, false);
  assert.equal(vector.evidenceHit, false);

  // 排名列表不受知识库 topK 限制；metadata 题不计算证据命中。
  const fused = await runVariant(question({ type: "metadata" }), "fused", { ...settings, topK: 1 }, dependencies, articleKeyOf);
  assert.ok(fused.chunks.length > 1 && fused.chunks.length <= RANKING_DEPTH);
  assert.equal(fused.context.length, 1);
  assert.equal(fused.evidenceHit, null);
});

test("context modes share one ranking and change only the assembled context", async () => {
  const { dependencies } = fakeDependencies();
  const twoPieces = question({ labels: [{ articleKey: "A", relevance: 3, evidence: [EVIDENCE, "正文s2 的结论"] }] });
  const topk = await runVariant(twoPieces, "keyword", { ...settings, topK: 1 }, dependencies, articleKeyOf);
  assert.deepEqual(topk.context.map((chunk) => chunk.articleKey), ["B"]);
  assert.equal(topk.contextChars, "正文k1".length);
  const budget = await runVariant(twoPieces, "keyword", { ...settings, topK: 1 }, dependencies, articleKeyOf, { mode: "budget" });
  assert.deepEqual(budget.context.map((chunk) => chunk.articleKey), ["B", "A"], "budget fills past topK");
  assert.deepEqual([budget.evidenceHit, budget.evidenceFull], [true, false]);

  // 父块补全了命中切片之外的第二段证据。
  const sectioned: RetrievalDependencies = { ...dependencies, async keywordSearch() { return [{ ...hit("k2", "doc-A", 8, `前文。${EVIDENCE}`), sectionId: "s-A" }]; } };
  const requested: string[][] = [];
  const section = await runVariant(twoPieces, "keyword", settings, sectioned, articleKeyOf, {
    mode: "section",
    loadSections: async (ids) => {
      requested.push(ids);
      return [{ id: "s-A", documentId: "doc-A", sectionPath: [], content: `前文。${EVIDENCE}\n正文s2 的结论。`, chunks: [{ id: "k2", content: `前文。${EVIDENCE}` }, { id: "k3", content: "正文s2 的结论。" }] }];
    },
  });
  assert.deepEqual(requested, [["s-A"]]);
  assert.deepEqual(section.context, [{ chunkId: "k2", articleKey: "A", sectionId: "s-A" }]);
  assert.deepEqual([section.evidenceHit, section.evidenceFull], [true, true]);
  assert.deepEqual(section.articles, ["A"], "the ranking is unchanged");
});

test("evidence coverage ignores whitespace, punctuation and width, and needs most bigrams", () => {
  assert.equal(evidenceCoverage(EVIDENCE, "前文 Li（110）晶面拥有0.5MPa的最低屈服强度"), 1);
  assert.ok(evidenceCoverage(EVIDENCE, "Li(110) 晶面拥有较低的屈服强度") < 0.8);
  assert.equal(evidenceCoverage("。", "任意"), 0);
});

test("percentiles, overlap buckets and variant summaries", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 0.95), 5);
  assert.deepEqual([overlapBucket(undefined), overlapBucket(0.39), overlapBucket(0.4), overlapBucket(0.6)], ["unknown", "<0.4", "0.4-0.6", ">=0.6"]);

  const result = (rank: number | null, extra: Partial<VariantResult> = {}): VariantResult => ({
    articles: Array.from({ length: 12 }, (_, index) => String(index)), chunks: [], context: [], rank, contextHit: rank === 1, evidenceHit: rank === 1, retrievalMs: 10, warnings: [], ...extra,
  });
  const entry = (id: string, fused: VariantResult | undefined, extra: Partial<RunQuestion> = {}): RunQuestion => ({
    id, question: id, type: "fact", specificity: "high", split: "dev", lexicalOverlap: 0.5, sourceArticleKeys: ["A"], results: fused ? { fused } : {}, ...extra,
  });
  const questions = [
    entry("q1", result(1)),
    entry("q2", result(4, { warnings: ["向量检索失败"], articles: ["A"] }), { specificity: "low", lexicalOverlap: 0.2 }),
    entry("q3", result(null, { evidenceHit: null }), { type: "metadata" }),
    entry("q4", failedResult("boom")),
    entry("q5", undefined, { error: "查询 Embedding 失败" }),
    entry("q6", result(1), { excluded: "来源文章 A 不在语料中" }),
  ];
  const summary = summarizeVariant(questions, "fused");
  assert.deepEqual(summary.reliability, { evaluated: 3, excluded: 1, errors: 2, degraded: 1, shallowRanking: 1 });
  assert.deepEqual(summary.overall.hitAt, { 1: 0.3333, 5: 0.6667, 10: 0.6667 });
  assert.equal(summary.overall.mrr, 0.4167);
  assert.equal(summary.overall.evidenceHit, 0.5, "metadata questions are not counted");
  assert.equal(summary.overall.evidenceQuestions, 2);
  assert.deepEqual(Object.keys(summary.groups.specificity), ["high", "low"]);
  assert.equal(summary.groups.type.metadata.questions, 1);
  assert.equal(summary.groups.overlap["<0.4"].hitAt["5"], 1);
  assert.deepEqual(summary.latency, { p50: 10, p95: 10 });
});

test("run comparison uses questions valid in both runs and lists rank moves", () => {
  const entry = (id: string, rank: number | null, extra: Partial<RunQuestion> = {}): RunQuestion => ({
    id, question: `问题${id}`, type: "fact", specificity: id === "q3" ? "low" : "high", split: "dev", sourceArticleKeys: ["A"],
    results: { fused: { articles: [], chunks: [], context: [], rank, contextHit: false, evidenceHit: null, retrievalMs: 1, warnings: [] } }, ...extra,
  });
  const run = (questions: RunQuestion[], overrides: Partial<RunRecord> = {}): RunRecord => ({
    schemaVersion: 1, name: "run", createdAt: "", variants: ["fused"], summary: {}, embedding: { p50: null, p95: null, failures: 0 },
    dataset: { name: "ds", version: "v1", path: "", split: "dev", questions: questions.length, corpusFingerprint: null },
    corpus: { documents: 1, fingerprint: "sha256:a", parserVersions: {}, chunkerVersion: null, embeddingModel: null, embeddingCoverage: 1 },
    corpusChanged: false, incomplete: false, settings: { knowledgeBase: null, retrieval: settings, rankingDepth: RANKING_DEPTH }, models: { embedding: null, rerank: null },
    questions, ...overrides,
  });
  const a = run([entry("q1", 12), entry("q2", 3), entry("q3", 1), entry("q4", 2), entry("q5", 1)]);
  const b = run([entry("q1", 4), entry("q2", null), entry("q3", 1), entry("q4", 1, { excluded: "证据已不在来源文章 A 中" }), entry("q6", 1)]);
  const comparison = compareRuns(a, b, "fused");
  assert.equal(comparison.questions, 3, "q4 is excluded in B, q5 and q6 exist in one run only");
  assert.deepEqual(comparison.ranks, { improved: 1, worsened: 1, unchanged: 1 });
  assert.deepEqual(comparison.moves.enteredTop5.map((move) => [move.id, move.from, move.to]), [["q1", 12, 4]]);
  assert.deepEqual(comparison.moves.enteredTop10.map((move) => move.id), ["q1"]);
  assert.deepEqual(comparison.moves.leftTop10.map((move) => [move.id, move.from, move.to]), [["q2", 3, null]]);
  assert.equal(comparison.delta.hitAt["10"], 0);
  assert.equal(comparison.delta.hitAt["5"], 0);
  assert.equal(comparison.groups.specificity.low.delta.mrr, 0);
  assert.equal(comparison.groups.specificity.high.a.questions, 2);

  assert.deepEqual(comparisonWarnings(a, b), []);
  assert.equal(comparisonWarnings(a, run([], { corpus: { ...a.corpus, fingerprint: "sha256:b" } })).length, 1);
  assert.throws(() => comparisonWarnings(a, run([], { dataset: { ...a.dataset, version: "v2" } })), /Datasets differ/);
  assert.throws(() => comparisonWarnings(a, run([], { dataset: { ...a.dataset, split: "test" } })), /Splits differ/);
});
