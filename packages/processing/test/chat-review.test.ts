import assert from "node:assert/strict";
import test from "node:test";
import { emptyChatReview, exportReviewedCandidate, parseChatReview, parseEvaluationCandidate } from "../src/chat-review.js";
import { assertSupportedEvaluationInputs, validateEvaluationDataset } from "../src/evaluation.js";
import { runVariantWithContext } from "../src/evaluation-run.js";
import { DEFAULT_RETRIEVAL_SETTINGS } from "../src/rag.js";
import type { EvaluationCandidate } from "@nyz-rag/types";

const candidate: EvaluationCandidate = { question: "Public example question", answer: "Public corrected answer", history: [], filters: null, type: "compare", split: "test", answerable: true, labels: [{ articleKey: "123", relevance: 2, evidence: ["Public excerpt"] }] };

test("candidate validation is strict, nested, and compatible with v2 labels", () => {
  assert.deepEqual(parseEvaluationCandidate(candidate), candidate);
  for (const value of [
    { ...candidate, userEmail: "private@example.test" },
    { ...candidate, history: [{ question: "Q", answer: "A", visitorHash: "private" }] },
    { ...candidate, labels: [{ ...candidate.labels[0], documentId: "private" }] },
    { ...candidate, filters: { tenantId: "private" } },
    { ...candidate, filters: { publishedFrom: "2026-02-30" } },
    { ...candidate, filters: undefined },
    { ...candidate, history: [{ question: "", answer: "A" }] },
    { ...candidate, type: "followup" },
    { ...candidate, labels: [{ articleKey: "internal-uuid", relevance: 2, evidence: ["Excerpt"] }] },
    { ...candidate, labels: [{ articleKey: "123", relevance: 1, evidence: [] }] },
    { ...candidate, labels: [{ articleKey: "123", relevance: 1, evidence: ["Excerpt"] }] },
    { ...candidate, type: "unanswerable", answerable: false },
  ]) assert.throws(() => parseEvaluationCandidate(value));
  assert.equal(parseEvaluationCandidate({ ...candidate, type: "unanswerable", answerable: false, labels: [] }).answerable, false);
  assert.equal(parseEvaluationCandidate({ ...candidate, type: "followup", history: [{ question: "Prior", answer: "Prior answer" }], filters: { categories: ["Public category"] } }).history.length, 1);
});

test("review export requires current explicit approval and exports only independently annotated fields", () => {
  const review = { ...emptyChatReview(), revision: 2, notes: "PRIVATE_INTERNAL_NOTES", correctedAnswer: "PRIVATE_INTERNAL_ANSWER", candidate };
  assert.throws(() => exportReviewedCandidate(review, 2), /approval/);
  const approved = { ...review, approvedRevision: 2, approvedAt: "2026-10-25T00:00:00Z" };
  assert.throws(() => exportReviewedCandidate(approved, 1), /approval/);
  assert.throws(() => exportReviewedCandidate({ ...approved, revision: 3 }, 3), /approval/);
  const dataset = exportReviewedCandidate(approved, 2);
  assert.deepEqual(validateEvaluationDataset(dataset), []);
  assert.deepEqual(Object.keys(dataset.questions[0]).sort(), ["id", "source", ...Object.keys(candidate)].sort());
  assert.doesNotMatch(JSON.stringify(dataset), /PRIVATE|approved|revision|email|visitorHash|sessionId|chunks/);
  assert.equal(dataset.questions[0].source, "real");
  assert.notEqual(exportReviewedCandidate({ ...approved, candidate: { ...candidate, question: "Changed" } }, 2).version, dataset.version);
  assert.throws(() => parseChatReview({ ...emptyChatReview() }), /fields/);
});

test("evaluation runners reject filters, and history unless a retrieval query was chosen, instead of silently widening replay", async () => {
  const reject = { keywordSearch: async () => { assert.fail("must reject before retrieval"); } };
  const filtered = { ...candidate, id: "q", source: "real" as const, filters: { categories: ["Public"] } };
  assert.throws(() => assertSupportedEvaluationInputs([filtered], { history: true }), /does not support filters/);
  await assert.rejects(runVariantWithContext({ ...filtered, retrievalQuery: "q" }, "keyword", DEFAULT_RETRIEVAL_SETTINGS, reject, (id) => id), /does not support filters/);

  const followup = { ...candidate, id: "q", source: "real" as const, history: [{ question: "Prior", answer: "Answer" }] };
  assert.throws(() => assertSupportedEvaluationInputs([followup]), /does not support history/);
  await assert.rejects(runVariantWithContext(followup, "keyword", DEFAULT_RETRIEVAL_SETTINGS, reject, (id) => id), /does not support history/);
  assert.doesNotThrow(() => assertSupportedEvaluationInputs([followup], { history: true }));
  let searched: string[] = [];
  await runVariantWithContext({ ...followup, retrievalQuery: "Rewritten lithium question" }, "keyword", DEFAULT_RETRIEVAL_SETTINGS, { keywordSearch: async (terms) => { searched = terms; return []; } }, (id) => id);
  assert.ok(searched.includes("lithium") && searched.includes("rewritten"), "the chosen retrieval query is searched, not the original question");
});
