// 失败题复判的纯逻辑：待复判的文章、复判提示与解析、宽松名次与宽松指标。
// 模型调用、复判缓存与运行记录的读写由 cli/evaluate-adjudicate.ts 负责。方案见 docs/evaluation-plan.md 第 7.3 节。
import {
  EVIDENCE_COVERAGE, evaluatedResults, evidenceCoverage, GROUP_DIMENSIONS, groupKey, HIT_KS, type GroupDimension, type RetrievalVariant, type RunQuestion, type VariantResult,
} from "./evaluation-run.js";
import type { ChatMessage } from "./models.js";
import { articleBody, articleHeader, type CorpusArticle } from "./synthetic-questions.js";

/** 修改复判提示或判定口径时加一；不同版本的复判结论不复用。证据校验在使用结论时按当前规则重新计算，修改它不需要重新复判。 */
export const ADJUDICATION_VERSION = 1;
/** 只复判文章排名的前 10 篇，与 Hit@10 对应。 */
export const ADJUDICATION_DEPTH = 10;

export const VERDICTS = ["yes", "partial", "no"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Adjudication {
  /** yes：能独立回答；partial：相关但只答了一部分或限定条件不符；no：不能回答。 */
  verdict: Verdict;
  /** 依据这篇文章给出的答案。 */
  answer: string;
  evidence: string[];
  /** 至少一段证据能在文章（标题、元数据与正文）中找到，见 verifyEvidence。 */
  verified: boolean;
  analysis: string;
}

/** 运行记录中保存的复判结论，完整分析在复判缓存中。 */
export type AdjudicationVerdict = Pick<Adjudication, "verdict" | "verified">;
/** 题目 ID → 文章 articleKey → 复判结论。 */
export type AdjudicationTable = Record<string, Record<string, AdjudicationVerdict>>;

export interface LenientMetrics {
  questions: number;
  /** 宽松 Hit@K：前 K 篇中有来源文章或复判可回答的文章。 */
  hitAt: Record<string, number>;
  /** 宽松 MRR：来源文章与可回答文章中最靠前者名次的倒数。 */
  mrr: number;
  /** 同一批题目的严格指标，便于并列报告。 */
  strictHitAt: Record<string, number>;
  strictMrr: number;
  /** 可回答的文章排在来源文章之前（宽松名次提前）的题数。 */
  rescued: number;
  /** 仍有待复判文章的题数；不为 0 时宽松指标偏低。 */
  unjudged: number;
}

export interface LenientSummary {
  overall: LenientMetrics;
  groups: Record<GroupDimension, Record<string, LenientMetrics>>;
}

/** 运行记录的 adjudication 字段，由 evaluate:adjudicate 补写。 */
export interface RunAdjudication {
  version: number;
  model: { provider: string; model: string };
  updatedAt: string;
  depth: number;
  /** 已复判的变体；judgements 覆盖这些变体全部待复判文章时 unjudged 为 0。 */
  variants: RetrievalVariant[];
  judgements: AdjudicationTable;
  summary: Partial<Record<RetrievalVariant, LenientSummary>>;
}

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const ratio = (part: number, total: number) => total ? round(part / total) : 0;

/**
 * 证据校验与证据命中（7.2）相同：规范化（NFKC、去空白与标点）后，至少一段证据的字符二元组有 EVIDENCE_COVERAGE 被文章覆盖。
 * 容忍模型摘录时的引号、列表编号与跨行拼接差异，同时排除编造的证据。
 */
export function verifyEvidence(evidence: string[], article: CorpusArticle): boolean {
  const text = `${articleHeader(article)}\n${article.content}`;
  return evidence.some((item) => evidenceCoverage(item, text) >= EVIDENCE_COVERAGE);
}

export const countsAsAnswer = (verdict: AdjudicationVerdict | undefined) => verdict?.verdict === "yes" && verdict.verified;

/** 待复判的文章：排在来源文章之前的文章，最多前 depth 篇；来源文章不在排名中时取前 depth 篇。来源文章排第 1 时没有。 */
export function adjudicationTargets(result: Pick<VariantResult, "articles" | "rank">, depth = ADJUDICATION_DEPTH): string[] {
  return result.articles.slice(0, result.rank === null ? depth : Math.min(result.rank - 1, depth));
}

/** 宽松名次：来源文章与复判可回答的文章中最靠前者的名次；未复判的文章视为不能回答。 */
export function lenientRank(result: Pick<VariantResult, "articles" | "rank">, verdicts: Record<string, AdjudicationVerdict> = {}, depth = ADJUDICATION_DEPTH): number | null {
  const index = adjudicationTargets(result, depth).findIndex((key) => countsAsAnswer(verdicts[key]));
  return index >= 0 ? index + 1 : result.rank;
}

export function lenientMetrics(pairs: Array<[Pick<RunQuestion, "id">, VariantResult]>, table: AdjudicationTable, depth = ADJUDICATION_DEPTH): LenientMetrics {
  const total = pairs.length;
  const ranks = pairs.map(([question, result]) => ({ strict: result.rank, lenient: lenientRank(result, table[question.id], depth) }));
  const hitAt = (pick: "strict" | "lenient") => Object.fromEntries(HIT_KS.map((k) => [String(k), ratio(ranks.filter((rank) => rank[pick] !== null && rank[pick]! <= k).length, total)]));
  const mrr = (pick: "strict" | "lenient") => ratio(ranks.reduce((sum, rank) => sum + (rank[pick] ? 1 / rank[pick]! : 0), 0), total);
  return {
    questions: total,
    hitAt: hitAt("lenient"),
    mrr: mrr("lenient"),
    strictHitAt: hitAt("strict"),
    strictMrr: mrr("strict"),
    rescued: ranks.filter((rank) => rank.lenient !== rank.strict).length,
    unjudged: pairs.filter(([question, result]) => adjudicationTargets(result, depth).some((key) => !table[question.id]?.[key])).length,
  };
}

/** 参与指标的题目与严格指标相同（未排除、未调用失败），按 split / 题型 / 具体度 / 词面重叠分组。 */
export function summarizeLenient(questions: RunQuestion[], variant: RetrievalVariant, table: AdjudicationTable, depth = ADJUDICATION_DEPTH): LenientSummary {
  const pairs = evaluatedResults(questions, variant);
  const groups = Object.fromEntries(GROUP_DIMENSIONS.map((dimension) => {
    const buckets = new Map<string, typeof pairs>();
    for (const pair of pairs) buckets.set(groupKey[dimension](pair[0]), [...(buckets.get(groupKey[dimension](pair[0])) ?? []), pair]);
    return [dimension, Object.fromEntries([...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([key, bucket]) => [key, lenientMetrics(bucket, table, depth)]))];
  })) as LenientSummary["groups"];
  return { overall: lenientMetrics(pairs, table, depth), groups };
}

// ---- 复判提示 ----

/**
 * 复判只看问题与候选文章，不看出题文章的参考答案与证据：其他文章给出不同但切题的答案也算能回答。
 * 判定以问题中的对象、条件与时间范围为准，标准从严；证据由程序校验（verifyEvidence）。
 */
export function adjudicationMessages(question: string, article: CorpusArticle): ChatMessage[] {
  const system = [
    "你是检索评估的复判员。评估题由 AI 根据知识库（上千篇能源化学领域的科研解读、行业周报、企业与人物报道等）中的一篇文章生成，检索系统把另一篇文章排在了出题文章之前。请判断这篇文章能否独立回答该问题：能回答时，这次检索不算失败。",
    "先在 analysis 中逐项核对问题中的对象（材料、器件、企业、人物等）、条件与方法、时间范围等限定能否在文章中找到对应内容，再给出结论，标准从严：",
    "- yes：文章明确给出了问题所问的答案，问题的各项限定都与文章内容相符，读者读完这篇文章就能得到具体、可核对的答案。答案可以与出题文章不同；",
    "- partial：文章与问题相关，但只回答了一部分，或对象、条件、时间范围与问题不完全一致，或只有背景、通识而没有具体答案；",
    "- no：文章不能回答该问题。",
    "answer 为依据这篇文章对问题的回答，不超过 150 字，verdict 为 no 时为空字符串；evidence 为 1～3 段逐字摘自文章（标题、元数据或正文）且直接支持 answer 的原文，每段不超过 200 字，不改写、不省略、不拼接，verdict 为 no 时为空数组。",
    "只输出一个 JSON 对象，不要输出其他内容：",
    "{\"analysis\": \"…\", \"verdict\": \"yes|partial|no\", \"answer\": \"…\", \"evidence\": [\"原文\"]}",
  ].join("\n");
  const user = [`问题：${question}`, "", "候选文章：", articleHeader(article), "", "正文：", articleBody(article)].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function parseAdjudication(value: Record<string, unknown>, article: CorpusArticle): Adjudication {
  const verdict = typeof value.verdict === "string" ? value.verdict.trim().toLowerCase() : "";
  if (!VERDICTS.includes(verdict as Verdict)) throw new Error("复判输出没有有效的 verdict");
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
  return {
    verdict: verdict as Verdict,
    answer: typeof value.answer === "string" ? value.answer.trim() : "",
    evidence,
    verified: verifyEvidence(evidence, article),
    analysis: typeof value.analysis === "string" ? value.analysis.trim() : "",
  };
}
