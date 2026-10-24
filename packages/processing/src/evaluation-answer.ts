// 回答层评估的纯逻辑：引用统计、评审提示与解析、指标汇总与两次运行的对比。
// 检索、模型调用与断点续跑文件由 cli/evaluate-answer.ts 负责。方案见 docs/evaluation-plan.md 第九节。
import type { QuestionType, Specificity, Split } from "./evaluation.js";
import { GROUP_DIMENSIONS, groupKey, percentile, type GroupDimension } from "./evaluation-run.js";
import type { ChatMessage } from "./models.js";

/** 修改评审提示、评分口径或程序统计规则时加一；不同版本的运行不能续跑或对比。 */
export const ANSWER_EVAL_VERSION = 1;

export const JUDGE_CRITERIA = ["faithful", "complete", "citation"] as const;
export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number];

/** 评审按 1～5 分打分，不低于该分计为通过。 */
export const JUDGE_PASS_SCORE = 4;

/** 回答的引用：cited 为回答中出现过的引用编号，invalid 为超出参考资料范围的编号。 */
export interface CitationStats {
  cited: number[];
  invalid: number[];
  /** 来源文章在参考资料中的引用编号；不在上下文中为 null。 */
  sourceCitation: number | null;
  sourceCited: boolean;
}

export interface Judgement {
  /** 各项得分；缺失或不是 1～5 的整数时为 null，不计入均值，按未通过计。 */
  scores: Record<JudgeCriterion, number | null>;
  /** 回答是否表示资料不足、没有给出答案。 */
  refused: boolean;
  analysis: string;
  /** 回答中缺乏参考资料依据的说法。 */
  unsupported: string[];
  /** 参考答案中回答遗漏的要点。 */
  missing: string[];
}

interface Usage { promptTokens: number; completionTokens: number }

/** 一道题的结果，逐行追加到 items.jsonl；同一题以最后一条为准。 */
export interface AnswerItem {
  id: string;
  question: string;
  type: QuestionType;
  specificity?: Specificity;
  split: Split;
  lexicalOverlap?: number;
  sourceArticleKeys: string[];
  at: string;
  /** 因语料变化排除的原因。 */
  excluded?: string;
  retrieval?: {
    /** 来源文章在文章排名中的名次。 */
    rank: number | null;
    contextHit: boolean;
    evidenceHit: boolean | null;
    evidenceFull: boolean | null;
    contextChars: number;
    /** 送入模型的切片与所属文章，按上下文顺序。 */
    context: Array<{ chunkId: string; articleKey: string; citation: number }>;
    /** 送入模型的参考资料正文（referenceText），评审失败时据此重新评审。 */
    references: string;
    retrievalMs: number;
    embeddingMs?: number;
    warnings: string[];
  };
  /** no-context：没有检索到任何切片，不调用模型，回答为固定提示。 */
  answerMode?: "generated" | "no-context";
  answer?: string;
  citations?: CitationStats;
  generation?: { model: string; firstTokenMs: number | null; totalMs: number } & Usage;
  judgement?: Judgement;
  judgeUsage?: Usage;
  /** 调用失败的阶段与原因，下次运行重新处理；judge 阶段失败时保留回答，只重新评审。 */
  error?: { stage: "retrieval" | "generation" | "judge"; message: string };
}

// ---- 引用 ----

// [1]、[1][2]，以及模型偶尔写成的 [1, 2] / [1、2]。
const CITATION = /\[(\d+(?:\s*[,，、]\s*\d+)*)\]/g;

export function citedNumbers(answer: string): number[] {
  const numbers = new Set<number>();
  for (const match of answer.matchAll(CITATION)) for (const value of match[1].split(/\s*[,，、]\s*/)) numbers.add(Number(value));
  return [...numbers].sort((a, b) => a - b);
}

/** sources 按引用编号排列（第 n 项为 [n]），articleKey 为其所属文章。 */
export function citationStats(answer: string, sources: Array<{ articleKey: string }>, sourceArticleKeys: string[]): CitationStats {
  const cited = citedNumbers(answer);
  const index = sources.findIndex((source) => sourceArticleKeys.includes(source.articleKey));
  const sourceCitation = index >= 0 ? index + 1 : null;
  return { cited, invalid: cited.filter((value) => value < 1 || value > sources.length), sourceCitation, sourceCited: sourceCitation !== null && cited.includes(sourceCitation) };
}

// ---- 评审 ----

/**
 * 评审只看问题、参考答案与证据、送入模型的参考资料和回答，不知道上下文的组装方式与模型配置。
 * 忠实度以参考资料为准（不是来源文章全文），完整度以参考答案的要点为准。
 */
export function judgeMessages(input: { question: string; referenceAnswer?: string; evidence: string[]; references: string; answer: string }): ChatMessage[] {
  const system = [
    "你是知识库问答系统的回答评审员。系统先从上千篇能源化学文章中检索出「参考资料」，再由模型依据参考资料回答问题，并用 [n] 标注引用的资料编号。请评审这条回答。",
    "「参考答案」与「证据」来自出题时的一篇来源文章，只用于判断回答是否答到了要点；参考资料里可能有也可能没有这篇文章。",
    "先在 analysis 中逐条核对回答中的事实、数值和结论能否在参考资料中找到依据，再对照参考答案找出遗漏的要点，然后逐项打分，标准从严：",
    "- faithful：回答中的每项事实、数值、结论都有参考资料的依据，没有编造、张冠李戴或超出资料的推断。表示资料不足、未作回答本身不算不忠实；",
    "- complete：回答给出了参考答案的要点。用参考资料中的其他内容给出等价的答案也算完整；回答与参考答案矛盾时最多 2 分；表示资料不足、没有作答时为 1 分；",
    "- citation：引用编号指向的资料确实支持相应的句子，关键结论都有引用。没有任何引用为 1 分；没有作答时按引用是否恰当判断。",
    "每项 1～5 分：5 完全符合；4 基本符合，只有不影响使用的小瑕疵；3 有明显问题；2 大部分不符合；1 完全不符合。",
    "refused：回答是否表示参考资料不足、没有给出答案（只回答了一部分的不算）。",
    "只输出一个 JSON 对象，不要输出其他内容：",
    "{\"analysis\": \"…\", \"scores\": {\"faithful\": 1, \"complete\": 1, \"citation\": 1}, \"refused\": false, \"unsupported\": [\"缺乏依据的说法\"], \"missing\": [\"遗漏的要点\"]}",
  ].join("\n");
  const user = [
    `问题：${input.question}`,
    ...(input.referenceAnswer ? [`参考答案：${input.referenceAnswer}`] : []),
    "证据：",
    ...input.evidence.map((text, index) => `${index + 1}. ${text}`),
    "",
    "参考资料：",
    "",
    input.references,
    "",
    "待评审的回答：",
    input.answer,
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function parseJudgement(value: Record<string, unknown>): Judgement {
  const raw = typeof value.scores === "object" && value.scores !== null ? value.scores as Record<string, unknown> : {};
  const score = (item: unknown) => Number.isInteger(item) && (item as number) >= 1 && (item as number) <= 5 ? item as number : null;
  const list = (key: string) => Array.isArray(value[key]) ? (value[key] as unknown[]).filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
  const scores = Object.fromEntries(JUDGE_CRITERIA.map((key) => [key, score(raw[key])])) as Record<JudgeCriterion, number | null>;
  if (JUDGE_CRITERIA.every((key) => scores[key] === null)) throw new Error("评审输出没有有效的得分");
  return {
    scores,
    refused: value.refused === true,
    analysis: typeof value.analysis === "string" ? value.analysis.trim() : "",
    unsupported: list("unsupported"),
    missing: list("missing"),
  };
}

// ---- 指标 ----

const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;
const ratio = (part: number, total: number) => total ? round(part / total) : null;
const mean = (values: number[], digits = 2) => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, digits) : null;

export interface AnswerMetrics {
  /** 生成了回答的题数（含 no-context），各比例的分母。 */
  questions: number;
  contextHit: number | null;
  evidenceHit: number | null;
  /** 回答中至少有一个引用。 */
  hasCitation: number | null;
  /** 回答中出现超出参考资料范围的引用编号。 */
  invalidCitation: number | null;
  /** 来源文章被引用的比例：分母为全部题目，以及来源文章在上下文中的题目。 */
  sourceCited: number | null;
  sourceCitedInContext: number | null;
  contextHitQuestions: number;
  /** 已评审的题数，以下各项的分母。 */
  judged: number;
  scores: Record<JudgeCriterion, number | null>;
  /** 得分不低于 JUDGE_PASS_SCORE 的比例。 */
  pass: Record<JudgeCriterion, number | null>;
  refused: number | null;
}

/** 参与指标的题目：未排除、没有调用失败、已生成回答。 */
export const answeredItems = (items: AnswerItem[]) => items.filter((item) => !item.excluded && !item.error && item.answer !== undefined && item.retrieval);

export function answerMetrics(items: AnswerItem[]): AnswerMetrics {
  const answered = answeredItems(items);
  const inContext = answered.filter((item) => item.retrieval!.contextHit);
  const evidence = answered.filter((item) => item.retrieval!.evidenceHit !== null);
  const judged = answered.filter((item) => item.judgement);
  const criterion = (key: JudgeCriterion) => judged.map((item) => item.judgement!.scores[key]);
  return {
    questions: answered.length,
    contextHit: ratio(inContext.length, answered.length),
    evidenceHit: ratio(evidence.filter((item) => item.retrieval!.evidenceHit).length, evidence.length),
    hasCitation: ratio(answered.filter((item) => item.citations?.cited.length).length, answered.length),
    invalidCitation: ratio(answered.filter((item) => item.citations?.invalid.length).length, answered.length),
    sourceCited: ratio(answered.filter((item) => item.citations?.sourceCited).length, answered.length),
    sourceCitedInContext: ratio(inContext.filter((item) => item.citations?.sourceCited).length, inContext.length),
    contextHitQuestions: inContext.length,
    judged: judged.length,
    scores: Object.fromEntries(JUDGE_CRITERIA.map((key) => [key, mean(criterion(key).filter((value): value is number => value !== null))])) as AnswerMetrics["scores"],
    pass: Object.fromEntries(JUDGE_CRITERIA.map((key) => [key, ratio(criterion(key).filter((value) => (value ?? 0) >= JUDGE_PASS_SCORE).length, judged.length)])) as AnswerMetrics["pass"],
    refused: ratio(judged.filter((item) => item.judgement!.refused).length, judged.length),
  };
}

export interface AnswerSummary {
  overall: AnswerMetrics;
  groups: Record<GroupDimension, Record<string, AnswerMetrics>>;
  reliability: { total: number; excluded: number; errors: number; noContext: number; degraded: number };
  /** 生成：每题平均输入/输出 Token，首 Token 与总耗时（不含检索）。 */
  generation: { promptTokens: number | null; completionTokens: number | null; firstTokenMs: { p50: number | null; p95: number | null }; totalMs: { p50: number | null; p95: number | null } };
  retrievalMs: { p50: number | null; p95: number | null };
  contextChars: number | null;
  /** Token 合计，用于估算费用。 */
  usage: { generate: Usage; judge: Usage };
}

const latency = (values: number[]) => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95) });
const sumUsage = (values: Array<Usage | undefined>): Usage => ({
  promptTokens: values.reduce((sum, value) => sum + (value?.promptTokens ?? 0), 0),
  completionTokens: values.reduce((sum, value) => sum + (value?.completionTokens ?? 0), 0),
});

export function summarizeAnswers(items: AnswerItem[]): AnswerSummary {
  const included = items.filter((item) => !item.excluded);
  const answered = answeredItems(items);
  const generated = answered.flatMap((item) => item.generation ? [item.generation] : []);
  const groups = Object.fromEntries(GROUP_DIMENSIONS.map((dimension) => {
    const buckets = new Map<string, AnswerItem[]>();
    for (const item of answered) buckets.set(groupKey[dimension](item), [...(buckets.get(groupKey[dimension](item)) ?? []), item]);
    return [dimension, Object.fromEntries([...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([key, bucket]) => [key, answerMetrics(bucket)]))];
  })) as AnswerSummary["groups"];
  return {
    overall: answerMetrics(items),
    groups,
    reliability: {
      total: items.length,
      excluded: items.length - included.length,
      errors: included.filter((item) => item.error).length,
      noContext: answered.filter((item) => item.answerMode === "no-context").length,
      degraded: answered.filter((item) => item.retrieval!.warnings.length).length,
    },
    generation: {
      promptTokens: mean(generated.map((item) => item.promptTokens), 0),
      completionTokens: mean(generated.map((item) => item.completionTokens), 0),
      firstTokenMs: latency(generated.flatMap((item) => item.firstTokenMs === null ? [] : [item.firstTokenMs])),
      totalMs: latency(generated.map((item) => item.totalMs)),
    },
    retrievalMs: latency(answered.map((item) => item.retrieval!.retrievalMs)),
    contextChars: mean(answered.map((item) => item.retrieval!.contextChars), 0),
    usage: { generate: sumUsage(items.map((item) => item.generation)), judge: sumUsage(items.map((item) => item.judgeUsage)) },
  };
}

// ---- 对比 ----

export interface AnswerChange {
  id: string;
  question: string;
  from: number | null;
  to: number | null;
}

export interface AnswerComparison {
  /** 两次运行都已评审的题数。 */
  questions: number;
  a: AnswerSummary;
  b: AnswerSummary;
  /** 各评审项由通过变为未通过（lost）与由未通过变为通过（gained）的题目，from / to 为两次的得分。 */
  changes: Record<JudgeCriterion, { gained: AnswerChange[]; lost: AnswerChange[] }>;
  /** 来源文章由未被引用变为被引用（gained）与相反（lost）的题目，from / to 为来源文章在上下文中的引用编号。 */
  sourceCited: { gained: AnswerChange[]; lost: AnswerChange[] };
}

/** 只比较两次运行都已评审的题目，两边的指标都在这些题目上重新计算。 */
export function compareAnswerRuns(a: AnswerItem[], b: AnswerItem[]): AnswerComparison {
  const judged = (items: AnswerItem[]) => new Map(answeredItems(items).filter((item) => item.judgement).map((item) => [item.id, item]));
  const left = judged(a);
  const right = judged(b);
  const ids = [...left.keys()].filter((id) => right.has(id));
  const pairs = ids.map((id) => [left.get(id)!, right.get(id)!] as const);
  const passed = (item: AnswerItem, key: JudgeCriterion) => (item.judgement!.scores[key] ?? 0) >= JUDGE_PASS_SCORE;
  const changes = Object.fromEntries(JUDGE_CRITERIA.map((key) => {
    const change = (x: AnswerItem, y: AnswerItem) => ({ id: x.id, question: x.question, from: x.judgement!.scores[key], to: y.judgement!.scores[key] });
    return [key, {
      gained: pairs.filter(([x, y]) => !passed(x, key) && passed(y, key)).map(([x, y]) => change(x, y)),
      lost: pairs.filter(([x, y]) => passed(x, key) && !passed(y, key)).map(([x, y]) => change(x, y)),
    }];
  })) as AnswerComparison["changes"];
  const cited = (x: AnswerItem, y: AnswerItem) => ({ id: x.id, question: x.question, from: x.citations?.sourceCitation ?? null, to: y.citations?.sourceCitation ?? null });
  return {
    questions: ids.length,
    a: summarizeAnswers(pairs.map(([x]) => x)),
    b: summarizeAnswers(pairs.map(([, y]) => y)),
    changes,
    sourceCited: {
      gained: pairs.filter(([x, y]) => !x.citations?.sourceCited && y.citations?.sourceCited).map(([x, y]) => cited(x, y)),
      lost: pairs.filter(([x, y]) => x.citations?.sourceCited && !y.citations?.sourceCited).map(([x, y]) => cited(x, y)),
    },
  };
}
