// 文章派生合成评估题的纯逻辑：分层抽样、题型与具体度分配、生成/审核提示、模型输出解析与程序校验。
// 模型调用、数据库与断点续跑文件由 cli/evaluate-generate.ts 负责。方案见 docs/evaluation-plan.md 第三～五节。
import { createHash } from "node:crypto";
import type { ArticleMetadata } from "@nyz-rag/types";
import { normalizeEvidenceText, type Specificity } from "./evaluation.js";
import type { ChatMessage } from "./models.js";
import { metadataSearchFields, normalizeSearchText, searchTerms } from "./search-terms.js";

/** 修改生成或审核提示、校验规则时加一，写入工作文件与冻结的数据集。 */
export const SYNTHETIC_PROMPT_VERSION = 2;
export const MAX_GENERATION_ATTEMPTS = 3;
export const MIN_ARTICLE_LENGTH = 300;
/** 样本不足该篇数的栏目合并为「其他」。 */
export const MIN_CATEGORY_SIZE = 20;
const MAX_PROMPT_CONTENT = 30_000;

export const SYNTHETIC_TYPES = ["fact", "mechanism", "metadata", "term"] as const;
export type SyntheticType = (typeof SYNTHETIC_TYPES)[number];

/** 题型目标占比；按顺序分配，条件受限的题型先分。 */
const TYPE_SHARES: Array<[SyntheticType, number]> = [["metadata", 0.2], ["term", 0.15], ["mechanism", 0.25]];

/** 词面重叠率上限：问题词项中出现在「证据 + 标题」里的比例。 */
export const OVERLAP_LIMITS: Record<Specificity, number> = { low: 0.5, high: 0.8 };
export const DUPLICATE_JACCARD = 0.6;

export interface CorpusArticle {
  articleKey: string;
  title: string;
  category: string | null;
  content: string;
  metadata: ArticleMetadata | null;
  contentHash: string | null;
}

export interface SampleTarget {
  articleKey: string;
  stratum: string;
  type: SyntheticType;
  specificity: Specificity;
}

export interface GeneratedQuestion {
  question: string;
  answer: string;
  evidence: string[];
  type: SyntheticType;
  specificity: Specificity;
}

export const REVIEW_CRITERIA = ["standalone", "supported", "faithful", "specific", "distinctive", "natural"] as const;
export type ReviewCriterion = (typeof REVIEW_CRITERIA)[number];

export interface ReviewResult {
  passed: boolean;
  criteria: Record<ReviewCriterion, boolean>;
  reason: string;
}

const seededRank = (seed: string | number, key: string) => createHash("sha256").update(`${seed}:${key}`).digest("hex");
const byRank = (seed: string | number) => (a: string, b: string) => {
  const [x, y] = [seededRank(seed, a), seededRank(seed, b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

// ---- 抽样 ----

export const eligibleForSample = (article: CorpusArticle) => normalizeEvidenceText(article.content).length >= MIN_ARTICLE_LENGTH;

/** 层：栏目（小栏目合并为「其他」）+ 科研栏目内是否识别出期刊 + 正文长度三分位。 */
export function strataFor(articles: CorpusArticle[]): Map<string, string> {
  const categoryCounts = new Map<string, number>();
  for (const article of articles) categoryCounts.set(article.category ?? "", (categoryCounts.get(article.category ?? "") ?? 0) + 1);
  const lengths = articles.map((article) => article.content.length).sort((a, b) => a - b);
  const cut = (fraction: number) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * fraction))] ?? 0;
  const [first, second] = [cut(1 / 3), cut(2 / 3)];
  return new Map(articles.map((article) => {
    const category = article.category && (categoryCounts.get(article.category) ?? 0) >= MIN_CATEGORY_SIZE ? article.category : "其他";
    const journal = category === "科研" ? (article.metadata?.titleMeta?.journal ? "/期刊" : "/非期刊") : "";
    const length = article.content.length < first ? "短" : article.content.length < second ? "中" : "长";
    return [article.articleKey, `${category}${journal}/${length}`];
  }));
}

/**
 * 按层比例分配（最大余数法），层内按种子哈希取样；结果整体按种子哈希排序，取前 N 篇（试点）时各层大致按比例出现。
 * 输入应已排除不适合出题的文章（eligibleForSample）。
 */
export function stratifiedSample(articles: CorpusArticle[], size: number, seed: string | number): Array<{ articleKey: string; stratum: string }> {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Sample size must be a positive integer");
  const strata = strataFor(articles);
  const groups = new Map<string, string[]>();
  for (const article of articles) {
    const stratum = strata.get(article.articleKey)!;
    groups.set(stratum, [...(groups.get(stratum) ?? []), article.articleKey]);
  }
  const total = articles.length;
  const target = Math.min(size, total);
  const quotas = [...groups].map(([stratum, keys]) => {
    const exact = (target * keys.length) / total;
    return { stratum, keys, quota: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remaining = target - quotas.reduce((sum, item) => sum + item.quota, 0);
  for (const item of [...quotas].sort((a, b) => b.remainder - a.remainder || (a.stratum < b.stratum ? -1 : 1))) {
    if (remaining <= 0) break;
    if (item.quota < item.keys.length) { item.quota += 1; remaining -= 1; }
  }
  const selected = quotas.flatMap(({ stratum, keys, quota }) => [...keys].sort(byRank(seed)).slice(0, quota).map((articleKey) => ({ articleKey, stratum })));
  const order = byRank(`${seed}:order`);
  return selected.sort((a, b) => order(a.articleKey, b.articleKey));
}

// ---- 题型与具体度 ----

/** 可作为元数据题线索的字段：期刊、标题中的机构、项目名称/负责人/承担单位。 */
export function metadataClues(metadata: ArticleMetadata | null): string[] {
  const title = metadata?.titleMeta;
  const project = metadata?.projectMeta;
  return [title?.journal, title?.journalAbbreviation, ...(title?.institutions ?? []), project?.name, project?.principal, project?.institution]
    .filter((value): value is string => Boolean(value?.trim()));
}

/** 正文含化学式、带编号的晶面/型号或英文缩写时可出术语题。 */
export const hasTechnicalTerms = (content: string) => /[A-Z][a-z]?[0-9]|[A-Z]{2,}|[A-Za-z]\([0-9]{3}\)/.test(content.normalize("NFKC"));

/**
 * 先为条件受限的题型（元数据、术语）按种子顺序挑选符合条件的文章，再分配机制题，其余为事实题。
 * 元数据题与术语题本身依赖原文专有名词，具体度固定为 high；事实题与机制题一半为 low。
 */
export function assignTargets(sample: Array<{ articleKey: string; stratum: string }>, articles: Map<string, CorpusArticle>, seed: string | number): SampleTarget[] {
  const types = new Map<string, SyntheticType>();
  const order = sample.map((item) => item.articleKey).sort(byRank(`${seed}:type`));
  const eligible: Record<SyntheticType, (article: CorpusArticle) => boolean> = {
    metadata: (article) => metadataClues(article.metadata).length > 0,
    term: (article) => hasTechnicalTerms(article.content),
    mechanism: () => true,
    fact: () => true,
  };
  for (const [type, share] of TYPE_SHARES) {
    let quota = Math.round(sample.length * share);
    for (const key of order) {
      if (quota <= 0) break;
      if (types.has(key) || !eligible[type](articles.get(key)!)) continue;
      types.set(key, type);
      quota -= 1;
    }
  }
  const flexible = order.filter((key) => !types.has(key) || types.get(key) === "mechanism").sort(byRank(`${seed}:specificity`));
  const low = new Set(flexible.filter((_, index) => index % 2 === 0));
  return sample.map(({ articleKey, stratum }) => ({ articleKey, stratum, type: types.get(articleKey) ?? "fact", specificity: low.has(articleKey) ? "low" : "high" }));
}

// ---- 提示 ----

const TYPE_GUIDES: Record<SyntheticType, string> = {
  fact: "事实题：询问文章中的具体事实，例如实测数值、结论、方法或实验条件。",
  mechanism: "机制题：询问机制、原因或作用，即「为什么」「如何起作用」。",
  metadata: "元数据题：以文章的机构、期刊、项目或负责人为线索，询问该研究的内容或结论；问题中必须包含至少一项「线索」中的名称（可以简写），答案仍来自正文。",
  term: "术语题：围绕正文中的一个化学式、材料名或专有术语提问，问题中必须原样包含这个术语。",
};

const SPECIFICITY_GUIDES: Record<Specificity, string> = {
  high: "具体度 high：可以使用原文中的材料名、化学式等专有名词，但不得照抄原文句子。",
  low: "具体度 low：模拟不了解原文措辞的提问者，用该领域的通用说法提问（如「钠离子电池」「硬碳负极」「储能电站」），不出现这篇文章特有的材料缩写、化学式、产品型号、机构名、人名和具体数值；要自然直白，不要为了回避名称写成谜语式的描述（如「一位长期研究某领域的教授」「借助某种流体的工艺」）。问题仍须能由这篇文章明确回答。",
};

/** 提示中的元数据：期刊、标题中的机构、项目字段与关键词。 */
function articleHeader(article: CorpusArticle): string {
  const fields = metadataSearchFields(article.metadata);
  const lines = [`标题：${article.title}`];
  if (article.category) lines.push(`栏目：${article.category}`);
  if (fields.journal) lines.push(`期刊：${fields.journal.replace(/\n/g, " / ")}`);
  if (fields.titleInstitutions) lines.push(`标题中的机构：${fields.titleInstitutions.replace(/\n/g, "、")}`);
  if (fields.projectName) lines.push(`项目名称：${fields.projectName}`);
  if (fields.principal) lines.push(`项目负责人：${fields.principal}`);
  if (fields.institution) lines.push(`承担单位：${fields.institution}`);
  if (fields.keywords) lines.push(`关键词：${fields.keywords.replace(/\n/g, "、")}`);
  return lines.join("\n");
}

const articleBody = (article: CorpusArticle) => article.content.length > MAX_PROMPT_CONTENT ? `${article.content.slice(0, MAX_PROMPT_CONTENT)}\n（正文过长，以下省略）` : article.content;

export function generationMessages(article: CorpusArticle, target: SampleTarget, feedback: string[] = []): ChatMessage[] {
  const system = [
    "你为能源化学文章知识库编写检索评估题。根据给定的一篇文章写一道问题，并给出参考答案和原文证据。",
    "要求：",
    "1. 问题能独立理解：不出现「本文」「该研究」「上述」「作者」「文中」等指代，读者不看文章也知道在问什么；",
    "2. 问题不照抄标题或证据句，不把答案写进问题；",
    "3. 问题指向这篇文章特有的内容（这项研究、产品、专利、报告或人物的具体数据、方法与结论），不问教科书通识或多数文章都会提到的常识（如某材料的理论容量、某溶剂的常规用量）；也不问「这篇文章讲了什么」这类概括性问题；",
    "4. 问题像业务人员在知识库中实际会问的问题，长度 10～60 字，只问一件事；",
    "5. 问题必须由这篇文章明确回答，答案唯一、可核对；不在问题中使用专利号、DOI、文章编号等用户通常不知道的标识符；",
    "6. evidence 为 1～3 段逐字摘自正文的原文（元数据题也可以摘自「线索」），每段不超过 200 字，不改写、不省略、不拼接；",
    "7. answer 只依据 evidence 作答，不补充原文没有的内容，不超过 150 字。",
    "只输出一个 JSON 对象，不要输出其他内容：",
    "{\"question\": \"…\", \"answer\": \"…\", \"evidence\": [\"…\"], \"type\": \"fact|mechanism|metadata|term\", \"specificity\": \"high|low\"}",
  ].join("\n");
  const user = [
    `目标题型：${target.type}。${TYPE_GUIDES[target.type]}`,
    SPECIFICITY_GUIDES[target.specificity],
    `文章不适合目标题型时，type 改为 "fact"，具体度仍为 ${target.specificity}。`,
    ...(feedback.length ? ["", "上一次生成的题目未通过检查，请重新写一道，避免以下问题：", ...feedback.map((item) => `- ${item}`)] : []),
    "",
    target.type === "metadata" ? `线索：${metadataClues(article.metadata).join("；")}` : "",
    articleHeader(article),
    "",
    "正文：",
    articleBody(article),
  ].filter((line, index, lines) => line !== "" || lines[index - 1] !== "").join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function reviewMessages(article: CorpusArticle, generated: GeneratedQuestion): ChatMessage[] {
  const system = [
    "你是检索评估集的审核员，判断一道根据文章生成的问题是否合格。逐项判断，标准从严：",
    "- standalone：不看文章也能理解问题在问什么，没有「本文」「该研究」等指代或缺失的上下文；",
    "- supported：evidence 足以支持 answer；",
    "- faithful：answer 没有编造或超出原文的推断，与正文一致；",
    "- specific：问题有明确、唯一、可核对的答案，不是开放式讨论；",
    "- distinctive：问题指向这篇文章特有的内容（具体研究、产品、专利或报告中的数据、方法与结论），而不是教科书通识或多数同类文章都能回答的常识；",
    "- natural：措辞像真实业务人员的提问：不是把原文句子改成问句，不是刻意回避名称的谜语式描述，也不含专利号、DOI 等用户通常不知道的标识符。",
    "只输出一个 JSON 对象，不要输出其他内容：",
    "{\"standalone\": true, \"supported\": true, \"faithful\": true, \"specific\": true, \"distinctive\": true, \"natural\": true, \"reason\": \"不合格时说明原因，合格时为空字符串\"}",
  ].join("\n");
  const user = [
    `问题：${generated.question}`,
    `参考答案：${generated.answer}`,
    "证据：",
    ...generated.evidence.map((text, index) => `${index + 1}. ${text}`),
    "",
    articleHeader(article),
    "",
    "正文：",
    articleBody(article),
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

// ---- 解析 ----

/** 取模型输出中的 JSON 对象：去掉思考过程与代码围栏，取第一个 { 到最后一个 }。 */
export function parseModelJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型输出中没有 JSON 对象");
  let value: unknown;
  try {
    value = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("模型输出的 JSON 无法解析");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("模型输出不是 JSON 对象");
  return value as Record<string, unknown>;
}

export function parseGenerated(value: Record<string, unknown>): GeneratedQuestion {
  const text = (key: string) => typeof value[key] === "string" ? (value[key] as string).trim() : "";
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
  return {
    question: text("question"),
    answer: text("answer"),
    evidence,
    type: text("type") as SyntheticType,
    specificity: text("specificity") as Specificity,
  };
}

export function parseReview(value: Record<string, unknown>): ReviewResult {
  const criteria = Object.fromEntries(REVIEW_CRITERIA.map((key) => [key, value[key] === true])) as Record<ReviewCriterion, boolean>;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  return { passed: REVIEW_CRITERIA.every((key) => criteria[key]), criteria, reason };
}

// ---- 程序校验 ----

const PRONOUNS = /本文|该文|该研究|此研究|本研究|该论文|这篇|上述|文中|作者|该团队|该工作|此项研究/;

/** 问题词项中出现在参考文本词项里的比例。 */
export function lexicalOverlap(question: string, reference: string): number {
  const terms = searchTerms(question);
  if (!terms.length) return 0;
  const referenceTerms = new Set(searchTerms(reference));
  return terms.filter((term) => referenceTerms.has(term)).length / terms.length;
}

export function termJaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  const union = left.size + right.size - shared;
  return union ? shared / union : 0;
}

/** 可作为证据来源的文本：正文；元数据题另加标题与线索字段。 */
export function evidenceSource(article: CorpusArticle, type: SyntheticType): string {
  return type === "metadata" ? [article.content, article.title, ...metadataClues(article.metadata)].join("\n") : article.content;
}

// 答案中的小数与 4 位以上整数（不与字母相连），出现在问题里视为泄漏答案。
const answerNumbers = (text: string) => [...normalizeSearchText(text).matchAll(/(?<![a-z0-9.])(\d+\.\d+|\d{4,})(?![a-z0-9])/g)].map((match) => match[1]);

export interface CheckResult {
  failures: string[];
  lexicalOverlap: number;
}

/** 失败原因以「类别：说明」的形式给出，类别用于统计，整句反馈给生成器重试。 */
export function checkGenerated(generated: GeneratedQuestion, article: CorpusArticle, target: SampleTarget, acceptedQuestions: string[][] = []): CheckResult {
  const failures: string[] = [];
  const { question, answer, evidence } = generated;
  const length = [...question].length;
  if (length < 10 || length > 60) failures.push(`问题长度：问题为 ${length} 字，应为 10～60 字`);
  if (!answer || [...answer].length > 300) failures.push("答案长度：答案为空或超过 300 字");
  if (generated.type !== target.type && generated.type !== "fact") failures.push(`题型不符：应为 ${target.type}（不适合时为 fact），实际为 ${generated.type || "空"}`);
  if (generated.specificity !== target.specificity) failures.push(`具体度不符：应为 ${target.specificity}，实际为 ${generated.specificity || "空"}`);
  if (!evidence.length || evidence.length > 3) failures.push("证据数量：证据应为 1～3 段");
  const source = normalizeEvidenceText(evidenceSource(article, target.type === "metadata" || generated.type === "metadata" ? "metadata" : "fact"));
  for (const text of evidence) {
    const normalized = normalizeEvidenceText(text);
    if (normalized.length < 8 || [...normalized].length > 200) failures.push(`证据长度：每段证据应为 8～200 字（「${text.slice(0, 20)}…」）`);
    else if (!source.includes(normalized)) failures.push(`证据不在原文中：证据必须逐字摘自原文，不得改写或拼接（「${text.slice(0, 30)}…」）`);
  }
  if (PRONOUNS.test(question)) failures.push(`指代：问题含有「${question.match(PRONOUNS)![0]}」等指代，无法独立理解`);
  const normalizedQuestion = normalizeEvidenceText(question);
  const normalizedAnswer = normalizeEvidenceText(answer);
  if (normalizedAnswer.length >= 4 && normalizedQuestion.includes(normalizedAnswer)) failures.push("泄漏答案：问题包含了答案");
  else {
    const leaked = answerNumbers(answer).filter((value) => answerNumbers(question).includes(value));
    if (leaked.length) failures.push(`泄漏答案：问题包含答案中的数值 ${leaked.join("、")}`);
  }
  if (target.type === "metadata" && generated.type === "metadata") {
    const clues = metadataClues(article.metadata).map(normalizeEvidenceText);
    if (!clues.some((clue) => normalizedQuestion.includes(clue) || lexicalOverlap(clue, question) >= 0.5)) failures.push("缺少线索：元数据题必须包含期刊、机构、项目或负责人中的至少一项");
  }
  const overlap = lexicalOverlap(question, `${evidence.join("\n")}\n${article.title}`);
  const limit = OVERLAP_LIMITS[target.specificity];
  if (overlap > limit) failures.push(`词面重叠过高：问题与证据和标题的词项重叠率为 ${overlap.toFixed(2)}，应不超过 ${limit}，请换用不同的说法`);
  if (lexicalOverlap(question, article.title) >= 0.8) failures.push("照抄标题：问题与标题过于接近");
  const terms = searchTerms(question);
  if (acceptedQuestions.some((other) => termJaccard(terms, other) >= DUPLICATE_JACCARD)) failures.push("重复：与已通过的题目过于相似");
  return { failures, lexicalOverlap: overlap };
}

/** 失败原因的类别（「：」之前的部分）。 */
export const failureCategory = (failure: string) => failure.split("：", 1)[0];
