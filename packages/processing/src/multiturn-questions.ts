// 多轮追问评估题的纯逻辑：从已冻结的单轮合成题派生「引出对象的第一轮问答 + 用指代或省略追问的第二轮」，
// 生成与审核提示、模型输出解析、程序校验，以及不调用模型的换话题题配对。模型调用与断点续跑文件由 cli/evaluate-multiturn.ts 负责。
// 方案见 docs/evaluation-plan.md 第 8.10 节。
import { createHash } from "node:crypto";
import { normalizeEvidenceText, type EvaluationQuestion } from "./evaluation.js";
import type { ChatMessage } from "./models.js";
import { searchTerms } from "./search-terms.js";
import { answerNumbers, articleHeader, PRONOUNS, type CorpusArticle } from "./synthetic-questions.js";

/** 修改生成或审核提示、校验规则时加一，写入工作文件与冻结的数据集。 */
export const MULTITURN_PROMPT_VERSION = 1;
export const MAX_FOLLOWUP_ATTEMPTS = 3;
const MAX_PROMPT_CONTENT = 4_000;
/** 对象名称的词项出现在追问中的比例达到该值，视为追问没有省略对象。 */
const ENTITY_LEAK = 0.5;

export interface GeneratedFollowup {
  /** 原问题中被追问省略的核心对象，原样摘自原问题。 */
  entity: string;
  /** 第一轮问题：引出对象，不问原问题的内容。 */
  opening: string;
  /** 第一轮回答：依据文章介绍对象，不含原问题的答案。 */
  openingAnswer: string;
  /** 第二轮追问：与原问题问同一件事，用指代或省略代替对象。 */
  followup: string;
}

export const FOLLOWUP_REVIEW_CRITERIA = ["dependent", "resolvable", "equivalent", "natural"] as const;
export type FollowupReviewCriterion = (typeof FOLLOWUP_REVIEW_CRITERIA)[number];
export const FOLLOWUP_REVIEW_PASS_SCORE = 4;

export interface FollowupReview {
  passed: boolean;
  scores: Record<FollowupReviewCriterion, number | null>;
  analysis: string;
  reason: string;
}

// ---- 提示 ----

const baseLines = (base: Pick<EvaluationQuestion, "question" | "answer" | "labels">) => [
  `原问题：${base.question}`,
  ...(base.answer ? [`参考答案：${base.answer}`] : []),
  "证据：",
  ...base.labels.flatMap((label) => label.evidence).map((text, index) => `${index + 1}. ${text}`),
];

export function followupMessages(article: CorpusArticle, base: Pick<EvaluationQuestion, "question" | "answer" | "labels">, feedback: string[] = []): ChatMessage[] {
  const system = [
    "你为能源化学文章知识库的问答系统编写多轮追问评估题。给定一道能独立理解的「原问题」及其来源文章，把它改写成两轮对话，用来检验系统能否结合对话历史理解追问。",
    "要求：",
    "1. entity：原问题中的核心对象（材料、技术、产品、项目、企业、机构或某项研究），逐字摘自原问题，2～30 字；",
    "2. opening：第一轮问题，用户先就这个对象提一个概括性的问题（如「介绍一下……」「……是什么」「……最近有什么进展」），必须原样包含 entity，不涉及原问题询问的具体内容，不出现「本文」「该研究」等指代，不超过 40 字；",
    "3. openingAnswer：第一轮的回答，依据文章用 2～4 句介绍这个对象，必须原样包含 entity，不得给出原问题的答案（包括其中的数值），不超过 200 字；",
    "4. followup：第二轮追问，与原问题问同一件事、答案相同，但把 entity 换成「它」「这种材料」「这项技术」「该项目」等指代，或直接省略（如「那循环寿命呢？」）；不得出现 entity 及其缩写或别名；原问题中的其他条件、时间范围和限定语必须保留；4～60 字，像用户在对话中自然的追问。",
    "只输出一个 JSON 对象，不要输出其他内容：",
    "{\"entity\": \"…\", \"opening\": \"…\", \"openingAnswer\": \"…\", \"followup\": \"…\"}",
  ].join("\n");
  const user = [
    ...baseLines(base),
    ...(feedback.length ? ["", "上一次生成的对话未通过检查，请重新写，避免以下问题：", ...feedback.map((item) => `- ${item}`)] : []),
    "",
    articleHeader(article),
    "",
    "正文（节选）：",
    article.content.length > MAX_PROMPT_CONTENT ? `${article.content.slice(0, MAX_PROMPT_CONTENT)}\n（以下省略）` : article.content,
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** 审核不需要文章正文：只判断追问是否依赖历史、指代能否唯一确定、与原问题是否等价、对话是否自然。 */
export function followupReviewMessages(base: Pick<EvaluationQuestion, "question" | "answer" | "labels">, generated: GeneratedFollowup): ChatMessage[] {
  const system = [
    "你是多轮追问评估题的审核员。这组两轮对话由一道能独立理解的「原问题」改写而来，用于检验问答系统能否结合对话历史理解第二轮的追问。",
    "先在 analysis 中简要分析，再逐项打分，标准从严：",
    "- dependent：只看第二轮追问、不看第一轮时，无法确定在问哪个对象（追问确实依赖对话历史）；",
    "- resolvable：结合第一轮问答，能唯一确定追问指代的对象就是 entity，不会被理解成第一轮回答中提到的其他对象；",
    "- equivalent：结合第一轮问答，追问与原问题问的是同一件事、答案相同，原问题中的条件、时间范围和限定语没有丢失；",
    "- natural：两轮对话的提问顺序与措辞像真实用户；第一轮回答没有提前给出追问的答案。",
    "每项 1～5 分：5 完全符合；4 基本符合，只有不影响使用的小瑕疵；3 有明显问题；2 大部分不符合；1 完全不符合。不确定时给低分。",
    "只输出一个 JSON 对象，不要输出其他内容：",
    "{\"analysis\": \"…\", \"scores\": {\"dependent\": 1, \"resolvable\": 1, \"equivalent\": 1, \"natural\": 1}, \"reason\": \"有低于 4 分的项时说明原因，否则为空字符串\"}",
  ].join("\n");
  const user = [
    ...baseLines(base),
    `核心对象（entity）：${generated.entity}`,
    "",
    `第一轮问题：${generated.opening}`,
    `第一轮回答：${generated.openingAnswer}`,
    `第二轮追问：${generated.followup}`,
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

// ---- 解析 ----

export function parseFollowup(value: Record<string, unknown>): GeneratedFollowup {
  const text = (key: string) => typeof value[key] === "string" ? (value[key] as string).trim() : "";
  return { entity: text("entity"), opening: text("opening"), openingAnswer: text("openingAnswer"), followup: text("followup") };
}

export function parseFollowupReview(value: Record<string, unknown>): FollowupReview {
  const raw = typeof value.scores === "object" && value.scores !== null ? value.scores as Record<string, unknown> : {};
  const score = (item: unknown) => Number.isInteger(item) && (item as number) >= 1 && (item as number) <= 5 ? item as number : null;
  const scores = Object.fromEntries(FOLLOWUP_REVIEW_CRITERIA.map((key) => [key, score(raw[key])])) as Record<FollowupReviewCriterion, number | null>;
  const text = (key: string) => typeof value[key] === "string" ? (value[key] as string).trim() : "";
  return {
    passed: FOLLOWUP_REVIEW_CRITERIA.every((key) => (scores[key] ?? 0) >= FOLLOWUP_REVIEW_PASS_SCORE),
    scores, analysis: text("analysis"), reason: text("reason"),
  };
}

// ---- 程序校验 ----

const length = (text: string) => [...text].length;

/** 失败原因以「类别：说明」的形式给出，类别用于统计，整句反馈给生成器重试。 */
export function checkFollowup(generated: GeneratedFollowup, base: Pick<EvaluationQuestion, "question" | "answer">): string[] {
  const failures: string[] = [];
  const { entity, opening, openingAnswer, followup } = generated;
  const normalized = {
    entity: normalizeEvidenceText(entity), question: normalizeEvidenceText(base.question),
    opening: normalizeEvidenceText(opening), openingAnswer: normalizeEvidenceText(openingAnswer), followup: normalizeEvidenceText(followup),
  };
  if (length(entity) < 2 || length(entity) > 30) failures.push("对象长度：entity 应为 2～30 字");
  else if (!normalized.question.includes(normalized.entity)) failures.push("对象不在原问题中：entity 必须逐字摘自原问题");
  if (!opening || length(opening) > 40) failures.push("第一轮问题长度：opening 为空或超过 40 字");
  else if (normalized.entity && !normalized.opening.includes(normalized.entity)) failures.push("第一轮缺少对象：opening 必须原样包含 entity");
  if (PRONOUNS.test(opening)) failures.push(`第一轮指代：opening 含有「${opening.match(PRONOUNS)![0]}」等指代`);
  if (length(openingAnswer) < 20 || length(openingAnswer) > 300) failures.push("第一轮回答长度：openingAnswer 应为 20～300 字");
  else if (normalized.entity && !normalized.openingAnswer.includes(normalized.entity)) failures.push("第一轮回答缺少对象：openingAnswer 必须原样包含 entity");
  const answer = normalizeEvidenceText(base.answer ?? "");
  if (answer.length >= 4 && normalized.openingAnswer.includes(answer)) failures.push("提前作答：第一轮回答包含了原问题的答案");
  else {
    const leaked = answerNumbers(base.answer ?? "").filter((value) => answerNumbers(openingAnswer).includes(value));
    if (leaked.length) failures.push(`提前作答：第一轮回答包含原问题答案中的数值 ${leaked.join("、")}`);
  }
  if (length(followup) < 4 || length(followup) > 60) failures.push("追问长度：followup 应为 4～60 字");
  if (normalized.followup === normalized.question) failures.push("追问未改写：followup 与原问题相同");
  if (normalized.entity && normalized.followup.includes(normalized.entity)) failures.push("追问含对象：followup 不得出现 entity，应改用指代或省略");
  else {
    const terms = [...new Set(searchTerms(entity))];
    const present = new Set(searchTerms(followup));
    if (terms.length && terms.filter((term) => present.has(term)).length / terms.length >= ENTITY_LEAK) failures.push("追问含对象：followup 与 entity 的词项过于接近，应改用指代或省略");
  }
  return failures;
}

/** 失败原因的类别（「：」之前的部分）。 */
export const followupFailureCategory = (failure: string) => failure.split("：", 1)[0];

// ---- 数据集 ----

const seededRank = (seed: string | number, key: string) => createHash("sha256").update(`${seed}:${key}`).digest("hex");

/** 派生题的处理顺序：按种子哈希排列，只处理前 N 道（--limit）时各题型与划分大致按比例出现。 */
export function followupOrder(questions: EvaluationQuestion[], seed: string | number): EvaluationQuestion[] {
  return [...questions].sort((a, b) => {
    const [x, y] = [seededRank(seed, a.id), seededRank(seed, b.id)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

export interface ApprovedFollowup {
  base: EvaluationQuestion;
  generated: GeneratedFollowup;
}

/** 追问题：答案与标注沿用原问题，原问题作为独立问题（改写的上限与参照）。 */
export function followupQuestion({ base, generated }: ApprovedFollowup): EvaluationQuestion {
  return {
    id: `${base.id}-f`,
    question: generated.followup,
    ...(base.answer ? { answer: base.answer } : {}),
    history: [{ question: generated.opening, answer: generated.openingAnswer }],
    standalone: base.question,
    filters: null,
    type: "followup",
    ...(base.specificity ? { specificity: base.specificity } : {}),
    source: "synthetic",
    split: base.split,
    answerable: true,
    notes: `followup derived from ${base.id}; entity: ${generated.entity}`,
    labels: base.labels,
  };
}

/**
 * 换话题题：当前问题是另一道原问题（完整、独立），历史取自不同来源文章的追问题的第一轮，检验改写不会把旧话题带进检索。
 * 按种子哈希排列后，每道题取下一道（来源文章不同的）题的第一轮作为历史；不调用模型。
 */
export function topicSwitchQuestions(approved: ApprovedFollowup[], seed: string | number): EvaluationQuestion[] {
  const order = [...approved].sort((a, b) => {
    const [x, y] = [seededRank(`${seed}:switch`, a.base.id), seededRank(`${seed}:switch`, b.base.id)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const articles = (item: ApprovedFollowup) => new Set(item.base.labels.map((label) => label.articleKey));
  return order.flatMap((item, index) => {
    const own = articles(item);
    const other = [...order.slice(index + 1), ...order.slice(0, index)].find((candidate) => ![...articles(candidate)].some((key) => own.has(key)));
    if (!other) return [];
    return [{
      ...item.base,
      id: `${item.base.id}-x`,
      history: [{ question: other.generated.opening, answer: other.generated.openingAnswer }],
      standalone: item.base.question,
      notes: `topic switch: history from ${other.base.id}`,
    }];
  });
}
