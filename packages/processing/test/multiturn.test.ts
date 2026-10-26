import assert from "node:assert/strict";
import { test } from "node:test";
import { AdmissionError } from "../src/admission.js";
import { validateEvaluationDataset, type EvaluationDataset, type EvaluationQuestion } from "../src/evaluation.js";
import { judgeQuestion, summarizeAnswers, type AnswerItem } from "../src/evaluation-answer.js";
import { concatQuery, evaluationQuery, standaloneTermRecall } from "../src/evaluation-rewrite.js";
import { compareRuns, summarizeRewrite, summarizeVariant, turnGroup, type RunQuestion, type RunRecord, type VariantResult } from "../src/evaluation-run.js";
import {
  checkFollowup, followupMessages, followupQuestion, followupReviewMessages, parseFollowup, parseFollowupReview, topicSwitchQuestions, type ApprovedFollowup, type GeneratedFollowup,
} from "../src/multiturn-questions.js";
import type { CorpusArticle } from "../src/synthetic-questions.js";

const EVIDENCE = "磷酸锰铁锂电池在 1C 下循环 2000 次后容量保持率为 92.5%。";
const base = (id: string, articleKey: string, question = "磷酸锰铁锂电池循环 2000 次后的容量保持率是多少？"): EvaluationQuestion => ({
  id, question, answer: "容量保持率为 92.5%。", history: [], filters: null, type: "fact", specificity: "high", source: "synthetic", split: "dev", answerable: true,
  labels: [{ articleKey, relevance: 3, evidence: [EVIDENCE] }],
});
const article: CorpusArticle = { articleKey: "101", title: "磷酸锰铁锂电池研究", category: "科研", content: `磷酸锰铁锂是一种正极材料。${EVIDENCE}`, metadata: null, contentHash: "h" };
const good: GeneratedFollowup = {
  entity: "磷酸锰铁锂电池",
  opening: "介绍一下磷酸锰铁锂电池",
  openingAnswer: "磷酸锰铁锂电池以磷酸锰铁锂为正极，能量密度高于磷酸铁锂电池，研究者测试了它的倍率与循环性能。",
  followup: "它循环 2000 次后的容量保持率是多少？",
};

test("followup checks require the entity in the first turn and its omission from the follow-up", () => {
  assert.deepEqual(checkFollowup(good, base("s1", "101")), []);
  const failures = (overrides: Partial<GeneratedFollowup>) => checkFollowup({ ...good, ...overrides }, base("s1", "101")).map((failure) => failure.split("：")[0]);
  assert.deepEqual(failures({ entity: "钠电池" }), ["对象不在原问题中", "第一轮缺少对象", "第一轮回答缺少对象"]);
  assert.deepEqual(failures({ followup: "磷酸锰铁锂电池循环 2000 次后呢？" }), ["追问含对象"]);
  assert.deepEqual(failures({ followup: "磷酸锰铁锂循环 2000 次后呢？" }), ["追问含对象"], "near-identical names are caught by term overlap");
  assert.deepEqual(failures({ openingAnswer: `${good.openingAnswer}循环后保持率达 92.5%。` }), ["提前作答"]);
  assert.deepEqual(failures({ opening: "本文介绍的磷酸锰铁锂电池是什么" }), ["第一轮指代"]);
  assert.deepEqual(failures({ followup: base("s1", "101").question }), ["追问未改写", "追问含对象"]);
});

test("followup prompts carry the original question, and the review needs no article body", () => {
  const generation = followupMessages(article, base("s1", "101"), ["追问含对象：…"]);
  assert.match(generation[1].content, /原问题：磷酸锰铁锂电池循环/);
  assert.match(generation[1].content, /上一次生成的对话未通过检查/);
  assert.match(generation[1].content, /正文（节选）/);
  const review = followupReviewMessages(base("s1", "101"), good);
  assert.match(review[1].content, /第二轮追问：它循环 2000 次后/);
  assert.doesNotMatch(review[1].content, /正文/);
  assert.deepEqual(parseFollowup({ entity: " A ", opening: "B", openingAnswer: 1, followup: "C" }), { entity: "A", opening: "B", openingAnswer: "", followup: "C" });
  const parsed = parseFollowupReview({ analysis: "ok", scores: { dependent: 5, resolvable: 4, equivalent: 4, natural: 4 }, reason: "" });
  assert.equal(parsed.passed, true);
  assert.equal(parseFollowupReview({ scores: { dependent: 5, resolvable: 4, equivalent: 3, natural: 5 } }).passed, false);
  assert.equal(parseFollowupReview({ scores: { dependent: 5, resolvable: 4, equivalent: 4.5, natural: 5 } }).passed, false, "non-integer scores fail");
});

test("frozen followups and topic switches inherit labels, pair different articles, and validate", () => {
  const approved: ApprovedFollowup[] = [base("s1", "101"), base("s2", "102", "钠离子电池硬碳负极的首效是多少？"), base("s3", "103", "固态电解质的离子电导率是多少？")]
    .map((question) => ({ base: question, generated: { ...good, opening: `介绍一下${question.id}`, openingAnswer: `第一轮回答${question.id}，介绍对象的背景与研究方向。` } }));
  const followups = approved.map(followupQuestion);
  assert.deepEqual(followups[0], {
    id: "s1-f", question: good.followup, answer: "容量保持率为 92.5%。", history: [{ question: "介绍一下s1", answer: approved[0].generated.openingAnswer }], standalone: approved[0].base.question,
    filters: null, type: "followup", specificity: "high", source: "synthetic", split: "dev", answerable: true, notes: "followup derived from s1; entity: 磷酸锰铁锂电池", labels: approved[0].base.labels,
  });
  const switches = topicSwitchQuestions(approved, 7);
  assert.equal(switches.length, 3);
  for (const item of switches) {
    const own = item.id.replace("-x", "");
    assert.equal(item.question, approved.find((entry) => entry.base.id === own)!.base.question, "the current question stays standalone");
    assert.equal(item.type, "fact");
    assert.doesNotMatch(item.history[0].question, new RegExp(own), "history comes from another article");
  }
  assert.deepEqual(topicSwitchQuestions(approved.slice(0, 1), 7), [], "no other article to pair with");
  const dataset: EvaluationDataset = {
    schemaVersion: 2, name: "multiturn", version: "t", provenance: "Synthetic multi-turn; not real user dialogues and not human validated.", questions: [...followups, ...switches],
  };
  assert.deepEqual(validateEvaluationDataset(dataset), []);
  assert.deepEqual(validateEvaluationDataset({ ...dataset, questions: [{ ...followups[0], standalone: " " }] }), ["s1-f: standalone must be a non-empty string"]);
});

test("evaluation queries follow the rewrite mode only for questions with history", async () => {
  const followup = { ...base("s1-f", "101", "那循环寿命呢？"), history: [{ question: "介绍一下磷酸锰铁锂", answer: "…" }], standalone: "磷酸锰铁锂的循环寿命如何？" };
  const rewrite = async () => ({ query: "磷酸锰铁锂电池的循环寿命如何？", promptTokens: 10, completionTokens: 3 });
  assert.deepEqual(await evaluationQuery(base("s1", "101"), "llm", async () => assert.fail("single-turn questions are never rewritten")), { query: base("s1", "101").question });
  assert.deepEqual(await evaluationQuery(followup, "none"), { query: "那循环寿命呢？" });
  assert.equal((await evaluationQuery(followup, "concat")).query, "介绍一下磷酸锰铁锂 那循环寿命呢？");
  assert.equal(concatQuery("q", Array.from({ length: 5 }, (_, index) => ({ question: `h${index}`, answer: "" }))), "h2 h3 h4 q", "only the last three turns");
  assert.deepEqual(await evaluationQuery(followup, "standalone"), { query: "磷酸锰铁锂的循环寿命如何？" });
  await assert.rejects(evaluationQuery({ ...followup, standalone: undefined }, "standalone"), /standalone/);
  const llm = await evaluationQuery(followup, "llm", rewrite);
  assert.equal(llm.query, "磷酸锰铁锂电池的循环寿命如何？");
  assert.equal(typeof llm.ms, "number");
  assert.deepEqual([llm.promptTokens, llm.completionTokens, llm.failed], [10, 3, undefined]);
  const unusable = await evaluationQuery(followup, "llm", async () => ({ query: null }));
  assert.deepEqual([unusable.query, unusable.failed], ["那循环寿命呢？", "改写输出不合格"]);
  const failed = await evaluationQuery(followup, "llm", async () => { throw new Error("timeout"); });
  assert.deepEqual([failed.query, failed.failed], ["那循环寿命呢？", "改写失败：timeout"]);
  // 与问答一致：限流整次报错（由 CLI 重试），而不是退回当前问题。
  await assert.rejects(evaluationQuery(followup, "llm", async () => { throw new AdmissionError(429, 1, "busy"); }), AdmissionError);
  assert.equal(standaloneTermRecall("磷酸锰铁锂", "磷酸锰铁锂的循环寿命"), 1);
  assert.equal(standaloneTermRecall("磷酸锰铁锂", "那循环寿命呢"), 0);
  assert.equal(standaloneTermRecall("？", "x"), null);
});

const result = (rank: number | null): VariantResult => ({ articles: [], chunks: [], context: [], rank, contextHit: rank !== null, evidenceHit: null, retrievalMs: 1, warnings: [] });
const runQuestion = (id: string, overrides: Partial<RunQuestion>, rank: number | null): RunQuestion => ({
  id, question: id, type: "fact", split: "dev", sourceArticleKeys: ["A"], results: { fused: result(rank) }, ...overrides,
});

test("run summaries group by dialogue turn and aggregate rewrite statistics", () => {
  const questions = [
    runQuestion("s1", {}, 1),
    runQuestion("s1-f", { type: "followup", historyTurns: 1, rewrite: { query: "q", ms: 100, promptTokens: 50, completionTokens: 5, standaloneRecall: 0.5 } }, 3),
    runQuestion("s2-f", { type: "followup", historyTurns: 1, rewrite: { query: "q", ms: 300, failed: "改写输出不合格", standaloneRecall: 1 } }, null),
    runQuestion("s1-x", { historyTurns: 1, rewrite: { query: "q", ms: 200, standaloneRecall: 1 } }, 2),
  ];
  assert.deepEqual(questions.map(turnGroup), ["single", "followup", "followup", "with-history"]);
  const groups = summarizeVariant(questions, "fused").groups.turn;
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([key, metrics]) => [key, [metrics.questions, metrics.mrr]])), {
    followup: [2, 0.1667], single: [1, 1], "with-history": [1, 0.5],
  });
  assert.deepEqual(summarizeRewrite(questions, "llm"), {
    mode: "llm", questions: 3, failures: 1, latency: { p50: 200, p95: 300 }, standaloneRecall: { followup: 0.75, "with-history": 1 }, usage: { promptTokens: 50, completionTokens: 5 },
  });
  const record = (ranks: Array<number | null>) => ({ questions: questions.map((question, index) => ({ ...question, results: { fused: result(ranks[index]) } })) }) as unknown as RunRecord;
  const comparison = compareRuns(record([1, null, null, 2]), record([1, 3, 1, 2]), "fused");
  assert.deepEqual(Object.keys(comparison.groups.turn), ["followup", "single", "with-history"]);
  assert.equal(comparison.groups.turn.followup.delta.hitAt["5"], 1);
});

test("answer evaluation shows the judge the dialogue and reports rewrite cost", () => {
  assert.equal(judgeQuestion(base("s1", "101")), base("s1", "101").question);
  const followup = { question: "那循环寿命呢？", history: [{ question: "介绍一下磷酸锰铁锂", answer: "…" }], standalone: "磷酸锰铁锂的循环寿命如何？" };
  assert.equal(judgeQuestion(followup), "那循环寿命呢？\n（多轮对话中的追问。此前用户依次问过：「介绍一下磷酸锰铁锂」；补全指代后的问题：磷酸锰铁锂的循环寿命如何？）");
  const item = (id: string, rewrite?: AnswerItem["rewrite"]): AnswerItem => ({
    id, question: id, type: "followup", split: "dev", sourceArticleKeys: ["A"], at: "", ...(rewrite ? { historyTurns: 1, rewrite } : {}), answer: "a", answerMode: "generated",
    retrieval: { rank: 1, contextHit: true, evidenceHit: null, evidenceFull: null, contextChars: 10, context: [], references: "", retrievalMs: 5, warnings: [] },
  });
  const summary = summarizeAnswers([item("a"), item("b", { query: "q", ms: 120, promptTokens: 40, completionTokens: 4 }), item("c", { query: "q", ms: 80, failed: "改写失败：x" })]);
  assert.deepEqual(summary.rewrite, { questions: 2, failures: 1, ms: { p50: 80, p95: 120 } });
  assert.deepEqual(summary.usage.rewrite, { promptTokens: 40, completionTokens: 4 });
  assert.deepEqual(Object.keys(summary.groups.turn), ["followup", "single"]);
});
