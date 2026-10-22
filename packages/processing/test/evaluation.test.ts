import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateRetrieval, validateEvaluationDataset, type EvaluationDataset } from "../src/evaluation.js";
import dataset from "./evaluation/retrieval-dataset.json" with { type: "json" };

test("labeled retrieval dataset has provenance, stable labels, and at least 50 questions", () => {
  assert.ok(dataset.questions.length >= 50);
  assert.equal(validateEvaluationDataset(dataset as EvaluationDataset).length, 0);
  assert.match(dataset.provenance, /synthetic/i);
  assert.match(dataset.provenance, /not real user questions/i);
  assert.match(dataset.provenance, /not human validated/i);
});

// Convention: recall@k = (# relevant docs in top-k) / (# evaluable relevant docs for query).
// MRR = mean of 1/(rank of first relevant hit). NDCG uses graded relevance (1-3).
// corpusArticleKeys restricts which labels count as "evaluable"; others increment missingRelevantDocs.

test("recall@k and MRR when first relevant doc is NOT at rank-1", () => {
  // Ranking ["2","1"]; corpus=["1"]; so only label{key:"1",rel:3} is evaluable.
  // top-1=["2"] → hitGain=0 → recall@1=0; first relevant hit at rank 2 → MRR=0.5.
  // top-2=["2","1"] → hitGain=1 → recall@2=1.
  const small: EvaluationDataset = {
    schemaVersion: 1, name: "test",
    provenance: "synthetic; not real user questions; not human validated",
    generatedFrom: "test",
    questions: [{ id: "q1", question: "q", category: "x", labels: [{ articleKey: "1", relevance: 3, evidence: "x" }, { articleKey: "2", relevance: 1, evidence: "y" }] }],
  };
  const metrics = evaluateRetrieval(small, new Map([["q1", ["2", "1"]]]), [1, 2], ["1"]);
  assert.equal(metrics.missingRelevantDocs, 1, "article '2' not in corpus → 1 missing");
  assert.equal(metrics.evaluableQueries, 1);
  assert.equal(metrics.recallAt["1"], 0, "top-1 is '2' (non-relevant) → recall@1=0");
  assert.equal(metrics.recallAt["2"], 1, "top-2 includes '1' → recall@2=1");
  assert.equal(metrics.mrr, 0.5, "first relevant hit at rank 2 → MRR=1/2=0.5");
  assert.equal(metrics.ndcgAt["1"], 0, "top-1 is non-relevant → nDCG@1=0");
});

test("graded relevance: higher-relevance doc ranked first gives better nDCG", () => {
  // Two relevant docs: key "A" rel=3, key "B" rel=1. Rankings A→B vs B→A.
  const ds: EvaluationDataset = {
    schemaVersion: 1, name: "g", provenance: "synthetic; not real user questions; not human validated", generatedFrom: "g",
    questions: [{ id: "q1", question: "q", category: "x", labels: [{ articleKey: "A", relevance: 3, evidence: "a" }, { articleKey: "B", relevance: 1, evidence: "b" }] }],
  };
  const good = evaluateRetrieval(ds, new Map([["q1", ["A", "B"]]]), [2]);
  const bad = evaluateRetrieval(ds, new Map([["q1", ["B", "A"]]]), [2]);
  // DCG_good  = 3/log2(2) + 1/log2(3) = 3 + 0.631 = 3.631
  // DCG_bad   = 1/log2(2) + 3/log2(3) = 1 + 1.893 = 2.893
  // ideal DCG = 3/log2(2) + 1/log2(3) = 3.631
  // nDCG_good = 1, nDCG_bad < 1
  assert.equal(good.ndcgAt["2"], 1, "perfect ordering → nDCG@2=1");
  assert.ok(bad.ndcgAt["2"] < 1, "suboptimal ordering → nDCG@2<1");
  assert.ok(good.ndcgAt["2"] > bad.ndcgAt["2"], "good ordering has higher nDCG");
});

test("duplicate ranked keys are deduplicated before metric computation", () => {
  // Ranked list contains "1" twice; deduplication should leave ["1"].
  const ds: EvaluationDataset = {
    schemaVersion: 1, name: "d", provenance: "synthetic; not real user questions; not human validated", generatedFrom: "d",
    questions: [{ id: "q1", question: "q", category: "x", labels: [{ articleKey: "1", relevance: 2, evidence: "e" }] }],
  };
  const metrics = evaluateRetrieval(ds, new Map([["q1", ["1", "1", "2"]]]), [1, 2]);
  assert.equal(metrics.recallAt["1"], 1, "dedup keeps '1' at rank-1 → recall@1=1");
  assert.equal(metrics.recallAt["2"], 1, "dedup collapses ['1','1','2'] to ['1','2'] → recall@2 still 1");
});

test("cutoffs reject invalid values and repeated cutoffs do not double metrics", () => {
  const data = dataset as EvaluationDataset;
  for (const ks of [[], [0], [-1], [1.5], [Infinity], [NaN]]) {
    assert.throws(() => evaluateRetrieval(data, new Map(), ks), /positive integers/);
  }
  const rankings = new Map(data.questions.map((question) => [question.id, question.labels.map((label) => label.articleKey)]));
  assert.deepEqual(evaluateRetrieval(data, rankings, [1, 1]), evaluateRetrieval(data, rankings, [1]));
});

test("empty ranking list: recall and MRR are 0, query is still evaluable", () => {
  const ds: EvaluationDataset = {
    schemaVersion: 1, name: "e", provenance: "synthetic; not real user questions; not human validated", generatedFrom: "e",
    questions: [{ id: "q1", question: "q", category: "x", labels: [{ articleKey: "1", relevance: 1, evidence: "e" }] }],
  };
  const metrics = evaluateRetrieval(ds, new Map([["q1", []]]), [1, 5]);
  assert.equal(metrics.evaluableQueries, 1);
  assert.equal(metrics.recallAt["1"], 0);
  assert.equal(metrics.recallAt["5"], 0);
  assert.equal(metrics.mrr, 0);
});

test("all labels outside corpus: query is not evaluable, missingRelevantDocs increments", () => {
  const ds: EvaluationDataset = {
    schemaVersion: 1, name: "m", provenance: "synthetic; not real user questions; not human validated", generatedFrom: "m",
    questions: [{ id: "q1", question: "q", category: "x", labels: [{ articleKey: "1", relevance: 2, evidence: "e" }] }],
  };
  const metrics = evaluateRetrieval(ds, new Map([["q1", ["1"]]]), [1], ["99"]);
  assert.equal(metrics.evaluableQueries, 0);
  assert.equal(metrics.missingRelevantDocs, 1);
  assert.equal(metrics.recallAt["1"], 0);
});

test("validateEvaluationDataset: provenance must be synthetic and disclaim real-user and human-validated", () => {
  const base: EvaluationDataset = {
    schemaVersion: 1, name: "v", provenance: "synthetic; not real user questions; not human validated", generatedFrom: "v",
    questions: [{ id: "q1", question: "what", category: "c", labels: [{ articleKey: "1", relevance: 1, evidence: "text" }] }],
  };
  assert.equal(validateEvaluationDataset(base).length, 0, "valid provenance passes");
  assert.ok(validateEvaluationDataset({ ...base, provenance: "" }).length > 0, "empty provenance fails");
  assert.ok(validateEvaluationDataset({ ...base, provenance: "questions from real users, human validated" }).length > 0, "real-user provenance fails");
  assert.ok(validateEvaluationDataset({ ...base, provenance: "article-derived, not validated" }).length > 0, "missing 'synthetic' fails");
});

test("validateEvaluationDataset: evidence validator catches empty evidence and missing evidenceByArticle entry", () => {
  const base: EvaluationDataset = {
    schemaVersion: 1, name: "v", provenance: "synthetic; not real user questions; not human validated", generatedFrom: "v",
    questions: [{ id: "q1", question: "q", category: "c", labels: [{ articleKey: "1", relevance: 1, evidence: "abc" }] }],
  };
  // Empty evidence string should produce an error.
  const emptyEvidence = { ...base, questions: [{ ...base.questions[0], labels: [{ articleKey: "1", relevance: 1 as const, evidence: "" }] }] };
  assert.ok(validateEvaluationDataset(emptyEvidence).length > 0, "empty evidence fails");
  // evidenceByArticle provided but article key missing from it → error.
  const errors = validateEvaluationDataset(base, { evidenceByArticle: new Map([["99", "some text"]]) });
  assert.ok(errors.some((e) => e.includes("not found in evidenceByArticle")), "missing article in evidenceByArticle fails");
  // evidenceByArticle provided and article key present but evidence doesn't match → error.
  const mismatch = validateEvaluationDataset(base, { evidenceByArticle: new Map([["1", "completely different text"]]) });
  assert.ok(mismatch.some((e) => e.includes("not an exact excerpt")), "wrong evidence fails");
  // evidenceByArticle provided and article key present and evidence matches → no error.
  const match = validateEvaluationDataset(base, { evidenceByArticle: new Map([["1", "text with abc inside"]]) });
  assert.equal(match.length, 0, "matching evidence passes");
});
