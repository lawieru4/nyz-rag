import { readFile } from "node:fs/promises";

export interface EvaluationEvidence {
  articleKey: string;
  relevance: 1 | 2 | 3;
  evidence: string;
}

export interface EvaluationQuestion {
  id: string;
  question: string;
  category: string;
  labels: EvaluationEvidence[];
}

export interface EvaluationDataset {
  schemaVersion: 1;
  name: string;
  provenance: string;
  generatedFrom: string;
  questions: EvaluationQuestion[];
}

export interface EvaluationMetrics {
  queries: number;
  evaluableQueries: number;
  missingRelevantDocs: number;
  recallAt: Record<string, number>;
  mrr: number;
  ndcgAt: Record<string, number>;
}

export interface DatasetValidationOptions {
  corpusArticleKeys?: Iterable<string>;
  evidenceByArticle?: Map<string, string>;
}

export async function readEvaluationDataset(path: string): Promise<EvaluationDataset> {
  return JSON.parse(await readFile(path, "utf8")) as EvaluationDataset;
}

export function validateEvaluationDataset(dataset: EvaluationDataset, options: DatasetValidationOptions = {}): string[] {
  const errors: string[] = [];
  if (dataset.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  // Provenance must declare this is synthetic/article-derived data that is not human validated.
  // Reject if missing or if it does not explicitly disavow real-user or human-validated status.
  if (!dataset.provenance) {
    errors.push("provenance must state synthetic/article-derived and validation limits");
  } else if (!/synthetic/i.test(dataset.provenance) || !/not\s+real user/i.test(dataset.provenance) || !/not\s+human.validated/i.test(dataset.provenance)) {
    errors.push("provenance must contain 'synthetic' and explicitly state it is not real user data and not human validated");
  }
  if (!dataset.questions?.length) errors.push("dataset must contain questions");
  const ids = new Set<string>();
  const corpus = options.corpusArticleKeys ? new Set(options.corpusArticleKeys) : undefined;
  for (const [index, item] of (dataset.questions ?? []).entries()) {
    if (!item.id || ids.has(item.id)) errors.push(`questions[${index}] has a duplicate or empty id`);
    ids.add(item.id);
    if (!item.question?.trim()) errors.push(`questions[${index}] has an empty question`);
    if (!item.labels?.length) errors.push(`questions[${index}] has no relevance labels`);
    const labelIds = new Set<string>();
    for (const label of item.labels ?? []) {
      if (!/^\d+$/.test(label.articleKey)) errors.push(`${item.id}: articleKey must be a stable numeric external id`);
      if (labelIds.has(label.articleKey)) errors.push(`${item.id}: duplicate articleKey ${label.articleKey}`);
      labelIds.add(label.articleKey);
      if (![1, 2, 3].includes(label.relevance)) errors.push(`${item.id}: relevance for ${label.articleKey} must be 1, 2, or 3`);
      if (!label.evidence?.trim()) errors.push(`${item.id}: evidence for ${label.articleKey} must not be empty`);
      if (corpus && !corpus.has(label.articleKey)) errors.push(`${item.id}: labeled article ${label.articleKey} is missing from corpus`);
      if (options.evidenceByArticle) {
        const source = options.evidenceByArticle.get(label.articleKey);
        if (source === undefined) errors.push(`${item.id}: article ${label.articleKey} not found in evidenceByArticle`);
        else if (label.evidence?.trim() && !source.includes(label.evidence)) errors.push(`${item.id}: evidence is not an exact excerpt of ${label.articleKey}`);
      }
    }
  }
  return errors;
}

/** Stable, dependency-free lexical baseline used for offline smoke evaluation. */
export function rankOffline(question: string, corpus: Array<{ articleKey: string; title: string; text: string }>): string[] {
  const terms = new Set(question.toLocaleLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]/gi) ?? []);
  const score = (text: string) => {
    const normalized = text.toLocaleLowerCase();
    let value = 0;
    for (const term of terms) {
      if (normalized.includes(term)) value += term.length > 1 ? 2 : 1;
    }
    return value;
  };
  return corpus.map((item, index) => ({ key: item.articleKey, score: score(`${item.title} ${item.text}`), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.key);
}

const unique = (keys: string[]) => [...new Set(keys)];

/** Article-level macro averages; nDCG uses linear relevance gains. Missing labels are reported separately. */
export function evaluateRetrieval(dataset: EvaluationDataset, rankings: Map<string, string[]>, ks = [1, 3, 5, 10], corpusArticleKeys?: Iterable<string>): EvaluationMetrics {
  if (!ks.length || ks.some((k) => !Number.isSafeInteger(k) || k <= 0)) throw new Error("Cutoffs must be positive integers");
  ks = [...new Set(ks)];
  const corpus = corpusArticleKeys ? new Set(corpusArticleKeys) : undefined;
  const recall = Object.fromEntries(ks.map((k) => [`${k}`, 0]));
  const ndcg = Object.fromEntries(ks.map((k) => [`${k}`, 0]));
  let mrr = 0;
  let evaluable = 0;
  let missingRelevantDocs = 0;
  for (const question of dataset.questions) {
    const labels = question.labels.filter((label) => !corpus || corpus.has(label.articleKey));
    missingRelevantDocs += question.labels.length - labels.length;
    if (!labels.length) continue;
    evaluable += 1;
    const relevant = new Map(labels.map((label) => [label.articleKey, label.relevance]));
    const ranked = unique(rankings.get(question.id) ?? []);
    const first = ranked.findIndex((key) => relevant.has(key));
    if (first >= 0) mrr += 1 / (first + 1);
    for (const k of ks) {
      const top = ranked.slice(0, k);
      const hitGain = top.reduce((sum, key) => sum + (relevant.has(key) ? 1 : 0), 0);
      recall[`${k}`] += hitGain / labels.length;
      const dcg = top.reduce((sum, key, rank) => sum + (relevant.get(key) ?? 0) / Math.log2(rank + 2), 0);
      const ideal = [...relevant.values()].sort((a, b) => b - a).slice(0, k).reduce((sum, value, rank) => sum + value / Math.log2(rank + 2), 0);
      ndcg[`${k}`] += ideal ? dcg / ideal : 0;
    }
  }
  const denominator = evaluable || 1;
  for (const k of ks) { recall[`${k}`] /= denominator; ndcg[`${k}`] /= denominator; }
  return { queries: dataset.questions.length, evaluableQueries: evaluable, missingRelevantDocs, recallAt: recall, mrr: mrr / denominator, ndcgAt: ndcg };
}
