// 检索评估集：数据集格式（schemaVersion 2，兼容读取 v1）、校验、语料指纹与文章级指标。方案见 docs/evaluation-plan.md。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RetrievalFilters } from "@nyz-rag/types";

export const QUESTION_TYPES = ["fact", "mechanism", "compare", "metadata", "term", "followup", "unanswerable"] as const;
export const QUESTION_SOURCES = ["synthetic", "real", "real-silver", "expert"] as const;
export const SPECIFICITIES = ["high", "low"] as const;
export const SPLITS = ["dev", "test"] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];
export type QuestionSource = (typeof QUESTION_SOURCES)[number];
export type Specificity = (typeof SPECIFICITIES)[number];
export type Split = (typeof SPLITS)[number];

/** 文章级标注：0～3 分级（0 表示已判定不相关）；相关度 ≥ 2 时证据必填，证据为原文摘录。 */
export interface EvaluationLabel {
  articleKey: string;
  relevance: 0 | 1 | 2 | 3;
  evidence: string[];
}

export interface EvaluationQuestion {
  id: string;
  question: string;
  /** 参考答案，只用于审核题目质量，检索时不使用。 */
  answer?: string;
  history: Array<{ question: string; answer: string }>;
  filters: RetrievalFilters | null;
  type: QuestionType;
  specificity?: Specificity;
  source: QuestionSource;
  split: Split;
  answerable: boolean;
  /** 问题与「证据 + 标题」的词项重叠率（合成题）。 */
  lexicalOverlap?: number;
  notes?: string;
  labels: EvaluationLabel[];
}

/** 语料快照：fingerprint 只由文章正文决定，切片或向量变化不影响。 */
export interface CorpusSnapshot {
  documents: number;
  fingerprint: string;
  parserVersions: Record<string, number>;
  chunkerVersion: number | null;
  embeddingModel: string | null;
  embeddingCoverage: number;
}

export interface EvaluationDataset {
  schemaVersion: 2;
  name: string;
  version: string;
  provenance: string;
  corpus?: CorpusSnapshot;
  sample?: Record<string, unknown>;
  generation?: Record<string, unknown>;
  questions: EvaluationQuestion[];
}

/** schemaVersion 1：现有 50 条合成题的格式，读取时转换为 v2。 */
export interface EvaluationDatasetV1 {
  schemaVersion: 1;
  name: string;
  provenance: string;
  generatedFrom: string;
  questions: Array<{ id: string; question: string; category: string; labels: Array<{ articleKey: string; relevance: 1 | 2 | 3; evidence: string }> }>;
}

export type AnyEvaluationDataset = EvaluationDataset | EvaluationDatasetV1;

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
  /** 文章可供摘录证据的文本（正文，元数据题可附加标题与元数据字段）。 */
  evidenceByArticle?: Map<string, string>;
}

/** v1 没有题型与划分：题型记为 fact、全部为 dev，原分类保存在 notes。 */
export function upgradeEvaluationDataset(dataset: AnyEvaluationDataset): EvaluationDataset {
  if (dataset.schemaVersion !== 1) return dataset;
  return {
    schemaVersion: 2,
    name: dataset.name,
    version: "v1",
    provenance: dataset.provenance,
    generation: { generatedFrom: dataset.generatedFrom },
    questions: (dataset.questions ?? []).map((item) => ({
      id: item.id,
      question: item.question,
      history: [],
      filters: null,
      type: "fact",
      source: "synthetic",
      split: "dev",
      answerable: true,
      notes: `v1 category: ${item.category}`,
      labels: (item.labels ?? []).map((label) => ({ articleKey: label.articleKey, relevance: label.relevance, evidence: label.evidence?.trim() ? [label.evidence] : [] })),
    })),
  };
}

export async function readEvaluationDataset(path: string): Promise<EvaluationDataset> {
  const raw = JSON.parse(await readFile(path, "utf8")) as AnyEvaluationDataset;
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) throw new Error(`Unsupported evaluation dataset schemaVersion ${String((raw as { schemaVersion?: unknown }).schemaVersion)}`);
  return upgradeEvaluationDataset(raw);
}

/** 证据匹配的规范化：NFKC 并去掉全部空白，排版差异不影响子串匹配。 */
export const normalizeEvidenceText = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");

const includes = <T extends string>(values: readonly T[], value: unknown): value is T => values.includes(value as T);

export function validateEvaluationDataset(input: AnyEvaluationDataset, options: DatasetValidationOptions = {}): string[] {
  const errors: string[] = [];
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) return ["schemaVersion must be 1 or 2"];
  const dataset = upgradeEvaluationDataset(input);
  if (!dataset.name?.trim()) errors.push("name must not be empty");
  if (!dataset.questions?.length) errors.push("dataset must contain questions");
  // 合成题必须声明来源与验证程度，避免被当作真实问题或人工标注。
  if (dataset.questions?.some((item) => item.source === "synthetic")) {
    if (!dataset.provenance) {
      errors.push("provenance must state synthetic/article-derived and validation limits");
    } else if (!/synthetic/i.test(dataset.provenance) || !/not\s+real user/i.test(dataset.provenance) || !/not\s+human.validated/i.test(dataset.provenance)) {
      errors.push("provenance must contain 'synthetic' and explicitly state it is not real user data and not human validated");
    }
  }
  const ids = new Set<string>();
  const corpus = options.corpusArticleKeys ? new Set(options.corpusArticleKeys) : undefined;
  const normalizedSources = new Map<string, string>();
  for (const [index, item] of (dataset.questions ?? []).entries()) {
    const at = item.id || `questions[${index}]`;
    if (!item.id || ids.has(item.id)) errors.push(`questions[${index}] has a duplicate or empty id`);
    ids.add(item.id);
    if (!item.question?.trim()) errors.push(`questions[${index}] has an empty question`);
    if (!includes(QUESTION_TYPES, item.type)) errors.push(`${at}: unknown type ${String(item.type)}`);
    if (!includes(QUESTION_SOURCES, item.source)) errors.push(`${at}: unknown source ${String(item.source)}`);
    if (!includes(SPLITS, item.split)) errors.push(`${at}: split must be dev or test`);
    if (item.specificity !== undefined && !includes(SPECIFICITIES, item.specificity)) errors.push(`${at}: specificity must be high or low`);
    if (typeof item.answerable !== "boolean") errors.push(`${at}: answerable must be a boolean`);
    if (!Array.isArray(item.history)) errors.push(`${at}: history must be an array`);
    if (!item.labels?.length && item.answerable !== false) errors.push(`questions[${index}] has no relevance labels`);
    const labelIds = new Set<string>();
    for (const label of item.labels ?? []) {
      if (!/^\d+$/.test(label.articleKey)) errors.push(`${at}: articleKey must be a stable numeric external id`);
      if (labelIds.has(label.articleKey)) errors.push(`${at}: duplicate articleKey ${label.articleKey}`);
      labelIds.add(label.articleKey);
      if (![0, 1, 2, 3].includes(label.relevance)) errors.push(`${at}: relevance for ${label.articleKey} must be 0-3`);
      const evidence = Array.isArray(label.evidence) ? label.evidence : [];
      if (!Array.isArray(label.evidence) || evidence.some((text) => typeof text !== "string" || !text.trim())) errors.push(`${at}: evidence for ${label.articleKey} must be non-empty strings`);
      if (label.relevance >= 1 && !evidence.length) errors.push(`${at}: evidence for ${label.articleKey} must not be empty`);
      if (corpus && !corpus.has(label.articleKey)) errors.push(`${at}: labeled article ${label.articleKey} is missing from corpus`);
      if (options.evidenceByArticle && evidence.length) {
        const source = options.evidenceByArticle.get(label.articleKey);
        if (source === undefined) {
          errors.push(`${at}: article ${label.articleKey} not found in evidenceByArticle`);
        } else {
          if (!normalizedSources.has(label.articleKey)) normalizedSources.set(label.articleKey, normalizeEvidenceText(source));
          const normalized = normalizedSources.get(label.articleKey)!;
          if (evidence.some((text) => text.trim() && !normalized.includes(normalizeEvidenceText(text)))) errors.push(`${at}: evidence is not an exact excerpt of ${label.articleKey}`);
        }
      }
    }
    const relevant = (item.labels ?? []).filter((label) => label.relevance >= 2);
    // v1 的 1～3 分都视为相关，可回答性规则只用于 v2。
    if (input.schemaVersion === 2 && item.answerable === true && !relevant.length) errors.push(`${at}: answerable questions need an article with relevance >= 2`);
    if (item.answerable === false && relevant.length) errors.push(`${at}: unanswerable questions cannot have relevance >= 2`);
  }
  return errors;
}

export const filterSplit = (dataset: EvaluationDataset, split?: Split): EvaluationDataset =>
  split ? { ...dataset, questions: dataset.questions.filter((item) => item.split === split) } : dataset;

/** 按文章确定 dev / test（约 2:1）：同一篇文章的题目始终在同一侧，扩充时已有文章的划分不变。 */
export function splitForArticle(articleKey: string): Split {
  return createHash("sha256").update(`split:${articleKey}`).digest().readUInt32BE(0) % 3 === 0 ? "test" : "dev";
}

/** 语料指纹：按 articleKey 排序的 `articleKey:contentHash` 列表的 SHA-256。 */
export function corpusFingerprint(entries: Iterable<{ articleKey: string; contentHash: string | null }>): string {
  const lines = [...entries].map((entry) => `${entry.articleKey}:${entry.contentHash ?? ""}`).sort();
  return `sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
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

/** Article-level macro averages over labels with relevance >= 1; nDCG uses linear relevance gains. Missing labels are reported separately. */
export function evaluateRetrieval(input: AnyEvaluationDataset, rankings: Map<string, string[]>, ks = [1, 3, 5, 10], corpusArticleKeys?: Iterable<string>): EvaluationMetrics {
  if (!ks.length || ks.some((k) => !Number.isSafeInteger(k) || k <= 0)) throw new Error("Cutoffs must be positive integers");
  ks = [...new Set(ks)];
  const dataset = upgradeEvaluationDataset(input);
  const corpus = corpusArticleKeys ? new Set(corpusArticleKeys) : undefined;
  const recall = Object.fromEntries(ks.map((k) => [`${k}`, 0]));
  const ndcg = Object.fromEntries(ks.map((k) => [`${k}`, 0]));
  let mrr = 0;
  let evaluable = 0;
  let missingRelevantDocs = 0;
  for (const question of dataset.questions) {
    const positive = question.labels.filter((label) => label.relevance > 0);
    const labels = positive.filter((label) => !corpus || corpus.has(label.articleKey));
    missingRelevantDocs += positive.length - labels.length;
    if (!labels.length) continue;
    evaluable += 1;
    const relevant = new Map<string, number>(labels.map((label) => [label.articleKey, label.relevance]));
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
