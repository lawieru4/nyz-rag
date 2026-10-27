import type { ChatFallbackReason, ChatStatsSummary } from "@nyz-rag/types";

export const STATS_RANGES = [7, 14, 30, 90] as const;

export const fallbackReasonLabels: Record<ChatFallbackReason, string> = {
  no_chat_model: "未配置 Chat 模型",
  no_context: "没有召回片段",
  model_error: "模型调用失败",
  citation_rejected: "引用校验未通过",
  empty_answer: "模型返回空回答",
};

/** 百分比保留一位小数；分母为 0 时为「—」。 */
export const percent = (part: number, whole: number) => whole ? `${(part / whole * 100).toFixed(1)}%` : "—";

/** 1 秒以下显示毫秒，否则显示秒（一位小数）；没有数据时为「—」。 */
export const duration = (ms: number | null) => ms === null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;

/** 各降级原因（含未记录原因的历史问答），按次数从多到少，只列出出现过的。 */
export function fallbackBreakdown(summary: ChatStatsSummary): Array<{ label: string; count: number; share: string }> {
  const entries = Object.entries(summary.fallbacks).map(([reason, count]) => ({ label: fallbackReasonLabels[reason as ChatFallbackReason], count }));
  const unrecorded = summary.extractive - entries.reduce((total, entry) => total + entry.count, 0);
  if (unrecorded > 0) entries.push({ label: "未记录原因（早期问答）", count: unrecorded });
  return entries.filter((entry) => entry.count > 0).sort((a, b) => b.count - a.count)
    .map((entry) => ({ ...entry, share: percent(entry.count, summary.extractive) }));
}

export const answerTokens = (summary: ChatStatsSummary) => summary.promptTokens + summary.completionTokens;
export const rewriteTokens = (summary: ChatStatsSummary) => summary.rewritePromptTokens + summary.rewriteCompletionTokens;
