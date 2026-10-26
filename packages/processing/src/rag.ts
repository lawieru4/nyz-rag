// 混合检索与回答组装：关键词召回 + 向量召回 + 摘要召回（先召回文章、再定位切片）→ RRF 合并去重 → 可选 Rerank → 按上下文长度截取 → 组装带引用编号的 Prompt。
// 数据访问与模型调用通过参数注入，便于单元测试；API 负责接线。
import type { ChatRetrievedChunk, ChatSource, DocumentChunkRecord } from "@nyz-rag/types";
import { embeddingInput } from "./chunking.js";
import { AdmissionError } from "./admission.js";
import type { ChatMessage, RerankResult } from "./models.js";
import { searchTerms } from "./search-terms.js";
import { INSUFFICIENT_EVIDENCE_ANSWER } from "./citations.js";

/** 单路召回命中的切片；score 为该路得分（向量为余弦相似度，关键词为 IDF 之和）。 */
export interface ChunkHit {
  chunkId: string;
  documentId: string;
  /** 所属父块（切片规则 2）。 */
  sectionId?: string;
  title: string;
  url: string;
  repostSource?: string;
  content: string;
  context: string;
  sectionPath: string[];
  contentType: NonNullable<DocumentChunkRecord["contentType"]>;
  score: number;
}

/** 合并后的切片：score 为 RRF 得分，并保留各路原始得分。 */
export interface RetrievedChunk extends Omit<ChunkHit, "score"> {
  score: number;
  vectorScore?: number;
  keywordScore?: number;
  summaryScore?: number;
  rerankScore?: number;
}

export interface RetrievalSettings {
  /** 最终送入模型的切片数。 */
  topK: number;
  /** 向量召回的最低余弦相似度。 */
  similarityThreshold: number;
  rerankEnabled: boolean;
  /** 送入模型的资料正文总字数上限。 */
  maxContextLength: number;
}

export const DEFAULT_RETRIEVAL_SETTINGS: RetrievalSettings = { topK: 5, similarityThreshold: 0.3, rerankEnabled: false, maxContextLength: 6000 };
export const DEFAULT_ANSWER_PROMPT = "你是 NYZ 文章知识库的问答助手，请依据提供的知识库内容回答问题；若资料不足，请明确说明。";
export const NO_MATCH_ANSWER = "知识库中暂未找到与问题直接匹配的内容，请尝试更具体的关键词。";

// 每路召回数（摘要召回按文章计，每篇一个切片）、合并后进入 Rerank 的候选数，以及 RRF 常数。
export const RECALL_LIMIT = 20;
export const SUMMARY_RECALL_LIMIT = 10;
export const CANDIDATE_LIMIT = 30;
const RRF_K = 60;
const MAX_QUERY_TERMS = 64;
const EXCERPT_CHARS = 300;

export interface RetrievalDependencies {
  keywordSearch(terms: string[], limit: number): Promise<ChunkHit[]>;
  /** 未配置 Embedding 时省略，仅用关键词召回。 */
  vectorSearch?(question: string, limit: number): Promise<ChunkHit[]>;
  /** 摘要召回：按文章摘要向量召回文章，每篇返回文章内最相关的一个切片，score 为摘要相似度。未配置 Embedding 时省略。 */
  summarySearch?(question: string, limit: number): Promise<ChunkHit[]>;
  rerank?(query: string, documents: string[], topN: number): Promise<RerankResult[]>;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** 向量检索或 Rerank 失败时的降级说明；关键词检索失败直接抛出。 */
  warnings: string[];
}

const reason = (error: unknown) => error instanceof Error ? error.message : "unknown error";

export async function retrieve(question: string, settings: RetrievalSettings, dependencies: RetrievalDependencies): Promise<RetrievalResult> {
  const warnings: string[] = [];
  const terms = searchTerms(question).slice(0, MAX_QUERY_TERMS);
  const [keywordHits, vectorHits, summaryHits] = await Promise.all([
    terms.length ? dependencies.keywordSearch(terms, RECALL_LIMIT) : [],
    dependencies.vectorSearch
      ? dependencies.vectorSearch(question, RECALL_LIMIT).catch((error: unknown) => { if (error instanceof AdmissionError) throw error; warnings.push(`向量检索失败，仅使用关键词检索：${reason(error)}`); return []; })
      : [],
    dependencies.summarySearch
      ? dependencies.summarySearch(question, SUMMARY_RECALL_LIMIT).catch((error: unknown) => { if (error instanceof AdmissionError) throw error; warnings.push(`摘要检索失败，跳过文章级召回：${reason(error)}`); return []; })
      : [],
  ]);

  // Reciprocal Rank Fusion：各路按名次计 1 / (k + 名次)，同一切片累加。
  // 摘要召回给主题相关文章中的切片加分，也能召回正文措辞与问题差异较大、但摘要概括了主题的文章。
  const fused = new Map<string, RetrievedChunk>();
  const fuse = (hits: ChunkHit[], key: "vectorScore" | "keywordScore" | "summaryScore") => {
    for (const [rank, { score, ...hit }] of hits.entries()) {
      const entry = fused.get(hit.chunkId) ?? { ...hit, score: 0 };
      entry[key] = score;
      entry.score += 1 / (RRF_K + rank + 1);
      fused.set(hit.chunkId, entry);
    }
  };
  fuse(vectorHits.filter((hit) => hit.score >= settings.similarityThreshold), "vectorScore");
  fuse(keywordHits, "keywordScore");
  fuse(summaryHits.filter((hit) => hit.score >= settings.similarityThreshold), "summaryScore");
  let candidates = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, CANDIDATE_LIMIT);

  if (settings.rerankEnabled && dependencies.rerank && candidates.length > 1) {
    try {
      const results = await dependencies.rerank(question, candidates.map((chunk) => embeddingInput({ ...chunk, id: chunk.chunkId, index: 0, tokenEstimate: 0 })), settings.topK);
      candidates = results.map((result) => ({ ...candidates[result.index], rerankScore: result.score }));
    } catch (error) {
      if (error instanceof AdmissionError) throw error;
      warnings.push(`重排序失败，使用合并排序：${reason(error)}`);
    }
  }
  return { chunks: candidates.slice(0, settings.topK), warnings };
}

export interface AnswerContext {
  /**
   * 送入模型的切片（正文可能被截断），citation 为所属文章的引用编号。
   * 按父块组装时每项为一个父块（全文或命中切片附近的内容），字段取排名最高的命中切片，chunkIds 为其中全部命中切片。
   */
  chunks: Array<RetrievedChunk & { citation: number; chunkIds?: string[] }>;
  /** 按引用编号排列的文章。 */
  sources: ChatSource[];
}

/**
 * 按相关度依次选取切片，正文总字数不超过上限（第一个切片超长时截断）；同一文章共用一个引用编号。
 * 来源附带各切片的摘录（与问答记录中保存的摘录一致），供用户端查看引用原文。
 */
export function buildAnswerContext(chunks: RetrievedChunk[], maxContextLength: number): AnswerContext {
  const context: AnswerContext = { chunks: [], sources: [] };
  const citations = new Map<string, number>();
  let used = 0;
  for (const chunk of chunks) {
    const remaining = maxContextLength - used;
    if (remaining <= 0) break;
    if (chunk.content.length > remaining && context.chunks.length) continue;
    const content = chunk.content.slice(0, remaining);
    let citation = citations.get(chunk.documentId);
    if (!citation) {
      citation = citations.size + 1;
      citations.set(chunk.documentId, citation);
      context.sources.push({ documentId: chunk.documentId, title: chunk.title, url: chunk.url, ...(chunk.repostSource ? { repostSource: chunk.repostSource } : {}), excerpts: [] });
    }
    context.sources[citation - 1].excerpts!.push({ sectionPath: chunk.sectionPath, text: content.slice(0, EXCERPT_CHARS) });
    context.chunks.push({ ...chunk, content, citation });
    used += content.length;
  }
  return context;
}

/** 父块正文及其切片（按原文顺序）。 */
export interface SectionContext {
  id: string;
  documentId: string;
  sectionPath: string[];
  content: string;
  chunks: Array<{ id: string; content: string }>;
}

// 父块放不下时，保留命中切片及其前后各一个切片；不相邻的片段之间用省略行分隔。
const SECTION_WINDOW = 1;
const WINDOW_GAP = "\n……\n";

// 选中的切片按原文顺序拼接。
function windowText(section: SectionContext, selected: Set<number>): string {
  let text = "";
  let previous = -2;
  for (const index of [...selected].sort((a, b) => a - b)) {
    text += text ? (index === previous + 1 ? "\n" : WINDOW_GAP) : "";
    text += section.chunks[index].content;
    previous = index;
  }
  return text;
}

/**
 * 按父块组装上下文：按切片排名依次放入其父块，同一父块只放一次。父块放得下时放全文，放不下时保留命中切片及前后相邻切片（按原文顺序），
 * 仍放不下时只放命中切片；同一父块的后续命中切片（及其相邻切片）补入已放入的片段。正文总字数不超过上限，第一项超长时截断。
 * 没有父块的切片（切片规则 1）与 buildAnswerContext 相同，按切片放入。引用编号与摘录规则同 buildAnswerContext，摘录取命中切片。
 */
export function buildSectionContext(chunks: RetrievedChunk[], sections: SectionContext[], maxContextLength: number): AnswerContext {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const entries: Array<{ chunk: RetrievedChunk; content: string; section?: SectionContext; selected?: Set<number>; hits: string[] }> = [];
  const placed = new Map<string, (typeof entries)[number]>();
  // 加入命中切片（先连同相邻切片，放不下时只加它本身）后的选中集合；都放不下时为 null。
  const extend = (section: SectionContext, selected: Set<number>, index: number, budget: number) => {
    for (const radius of [SECTION_WINDOW, 0]) {
      const next = new Set(selected);
      for (let offset = -radius; offset <= radius; offset += 1) if (section.chunks[index + offset]) next.add(index + offset);
      const text = windowText(section, next);
      if (text.length <= budget) return { selected: next, text };
    }
    return null;
  };
  let used = 0;
  for (const chunk of chunks) {
    const remaining = maxContextLength - used;
    if (remaining <= 0) break;
    const section = chunk.sectionId ? byId.get(chunk.sectionId) : undefined;
    const index = section ? section.chunks.findIndex((item) => item.id === chunk.chunkId) : -1;
    const existing = section && placed.get(section.id);
    if (existing) {
      if (existing.hits.includes(chunk.chunkId)) continue;
      existing.hits.push(chunk.chunkId);
      // 已放入全文，或命中切片已在片段中时不再扩展。
      if (!existing.selected || index < 0) continue;
      const next = extend(section, existing.selected, index, existing.content.length + remaining);
      if (next) {
        used += next.text.length - existing.content.length;
        existing.selected = next.selected;
        existing.content = next.text;
      }
      continue;
    }
    let content = chunk.content;
    let selected: Set<number> | undefined;
    if (section && section.content.length <= remaining) content = section.content;
    else if (section && index >= 0) {
      const window = extend(section, new Set(), index, remaining);
      if (window) ({ text: content, selected } = window);
      else selected = new Set([index]);
    }
    if (content.length > remaining && entries.length) continue;
    const entry = { chunk, content: content.slice(0, remaining), ...(section ? { section } : {}), ...(selected ? { selected } : {}), hits: [chunk.chunkId] };
    entries.push(entry);
    if (section) placed.set(section.id, entry);
    used += entry.content.length;
  }

  const context: AnswerContext = { chunks: [], sources: [] };
  const citations = new Map<string, number>();
  for (const { chunk, content, section, hits } of entries) {
    let citation = citations.get(chunk.documentId);
    if (!citation) {
      citation = citations.size + 1;
      citations.set(chunk.documentId, citation);
      context.sources.push({ documentId: chunk.documentId, title: chunk.title, url: chunk.url, ...(chunk.repostSource ? { repostSource: chunk.repostSource } : {}), excerpts: [] });
    }
    context.sources[citation - 1].excerpts!.push({ sectionPath: chunk.sectionPath, text: (section ? chunk.content : content).slice(0, EXCERPT_CHARS) });
    context.chunks.push({ ...chunk, content, citation, ...(section ? { chunkIds: hits } : {}) });
  }
  return context;
}

/** 系统提示词 = 知识库回答提示词 + 引用规则；用户消息 = 按文章编号分组的参考资料 + 问题。 */
/** 会话中此前的问答轮次，用于理解追问。 */
export interface ChatTurn {
  question: string;
  answer: string;
  /** 该轮引用的文章标题，只用于检索问题改写（query-rewrite.ts），不送入回答模型。 */
  sourceTitles?: string[];
}

// 送入模型的历史轮数与每轮回答的字数上限。
export const HISTORY_TURNS = 3;
const HISTORY_ANSWER_CHARS = 500;

/**
 * 历史回答中的引用编号对应当时的参考资料，与本轮编号无关，因此去掉，并截断过长回答。
 * 历史只作为对话上下文，本轮的参考资料仍只附在最后一个问题上。
 */
function historyMessages(history: ChatTurn[]): ChatMessage[] {
  return history.slice(-HISTORY_TURNS).flatMap((turn) => {
    const answer = turn.answer.replace(/\[\d+\]/g, "").trim();
    return [
      { role: "user" as const, content: turn.question },
      { role: "assistant" as const, content: answer.length > HISTORY_ANSWER_CHARS ? `${answer.slice(0, HISTORY_ANSWER_CHARS)}……` : answer },
    ];
  });
}

/** 送入模型的参考资料正文：按引用编号排列，每项带文章标题与章节。 */
export function referenceText(context: AnswerContext): string {
  return [...context.chunks].sort((a, b) => a.citation - b.citation).map((chunk) => {
    const header = `[${chunk.citation}] 《${chunk.title}》${chunk.sectionPath.length ? ` 章节：${chunk.sectionPath.join(" > ")}` : ""}`;
    return `${header}\n${chunk.content}`;
  }).join("\n\n");
}

// 引用校验开启时的回答要求：每个结论标注引用，资料不足只输出固定拒答（与生成后的引用校验配套）。
const STRICT_CITATION_RULES = [
  "- 只依据本轮「参考资料」回答，不要编造资料中没有的事实、数据或结论。",
  "- 每项事实、数值和关键结论都应在相应句末用方括号标注本轮有效的文章编号，例如 [1] 或 [1][2]；作答必须至少有一个引用，禁止引用不存在的编号。",
  "- 资料只支持部分问题时，仅回答有依据的部分并标注引用，明确列出无法回答的部分，不得补全或推断缺失信息。",
  "- 问题中的对象、条件或指代不明确时，不要猜测；若能给出有依据的部分回答，仍须标注引用，并明确请求用户澄清缺失的对象或条件。",
  `- 无法依据资料作答（包括必须先澄清才能回答）时，只输出固定句子「${INSUFFICIENT_EVIDENCE_ANSWER}」，不得添加引用、解释或其他文字。`,
];
// 引用校验关闭时的回答要求（引入引用校验之前的版本）。
const LENIENT_CITATION_RULES = [
  "- 只依据「参考资料」回答，不要编造资料中没有的事实、数据或结论；资料不足以回答时明确说明。",
  "- 引用资料时在相应句末用方括号标注文章编号，例如 [1] 或 [1][2]。",
];

/** citationCheck 对应知识库的引用校验开关，默认开启。 */
export function buildChatMessages(prompt: string, question: string, context: AnswerContext, history: ChatTurn[] = [], citationCheck = true): ChatMessage[] {
  const system = [
    prompt.trim() || DEFAULT_ANSWER_PROMPT,
    "回答要求：",
    ...(citationCheck ? STRICT_CITATION_RULES : LENIENT_CITATION_RULES),
    "- 使用简体中文，条理清晰，保留化学式、数值与单位的原始写法。",
    ...(history.length ? ["- 之前的对话只用于理解当前问题的指代，事实依据仍以本轮「参考资料」为准。"] : []),
  ].join("\n");
  return [
    { role: "system", content: system },
    ...historyMessages(history),
    { role: "user", content: `参考资料：\n\n${referenceText(context)}\n\n问题：${question}` },
  ];
}

/**
 * 没有可用的生成回答时摘录最相关的原文片段。引用校验开启时（默认）明确说明未验证片段是否足以回答，
 * 关闭时沿用引入引用校验之前的说明。
 */
export function extractiveAnswer(context: AnswerContext, citationCheck = true): string {
  if (!context.chunks.length) return NO_MATCH_ANSWER;
  const excerpts = context.chunks.slice(0, 2).map((chunk) => {
    const text = chunk.content.replace(/\s+/g, " ").trim();
    return `[${chunk.citation}] 《${chunk.title}》：${text.slice(0, 200)}${text.length > 200 ? "……" : ""}`;
  });
  if (!citationCheck) return `以下是知识库中最相关的原文片段（未经模型生成）：\n\n${excerpts.join("\n\n")}`;
  return `暂无法提供可靠的生成回答。以下仅为检索到的原文片段，未验证其是否足以回答问题，也不代表已核实的答案，请核对原文或补充问题中的对象与条件：\n\n${excerpts.join("\n\n")}`;
}

/** 问答记录中保存的召回片段。 */
export const retrievedChunkRecords = (context: AnswerContext): ChatRetrievedChunk[] => context.chunks.map((chunk) => ({
  chunkId: chunk.chunkId, documentId: chunk.documentId, citation: chunk.citation, title: chunk.title, sectionPath: chunk.sectionPath,
  excerpt: chunk.content.slice(0, EXCERPT_CHARS), score: chunk.score,
  ...(chunk.vectorScore !== undefined ? { vectorScore: chunk.vectorScore } : {}),
  ...(chunk.keywordScore !== undefined ? { keywordScore: chunk.keywordScore } : {}),
  ...(chunk.summaryScore !== undefined ? { summaryScore: chunk.summaryScore } : {}),
  ...(chunk.rerankScore !== undefined ? { rerankScore: chunk.rerankScore } : {}),
}));
