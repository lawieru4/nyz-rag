// 检索评估运行（hybrid 模式）：按变体裁剪 retrieve() 的依赖，得到文章排名与回答上下文，计算第七节的指标，并对比两次运行。方案见 docs/evaluation-plan.md 第七、八节。
import type { CorpusSnapshot, EvaluationLabel, EvaluationQuestion, QuestionType, Specificity, Split } from "./evaluation.js";
import { assertSupportedEvaluationInputs } from "./evaluation.js";
import type { RunAdjudication } from "./evaluation-adjudication.js";
import type { QueryOutcome, RewriteMode } from "./evaluation-rewrite.js";
import { buildAnswerContext, buildSectionContext, CANDIDATE_LIMIT, retrieve, type AnswerContext, type RetrievalDependencies, type RetrievalSettings, type SectionContext } from "./rag.js";

export const RETRIEVAL_VARIANTS = ["keyword", "vector", "summary", "fused", "rerank"] as const;
export type RetrievalVariant = (typeof RETRIEVAL_VARIANTS)[number];

export const RUN_SCHEMA_VERSION = 1;
export const HIT_KS = [1, 5, 10] as const;
/** 排名列表以合并后的候选上限调用 retrieve()，开启 Rerank 时 topN 随之相同（7.1）。 */
export const RANKING_DEPTH = CANDIDATE_LIMIT;
/** 排名列表不足这么多篇文章时计入「排名深度不足」。 */
export const MIN_RANKED_ARTICLES = 10;
/** 证据的字符二元组被回答上下文覆盖的比例达到该值即为证据命中。 */
export const EVIDENCE_COVERAGE = 0.8;

/**
 * 回答上下文的组装方式（同一次检索结果，只改变送入模型的内容）：
 * - topk：排名前「知识库 topK」个切片经 buildAnswerContext 截取，与线上一致；
 * - budget：按排名依次放入切片直到 maxContextLength，用于在相同字数预算下比较不同切片规则；
 * - section：按父块组装（buildSectionContext），没有父块的切片按切片放入。
 */
export const CONTEXT_MODES = ["topk", "budget", "section"] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

export interface ContextOptions {
  mode: ContextMode;
  /** section 模式读取父块及其切片。 */
  loadSections?: (sectionIds: string[]) => Promise<SectionContext[]>;
}

/** 排名列表中的切片与各路得分。 */
export interface RunChunk {
  chunkId: string;
  articleKey: string;
  score: number;
  vectorScore?: number;
  keywordScore?: number;
  summaryScore?: number;
  rerankScore?: number;
}

export interface VariantResult {
  /** 文章排名：切片按名次取所属文章并去重。 */
  articles: string[];
  chunks: RunChunk[];
  /** 回答上下文：按运行的上下文组装方式（settings.context，默认 topk）得到的各项；section 模式下 chunkId 为父块中排名最高的命中切片。 */
  context: Array<{ chunkId: string; articleKey: string; sectionId?: string }>;
  /** 回答上下文的正文总字数（引入前的运行记录没有）。 */
  contextChars?: number;
  /** 来源文章在文章排名中的名次（从 1 开始），不在排名列表中为 null。 */
  rank: number | null;
  contextHit: boolean;
  /** 回答上下文中来源文章的内容是否覆盖任一段证据；metadata 题不计算，为 null。 */
  evidenceHit: boolean | null;
  /** 是否覆盖全部证据段（引入前的运行记录没有）。 */
  evidenceFull?: boolean | null;
  /** retrieve() 耗时，不含查询 Embedding。 */
  retrievalMs: number;
  /** 降级说明（向量、摘要召回或 Rerank 失败）。 */
  warnings: string[];
  error?: string;
}

export interface RunQuestion {
  id: string;
  question: string;
  type: QuestionType;
  specificity?: Specificity;
  split: Split;
  lexicalOverlap?: number;
  sourceArticleKeys: string[];
  /** 对话历史轮数；没有历史时省略。 */
  historyTurns?: number;
  /** 带历史的题目实际用于检索的问题（--rewrite）及独立问题词项的保留比例；没有历史时省略。 */
  rewrite?: QueryOutcome & { standaloneRecall?: number | null };
  /** 因语料变化排除的原因：来源文章已不在语料中，或证据已不在原文中。 */
  excluded?: string;
  embeddingMs?: number;
  /** 查询 Embedding 失败，所有变体都没有结果。 */
  error?: string;
  results: Partial<Record<RetrievalVariant, VariantResult>>;
}

export interface HybridMetrics {
  questions: number;
  hitAt: Record<string, number>;
  mrr: number;
  contextHit: number;
  evidenceHit: number | null;
  /** 全部证据段都被覆盖的比例，分母同 evidenceHit；运行记录缺少该字段时为 null。 */
  evidenceFull: number | null;
  evidenceQuestions: number;
  /** 回答上下文的平均字数；运行记录缺少该字段时为 null。 */
  contextChars: number | null;
}

export const GROUP_DIMENSIONS = ["split", "type", "specificity", "overlap", "turn"] as const;
export type GroupDimension = (typeof GROUP_DIMENSIONS)[number];

export interface VariantSummary {
  overall: HybridMetrics;
  groups: Record<GroupDimension, Record<string, HybridMetrics>>;
  reliability: { evaluated: number; excluded: number; errors: number; degraded: number; shallowRanking: number };
  latency: { p50: number | null; p95: number | null };
}

interface ModelInfo { provider: string; model: string }

/** 带历史题目的检索问题改写统计；failures 为 llm 改写失败或输出不合格、退回当前问题的题数。 */
export interface RewriteSummary {
  mode: RewriteMode;
  questions: number;
  failures: number;
  latency: { p50: number | null; p95: number | null };
  /** 按对话分组（turn）的独立问题词项平均保留比例，只统计标注了独立问题的题目。 */
  standaloneRecall: Record<string, number | null>;
  usage: { promptTokens: number; completionTokens: number };
}

export interface RunRecord {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  name: string;
  createdAt: string;
  dataset: { name: string; version: string; path: string; split: Split | "all"; questions: number; limit?: number; corpusFingerprint: string | null; generation?: Record<string, unknown> };
  /** 运行时的语料快照。 */
  corpus: CorpusSnapshot;
  corpusChanged: boolean;
  /** 向量化覆盖率不足 100% 时为 true，结果不完整。 */
  incomplete: boolean;
  /** context 为上下文组装方式，缺省为 topk；schema 为评估用的实验 schema，缺省为业务库。 */
  /** rewrite 为带历史题目的检索问题改写方式，只有数据集含带历史的题目时记录。 */
  settings: { knowledgeBase: { id: string; name: string } | null; retrieval: RetrievalSettings; rankingDepth: number; context?: ContextMode; schema?: string; rewrite?: RewriteMode };
  /** rewrite 为 --rewrite=llm 时改写使用的模型（业务模型 rewrite，未配置时为 Chat 模型）。 */
  models: { embedding: ModelInfo | null; rerank: ModelInfo | null; rewrite?: ModelInfo };
  variants: RetrievalVariant[];
  summary: Partial<Record<RetrievalVariant, VariantSummary>>;
  embedding: { p50: number | null; p95: number | null; failures: number };
  rewrite?: RewriteSummary;
  questions: RunQuestion[];
  /** 失败题复判与宽松指标（7.3），由 evaluate:adjudicate 补写。 */
  adjudication?: RunAdjudication;
}

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const ratio = (part: number, total: number) => total ? round(part / total) : 0;

export const sourceLabels = (question: Pick<EvaluationQuestion, "labels">): EvaluationLabel[] => question.labels.filter((label) => label.relevance > 0);

export const overlapBucket = (value: number | undefined) => value === undefined ? "unknown" : value < 0.4 ? "<0.4" : value < 0.6 ? "0.4-0.6" : ">=0.6";

/** 最近秩百分位。 */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

// ---- 证据命中 ----

// 规范化：NFKC、去空白与标点、小写；按字符二元组比较，切片边界与排版差异不影响结果。
const evidenceText = (text: string) => text.normalize("NFKC").replace(/[\s\p{P}]/gu, "").toLowerCase();
const bigrams = (text: string) => {
  const chars = [...text];
  return chars.length < 2 ? chars : chars.slice(1).map((char, index) => chars[index] + char);
};

/** 证据的字符二元组中出现在 text 里的比例。 */
export function evidenceCoverage(evidence: string, text: string): number {
  const target = bigrams(evidenceText(evidence));
  if (!target.length) return 0;
  const available = new Set(bigrams(evidenceText(text)));
  return target.filter((gram) => available.has(gram)).length / target.length;
}

// ---- 运行 ----

/** 按变体裁剪依赖：关键词召回是 retrieve() 的必需依赖，不使用时返回空。 */
export function variantDependencies(variant: RetrievalVariant, full: RetrievalDependencies): RetrievalDependencies {
  const uses = {
    keyword: variant === "keyword" || variant === "fused" || variant === "rerank",
    vector: variant === "vector" || variant === "fused" || variant === "rerank",
    summary: variant === "summary" || variant === "fused" || variant === "rerank",
    rerank: variant === "rerank",
  };
  if ((uses.vector && !full.vectorSearch) || (uses.summary && !full.summarySearch)) throw new Error(`Variant ${variant} requires an embedding model`);
  if (uses.rerank && !full.rerank) throw new Error(`Variant ${variant} requires a rerank model`);
  return {
    keywordSearch: uses.keyword ? full.keywordSearch : async () => [],
    ...(uses.vector ? { vectorSearch: full.vectorSearch } : {}),
    ...(uses.summary ? { summarySearch: full.summarySearch } : {}),
    ...(uses.rerank ? { rerank: full.rerank } : {}),
  };
}

/**
 * 用一个变体检索一道题：排名列表取 RANKING_DEPTH 个切片，回答上下文按 context.mode 组装（默认取前 settings.topK 个并按 maxContextLength 截取）。
 * 只有 rerank 变体开启 Rerank，其余参数取自知识库。带历史的题目必须给出 retrievalQuery（按 --rewrite 得到的检索问题），否则报错。
 */
export async function runVariant(...args: Parameters<typeof runVariantWithContext>): Promise<VariantResult> {
  return (await runVariantWithContext(...args)).result;
}

/** 同 runVariant，另返回组装好的回答上下文，供回答层评估送入 Chat 模型。 */
export async function runVariantWithContext(
  question: Pick<EvaluationQuestion, "question" | "type" | "labels"> & Partial<Pick<EvaluationQuestion, "id" | "history" | "filters">> & { retrievalQuery?: string },
  variant: RetrievalVariant, settings: RetrievalSettings, dependencies: RetrievalDependencies, articleKeyOf: (documentId: string) => string, context: ContextOptions = { mode: "topk" },
): Promise<{ result: VariantResult; context: AnswerContext }> {
  assertSupportedEvaluationInputs([{ ...question, id: question.id ?? "question", history: question.history ?? [], filters: question.filters ?? null } as EvaluationQuestion], { history: question.retrievalQuery !== undefined });
  const started = performance.now();
  const { chunks, warnings } = await retrieve(question.retrievalQuery ?? question.question, { ...settings, topK: RANKING_DEPTH, rerankEnabled: variant === "rerank" }, variantDependencies(variant, dependencies));
  const retrievalMs = round(performance.now() - started, 1);
  const ranked: RunChunk[] = chunks.map((chunk) => ({
    chunkId: chunk.chunkId, articleKey: articleKeyOf(chunk.documentId), score: round(chunk.score, 6),
    ...(chunk.vectorScore !== undefined ? { vectorScore: round(chunk.vectorScore) } : {}),
    ...(chunk.keywordScore !== undefined ? { keywordScore: round(chunk.keywordScore) } : {}),
    ...(chunk.summaryScore !== undefined ? { summaryScore: round(chunk.summaryScore) } : {}),
    ...(chunk.rerankScore !== undefined ? { rerankScore: round(chunk.rerankScore) } : {}),
  }));
  const articles = [...new Set(ranked.map((chunk) => chunk.articleKey))];
  const assembled = context.mode === "section"
    ? buildSectionContext(chunks, await (context.loadSections ?? (async () => []))(chunks.flatMap((chunk) => chunk.sectionId ? [chunk.sectionId] : [])), settings.maxContextLength)
    : buildAnswerContext(context.mode === "topk" ? chunks.slice(0, settings.topK) : chunks, settings.maxContextLength);
  const items = assembled.chunks.map((chunk) => ({ ...chunk, articleKey: articleKeyOf(chunk.documentId) }));
  const labels = sourceLabels(question);
  const sources = new Set(labels.map((label) => label.articleKey));
  const index = articles.findIndex((key) => sources.has(key));
  const covered = (match: "some" | "every") => question.type === "metadata" ? null : labels.some((label) => {
    const text = items.filter((chunk) => chunk.articleKey === label.articleKey).map((chunk) => chunk.content).join("\n");
    return Boolean(text) && label.evidence[match]((evidence) => evidenceCoverage(evidence, text) >= EVIDENCE_COVERAGE);
  });
  const result: VariantResult = {
    articles, chunks: ranked, context: items.map(({ chunkId, articleKey, sectionId }) => ({ chunkId, articleKey, ...(context.mode === "section" && sectionId ? { sectionId } : {}) })),
    contextChars: items.reduce((sum, chunk) => sum + chunk.content.length, 0),
    rank: index >= 0 ? index + 1 : null, contextHit: items.some((chunk) => sources.has(chunk.articleKey)), evidenceHit: covered("some"), evidenceFull: covered("every"), retrievalMs, warnings,
  };
  return { result, context: assembled };
}

export const failedResult = (error: string): VariantResult => ({ articles: [], chunks: [], context: [], rank: null, contextHit: false, evidenceHit: null, retrievalMs: 0, warnings: [], error });

// ---- 指标 ----

export function hybridMetrics(results: VariantResult[]): HybridMetrics {
  const total = results.length;
  const evidence = results.filter((result) => result.evidenceHit !== null);
  return {
    questions: total,
    hitAt: Object.fromEntries(HIT_KS.map((k) => [String(k), ratio(results.filter((result) => result.rank !== null && result.rank <= k).length, total)])),
    mrr: ratio(results.reduce((sum, result) => sum + (result.rank ? 1 / result.rank : 0), 0), total),
    contextHit: ratio(results.filter((result) => result.contextHit).length, total),
    evidenceHit: evidence.length ? ratio(evidence.filter((result) => result.evidenceHit).length, evidence.length) : null,
    evidenceFull: evidence.length && evidence.every((result) => result.evidenceFull !== undefined) ? ratio(evidence.filter((result) => result.evidenceFull).length, evidence.length) : null,
    evidenceQuestions: evidence.length,
    contextChars: total && results.every((result) => result.contextChars !== undefined) ? round(results.reduce((sum, result) => sum + result.contextChars!, 0) / total, 1) : null,
  };
}

/** 对话分组：single 为没有历史，followup 为追问题，with-history 为带历史的其他题目（如换话题）。 */
export const turnGroup = (question: Pick<RunQuestion, "type" | "historyTurns">) => !question.historyTurns ? "single" : question.type === "followup" ? "followup" : "with-history";

export const groupKey: Record<GroupDimension, (question: Pick<RunQuestion, "split" | "type" | "specificity" | "lexicalOverlap" | "historyTurns">) => string> = {
  split: (question) => question.split,
  type: (question) => question.type,
  specificity: (question) => question.specificity ?? "unknown",
  overlap: (question) => overlapBucket(question.lexicalOverlap),
  turn: turnGroup,
};

/** 参与指标的题目：未因语料变化排除，查询 Embedding 与该变体的检索都成功。 */
export function evaluatedResults(questions: RunQuestion[], variant: RetrievalVariant): Array<[RunQuestion, VariantResult]> {
  return questions.flatMap((question) => {
    const result = question.results[variant];
    return !question.excluded && !question.error && result && !result.error ? [[question, result] as [RunQuestion, VariantResult]] : [];
  });
}

function groupedMetrics(pairs: Array<[RunQuestion, VariantResult]>, dimension: GroupDimension): Record<string, HybridMetrics> {
  const groups = new Map<string, VariantResult[]>();
  for (const [question, result] of pairs) {
    const key = groupKey[dimension](question);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, results]) => [key, hybridMetrics(results)]));
}

export function summarizeVariant(questions: RunQuestion[], variant: RetrievalVariant): VariantSummary {
  const included = questions.filter((question) => !question.excluded);
  const pairs = evaluatedResults(questions, variant);
  const results = pairs.map(([, result]) => result);
  const latencies = results.map((result) => result.retrievalMs);
  return {
    overall: hybridMetrics(results),
    groups: Object.fromEntries(GROUP_DIMENSIONS.map((dimension) => [dimension, groupedMetrics(pairs, dimension)])) as VariantSummary["groups"],
    reliability: {
      evaluated: results.length,
      excluded: questions.length - included.length,
      errors: included.length - results.length,
      degraded: results.filter((result) => result.warnings.length).length,
      shallowRanking: results.filter((result) => result.articles.length < MIN_RANKED_ARTICLES).length,
    },
    latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  };
}

/** 带历史题目的改写统计（未因语料变化排除的题目）。 */
export function summarizeRewrite(questions: RunQuestion[], mode: RewriteMode): RewriteSummary {
  const rewritten = questions.filter((question) => !question.excluded && question.rewrite);
  const recall = new Map<string, number[]>();
  for (const question of rewritten) {
    const value = question.rewrite!.standaloneRecall;
    if (typeof value === "number") recall.set(turnGroup(question), [...(recall.get(turnGroup(question)) ?? []), value]);
  }
  const times = rewritten.flatMap((question) => question.rewrite!.ms === undefined ? [] : [question.rewrite!.ms]);
  return {
    mode,
    questions: rewritten.length,
    failures: rewritten.filter((question) => question.rewrite!.failed).length,
    latency: { p50: percentile(times, 0.5), p95: percentile(times, 0.95) },
    standaloneRecall: Object.fromEntries([...recall].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, round(values.reduce((sum, value) => sum + value, 0) / values.length)])),
    usage: {
      promptTokens: rewritten.reduce((sum, question) => sum + (question.rewrite!.promptTokens ?? 0), 0),
      completionTokens: rewritten.reduce((sum, question) => sum + (question.rewrite!.completionTokens ?? 0), 0),
    },
  };
}

// ---- 对比 ----

export interface MetricsDelta {
  hitAt: Record<string, number>;
  mrr: number;
  contextHit: number;
  evidenceHit: number | null;
  evidenceFull: number | null;
  /** 平均字数之差。 */
  contextChars: number | null;
}

export interface RankMove {
  id: string;
  question: string;
  from: number | null;
  to: number | null;
}

export interface RunComparison {
  variants: [RetrievalVariant, RetrievalVariant];
  /** 两次运行都有效的题数。 */
  questions: number;
  a: HybridMetrics;
  b: HybridMetrics;
  delta: MetricsDelta;
  groups: Record<"type" | "specificity" | "turn", Record<string, { a: HybridMetrics; b: HybridMetrics; delta: MetricsDelta }>>;
  ranks: { improved: number; worsened: number; unchanged: number };
  moves: { enteredTop5: RankMove[]; leftTop5: RankMove[]; enteredTop10: RankMove[]; leftTop10: RankMove[] };
  /** 证据命中由否变是（gained）与由是变否（lost）的题目，名次为两次运行中来源文章的名次。 */
  evidence: { gained: RankMove[]; lost: RankMove[] };
}

export function metricsDelta(a: HybridMetrics, b: HybridMetrics): MetricsDelta {
  return {
    hitAt: Object.fromEntries(Object.keys(a.hitAt).filter((k) => k in b.hitAt).map((k) => [k, round(b.hitAt[k] - a.hitAt[k])])),
    mrr: round(b.mrr - a.mrr),
    contextHit: round(b.contextHit - a.contextHit),
    evidenceHit: a.evidenceHit === null || b.evidenceHit === null ? null : round(b.evidenceHit - a.evidenceHit),
    evidenceFull: a.evidenceFull === null || b.evidenceFull === null ? null : round(b.evidenceFull - a.evidenceFull),
    contextChars: a.contextChars === null || b.contextChars === null ? null : round(b.contextChars - a.contextChars, 1),
  };
}

/** 数据集名称、版本或划分不同的运行不能对比（抛出）；语料快照不同时返回警告。 */
export function comparisonWarnings(a: RunRecord, b: RunRecord): string[] {
  if (a.dataset.name !== b.dataset.name || a.dataset.version !== b.dataset.version) {
    throw new Error(`Datasets differ: ${a.dataset.name}@${a.dataset.version} vs ${b.dataset.name}@${b.dataset.version}`);
  }
  if (a.dataset.split !== b.dataset.split) throw new Error(`Splits differ: ${a.dataset.split} vs ${b.dataset.split}`);
  const warnings: string[] = [];
  if (a.corpus.fingerprint !== b.corpus.fingerprint) warnings.push("两次运行的语料快照不同，指标受语料变化影响，只比较两边都有效的题目。");
  if (a.incomplete || b.incomplete) warnings.push("至少一次运行的向量化覆盖率不足 100%，结果不完整。");
  return warnings;
}

/** 只比较两次运行都有效的题目；名次 null 视为排在最后。 */
export function compareRuns(a: RunRecord, b: RunRecord, variantA: RetrievalVariant, variantB: RetrievalVariant = variantA): RunComparison {
  const resultsB = new Map(evaluatedResults(b.questions, variantB).map(([question, result]) => [question.id, result]));
  const pairs = evaluatedResults(a.questions, variantA).flatMap(([question, result]) => {
    const other = resultsB.get(question.id);
    return other ? [{ question, a: result, b: other }] : [];
  });
  const compare = (items: typeof pairs) => {
    const metricsA = hybridMetrics(items.map((item) => item.a));
    const metricsB = hybridMetrics(items.map((item) => item.b));
    return { a: metricsA, b: metricsB, delta: metricsDelta(metricsA, metricsB) };
  };
  const grouped = (dimension: "type" | "specificity" | "turn") => {
    const groups = new Map<string, typeof pairs>();
    for (const item of pairs) {
      const key = groupKey[dimension](item.question);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return Object.fromEntries([...groups].sort(([x], [y]) => x.localeCompare(y)).map(([key, items]) => [key, compare(items)]));
  };
  const position = (rank: number | null) => rank ?? Number.POSITIVE_INFINITY;
  const moves: RunComparison["moves"] = { enteredTop5: [], leftTop5: [], enteredTop10: [], leftTop10: [] };
  const evidence: RunComparison["evidence"] = { gained: [], lost: [] };
  const ranks = { improved: 0, worsened: 0, unchanged: 0 };
  for (const item of pairs) {
    const from = position(item.a.rank);
    const to = position(item.b.rank);
    ranks[to < from ? "improved" : to > from ? "worsened" : "unchanged"] += 1;
    const move = { id: item.question.id, question: item.question.question, from: item.a.rank, to: item.b.rank };
    for (const k of [5, 10] as const) {
      if (from > k && to <= k) moves[`enteredTop${k}`].push(move);
      if (from <= k && to > k) moves[`leftTop${k}`].push(move);
    }
    if (item.a.evidenceHit === false && item.b.evidenceHit === true) evidence.gained.push(move);
    if (item.a.evidenceHit === true && item.b.evidenceHit === false) evidence.lost.push(move);
  }
  return { variants: [variantA, variantB], questions: pairs.length, ...compare(pairs), groups: { type: grouped("type"), specificity: grouped("specificity"), turn: grouped("turn") }, ranks, moves, evidence };
}
