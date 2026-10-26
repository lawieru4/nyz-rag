// 评估中的检索问题：带历史的题目按 --rewrite 选择检索用的问题，llm 方式与问答共用改写提示词和模型参数（query-rewrite.ts）。
// 模型调用由 CLI 注入。方案见 docs/evaluation-plan.md 第 8.10 节。
import { AdmissionError } from "./admission.js";
import type { EvaluationQuestion } from "./evaluation.js";
import type { RewriteResult } from "./query-rewrite.js";
import { HISTORY_TURNS, type ChatTurn } from "./rag.js";
import { searchTerms } from "./search-terms.js";

/**
 * - none：只用当前问题（引入改写前的线上行为）；
 * - concat：最近几轮的问题与当前问题拼接，不调用模型的基线；
 * - llm：与问答相同的模型改写（同样 8 秒超时、不重试），超时、失败或输出不合格时用当前问题（与问答的降级一致），
 *   限流（AdmissionError）与问答一样抛出，由 CLI 重试整道题的改写；
 * - standalone：题目标注的独立问题，作为改写效果的上限。
 * 没有历史的题目在任何方式下都只用当前问题，与问答只在有历史时改写一致。
 */
export const REWRITE_MODES = ["none", "concat", "llm", "standalone"] as const;
export type RewriteMode = (typeof REWRITE_MODES)[number];

export interface QueryOutcome {
  /** 用于召回与 Rerank 的问题。 */
  query: string;
  /** llm：改写耗时，毫秒。 */
  ms?: number;
  /** llm：改写失败或输出不合格的原因，此时 query 为当前问题。 */
  failed?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export const concatQuery = (question: string, history: ChatTurn[]) => [...history.slice(-HISTORY_TURNS).map((turn) => turn.question), question].join(" ");

const round = (value: number) => Math.round(value * 10) / 10;

export async function evaluationQuery(
  question: Pick<EvaluationQuestion, "id" | "question" | "history" | "standalone">, mode: RewriteMode,
  rewrite?: (question: string, history: ChatTurn[]) => Promise<RewriteResult>,
): Promise<QueryOutcome> {
  if (!question.history.length || mode === "none") return { query: question.question };
  if (mode === "concat") return { query: concatQuery(question.question, question.history) };
  if (mode === "standalone") {
    if (!question.standalone?.trim()) throw new Error(`${question.id}: --rewrite=standalone requires the question's standalone field`);
    return { query: question.standalone };
  }
  if (!rewrite) throw new Error("--rewrite=llm requires a chat model");
  const started = performance.now();
  try {
    const { query, ...usage } = await rewrite(question.question, question.history);
    const ms = round(performance.now() - started);
    return query ? { query, ms, ...usage } : { query: question.question, ms, failed: "改写输出不合格", ...usage };
  } catch (error) {
    if (error instanceof AdmissionError) throw error;
    return { query: question.question, ms: round(performance.now() - started), failed: `改写失败：${error instanceof Error ? error.message : "unknown error"}` };
  }
}

/** 独立问题的词项被检索问题保留的比例，衡量改写是否补全了对象、条件与约束；独立问题没有词项时为 null。 */
export function standaloneTermRecall(standalone: string, query: string): number | null {
  const expected = [...new Set(searchTerms(standalone))];
  if (!expected.length) return null;
  const available = new Set(searchTerms(query));
  return Math.round((expected.filter((term) => available.has(term)).length / expected.length) * 10_000) / 10_000;
}
