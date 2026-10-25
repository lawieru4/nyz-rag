import type { ChatFeedbackReason, ChatReviewInput, ChatReviewRecord, EvaluationCandidate } from "@nyz-rag/types";
import { validateEvaluationDataset, type EvaluationDataset } from "./evaluation.js";
import { parseRetrievalFilters } from "./retrieval-filters.js";
import { createHash } from "node:crypto";

export const FEEDBACK_REASONS: readonly ChatFeedbackReason[] = ["missing-evidence", "incorrect-answer", "citation-mismatch", "outdated", "other"];
export const TRIAGE_STATUSES = ["new", "investigating", "resolved", "dismissed"] as const;
export const emptyChatReview = (): ChatReviewRecord => ({ status: "new", reasons: [], notes: "", correctedAnswer: "", candidate: null, revision: 0, approvedRevision: null, approvedAt: null });

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown or invalid annotation fields");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 20000): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`Annotation text must be a string of at most ${max} characters`);
  return value;
}
export function parseFeedbackReasons(value: unknown): ChatFeedbackReason[] {
  if (!Array.isArray(value) || value.length > 5 || value.some((item) => !FEEDBACK_REASONS.includes(item))) throw new Error("Invalid feedback reasons");
  return [...new Set(value)] as ChatFeedbackReason[];
}

/** Strict allowlist at every level; raw logs, identities and arbitrary metadata are not exportable. */
export function parseEvaluationCandidate(value: unknown): EvaluationCandidate {
  const item = object(value, ["question", "answer", "history", "filters", "type", "split", "answerable", "labels"]);
  if (!Array.isArray(item.history) || item.history.length > 20 || !Array.isArray(item.labels) || item.labels.length > 100) throw new Error("Invalid history or labels");
  if (item.filters === undefined) throw new Error("filters must be explicitly annotated as an object or null");
  const candidate: EvaluationCandidate = {
    question: text(item.question, 2000),
    ...(item.answer !== undefined ? { answer: text(item.answer) } : {}),
    history: item.history.map((value) => { const turn = object(value, ["question", "answer"]); return { question: text(turn.question, 2000), answer: text(turn.answer) }; }),
    filters: item.filters === null ? null : parseRetrievalFilters(item.filters),
    type: item.type as EvaluationCandidate["type"], split: item.split as EvaluationCandidate["split"], answerable: item.answerable as boolean,
    labels: item.labels.map((value) => {
      const label = object(value, ["articleKey", "relevance", "evidence"]);
      if (!Array.isArray(label.evidence) || label.evidence.length > 50) throw new Error("Invalid evidence");
      return { articleKey: text(label.articleKey, 100), relevance: label.relevance as 0 | 1 | 2 | 3, evidence: label.evidence.map((entry) => text(entry)) };
    }),
  };
  if (candidate.type === "followup" && !candidate.history.length) throw new Error("Followup requires manually annotated history");
  if ((candidate.type === "unanswerable") !== (candidate.answerable === false)) throw new Error("Unanswerable type and answerable must agree");
  const errors = validateEvaluationDataset(candidateDataset(candidate));
  if (errors.length) throw new Error(errors.join("; "));
  return candidate;
}

export function parseChatReview(value: unknown): ChatReviewInput {
  const item = object(value, ["status", "reasons", "notes", "correctedAnswer", "candidate"]);
  if (!TRIAGE_STATUSES.includes(item.status as ChatReviewInput["status"])) throw new Error("Invalid triage status");
  return { status: item.status as ChatReviewInput["status"], reasons: parseFeedbackReasons(item.reasons), notes: text(item.notes), correctedAnswer: text(item.correctedAnswer), candidate: item.candidate === null ? null : parseEvaluationCandidate(item.candidate) };
}

function candidateDataset(candidate: EvaluationCandidate): EvaluationDataset {
  const version = createHash("sha256").update(JSON.stringify(candidate)).digest("hex").slice(0, 16);
  return { schemaVersion: 2, name: "reviewed-feedback", version, provenance: "Manually annotated and privacy-reviewed feedback candidate; not an exact replay. Human approval does not establish model quality; exact excerpts are checked against the current corpus at approval and export.", questions: [{ id: "reviewed-1", source: "real", ...candidate }] };
}

export function exportReviewedCandidate(review: ChatReviewRecord, revision: number): EvaluationDataset {
  if (review.revision !== revision || review.approvedRevision !== revision || !review.approvedAt || !review.candidate) throw new Error("Current candidate revision requires explicit human approval");
  return candidateDataset(parseEvaluationCandidate(review.candidate));
}
