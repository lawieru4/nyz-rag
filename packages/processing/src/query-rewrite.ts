// 历史感知检索：会话中追问时，先结合最近几轮对话把问题改写为可独立检索的问题，用于召回与 Rerank；回答仍用原问题 + 历史。
// 改写失败、超时或输出不合格时由调用方退回原问题检索，问答不因改写失败而失败。
import type { ChatMessage, ChatModel } from "./models.js";
import type { ModelCapability } from "@nyz-rag/types";
import { usableModel, type ModelSelection } from "./provider.js";
import { HISTORY_TURNS, type ChatTurn } from "./rag.js";

// 送入改写的每轮回答字数、引用文章标题数，改写输出的 Token 上限与超时。
const REWRITE_ANSWER_CHARS = 500;
const REWRITE_SOURCE_TITLES = 5;
export const REWRITE_MAX_TOKENS = 256;
export const REWRITE_TIMEOUT_MS = 8_000;
// 改写结果最多比原问题长出的字数，超出视为模型在回答而非改写。
const REWRITE_EXTRA_CHARS = 200;

const REWRITE_SYSTEM_PROMPT = [
  "你是知识库检索的问题改写器。根据对话历史，把用户的最新问题改写为一个不依赖上下文、可直接用于检索的完整问题。",
  "要求：",
  "- 把代词、省略和指代（如「它」「这种材料」「上述方法」「那……呢」）替换为对话中明确提到的对象，并补全对话中已给出的条件与约束。",
  "- 保留最新问题的原意与限定条件，化学式、数值、单位和专有名词保持原始写法；不要加入对话和问题中都没有的信息。",
  "- 最新问题本身已经完整，或与之前的对话无关（换了话题）时，原样输出最新问题。",
  "- 无法确定指代的对象时，原样输出最新问题，不要猜测。",
  "- 只输出改写后的问题本身，不要回答问题，不要解释，不要加引号或前缀。",
].join("\n");

function historyText(history: ChatTurn[]): string {
  return history.slice(-HISTORY_TURNS).map((turn, index) => {
    const answer = turn.answer.replace(/\s*\[\d+\]/g, "").trim();
    const titles = (turn.sourceTitles ?? []).slice(0, REWRITE_SOURCE_TITLES);
    return [
      `第 ${index + 1} 轮`,
      `用户：${turn.question}`,
      `助手：${answer.length > REWRITE_ANSWER_CHARS ? `${answer.slice(0, REWRITE_ANSWER_CHARS)}……` : answer}`,
      ...(titles.length ? [`参考文章：${titles.map((title) => `《${title}》`).join("、")}`] : []),
    ].join("\n");
  }).join("\n\n");
}

/** 对话历史与最新问题放在同一条用户消息中，避免模型把改写当作对话的延续而直接回答。 */
export function buildRewriteMessages(question: string, history: ChatTurn[]): ChatMessage[] {
  return [
    { role: "system", content: REWRITE_SYSTEM_PROMPT },
    { role: "user", content: `对话历史：\n\n${historyText(history)}\n\n最新问题：${question}` },
  ];
}

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;
const OUTPUT_PREFIX = /^(?:改写后的问题|改写后问题|改写结果|独立问题|检索问题|问题)\s*[:：]\s*/;
// 模型没有改写、而是解释改写任务本身（如「原样输出最新问题，因为无法确定"它"指代的对象」）时的特征说法。
const META_OUTPUT = /原样输出|(?:无需|不需要|无法)改写|最新问题|指代的?对象/;
const QUOTE_PAIRS: Array<[string, string]> = [["「", "」"], ["“", "”"], ["\"", "\""], ["'", "'"], ["《", "》"]];

/** 规范化改写输出：去掉推理块、常见前缀与外层引号；为空、多行、明显过长（模型在回答）或是在解释改写任务时返回 null。 */
export function parseRewrite(output: string, question: string): string | null {
  let text = output.replace(THINK_BLOCK, "").trim().replace(OUTPUT_PREFIX, "").trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) text = text.slice(open.length, -close.length).trim();
  }
  if (!text || /[\r\n]/.test(text) || text.length > question.length + REWRITE_EXTRA_CHARS || META_OUTPUT.test(text)) return null;
  return text;
}

/**
 * 改写使用的模型，问答与评估共用：配置了业务模型「检索问题改写」（rewrite）时用它，温度与最大输出 Token 按其配置；
 * 否则用 Chat 模型，温度取 0 使结果稳定，并限制输出长度。密钥不可用视为未配置，两者都没有时为 null（不改写）。
 */
export function rewriteModelSelection(selections: Pick<Record<ModelCapability, ModelSelection | null>, "chat" | "rewrite">): ModelSelection | null {
  const rewrite = usableModel(selections.rewrite);
  if (rewrite) return rewrite;
  const chat = usableModel(selections.chat);
  return chat ? { ...chat, temperature: 0, maxTokens: REWRITE_MAX_TOKENS } : null;
}

export interface RewriteResult {
  /** 改写后的问题；输出不合格时为 null。 */
  query: string | null;
  /** 供应商返回的用量；没有返回时省略。 */
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * 调用 Chat 模型改写追问；没有历史时不调用模型，返回原问题。
 * 模型调用失败（含限流 AdmissionError）原样抛出，由调用方决定降级或报错。
 */
export async function rewriteQuestion(model: ChatModel, question: string, history: ChatTurn[], signal?: AbortSignal): Promise<RewriteResult> {
  if (!history.length) return { query: question };
  const timeout = AbortSignal.timeout(REWRITE_TIMEOUT_MS);
  let output = "";
  const usage: Omit<RewriteResult, "query"> = {};
  for await (const chunk of model.streamChat(buildRewriteMessages(question, history), { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })) {
    if (chunk.type === "token") output += chunk.text;
    else Object.assign(usage, { promptTokens: chunk.promptTokens, completionTokens: chunk.completionTokens });
  }
  return { query: parseRewrite(output, question), ...usage };
}
