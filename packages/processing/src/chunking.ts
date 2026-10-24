// 结构化切片，两套规则（CHUNKER_VERSION）：
// - 1：按章节与块累积到目标长度，不跨章节（过短章节并入下一节），表格整块保留，超长段落按句切分。
// - 2：章节父块 + 段落子块（docs/chunking-design.md）。父块为一段连续的同章节正文，用于回答上下文；子块为父块内 1～3 个相邻内容块，
//   用于关键词/向量召回与 Rerank。短章节保留自己的父块，只有标题的父块并入下一个，超长章节按内容块边界拆成几段。
// 每个切片带上下文前缀（文章标题、章节、关键词），向量化时拼接在正文前。
import type { DocumentChunkRecord } from "@nyz-rag/types";
import type { ParsedArticle } from "./article/parse.js";

export interface ChunkBlock {
  kind: "text" | "table";
  text: string;
  sectionPath: string[];
  /** 章节标题行：规则 2 中每个标题开始一个新的父块。 */
  heading?: boolean;
}

export interface ChunkOptions {
  /** 单个切片正文的目标字数。 */
  targetChars?: number;
  /** 不足该字数的章节并入下一节。 */
  minChars?: number;
}

export type StructuredChunk = Required<DocumentChunkRecord>;

/** 规则 2 的父块（章节）：不向量化、不建关键词词项，回答时替代命中的子块放入上下文。 */
export interface StructuredSection {
  id: string;
  /** 文章内顺序。 */
  index: number;
  sectionPath: string[];
  /** 同一章节拆成多段时的段序号，从 0 开始。 */
  part: number;
  content: string;
  tokenEstimate: number;
}

/** 切片结果：规则 1 没有父块，切片的 sectionId 为 null。 */
export interface ChunkedArticle {
  sections: StructuredSection[];
  chunks: Array<StructuredChunk & { sectionId: string | null }>;
}

/** 切片规则版本，写入 documents.chunker_version。父子块（2）通过评估验收前，新处理的文档仍使用 1。 */
export const LEGACY_CHUNKER_VERSION = 1;
export const SECTION_CHUNKER_VERSION = 2;
export type ChunkerVersion = typeof LEGACY_CHUNKER_VERSION | typeof SECTION_CHUNKER_VERSION;
export const CHUNKER_VERSION: ChunkerVersion = LEGACY_CHUNKER_VERSION;

const SENTENCE = /[^。！？!?；;\n]+(?:[。！？!?；;]+|$)/g;
// 句子（含句末标点与随后的换行）或连续的标点/换行，依次匹配可拼回原文。
const SENTENCE_LOSSLESS = /[^。！？!?；;\n]+[。！？!?；;]*\n*|[。！？!?；;\n]+/g;
const MAX_KEYWORDS = 8;
// 中日韩标点、统一表意文字、兼容表意文字与全角字符。
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

/** 粗略 Token 估算：中日韩字符各计 1，其余非空白字符约 3.5 个计 1。 */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const other = text.replace(CJK, "").replace(/\s/g, "").length;
  return cjk + Math.ceil(other / 3.5);
}

/** 向量化输入：上下文前缀 + 正文。 */
export const embeddingInput = (chunk: DocumentChunkRecord) => chunk.context ? `${chunk.context}\n\n${chunk.content}` : chunk.content;

/** 文章级向量化输入：标题 + 摘要；没有摘要时为 null，不生成文章级向量。 */
export function summaryEmbeddingInput(title: string, summary: string | null | undefined): string | null {
  const text = summary?.trim();
  return text ? `文章：${title}\n\n${text}` : null;
}

// 超长文本先按句切分，单句仍超长时按长度硬切。
function splitLong(text: string, target: number): string[] {
  if (text.length <= target) return [text];
  const pieces: string[] = [];
  for (const sentence of text.match(SENTENCE) ?? [text]) {
    for (let start = 0; start < sentence.length; start += target) pieces.push(sentence.slice(start, start + target));
  }
  return pieces.filter((piece) => piece.trim());
}

// 规则 2 的句子切分：保留全部字符（规则 1 的 SENTENCE 会丢掉没有句末标点、以换行结尾的行，为保持规则 1 的结果不变未修改），
// 单句仍超长时按长度硬切。
function splitSentences(text: string, target: number): string[] {
  const pieces: string[] = [];
  for (const sentence of text.match(SENTENCE_LOSSLESS) ?? [text]) {
    for (let start = 0; start < sentence.length; start += target) pieces.push(sentence.slice(start, start + target));
  }
  return pieces;
}

// 超长表格按行切分，每段重复表头。
function splitTable(text: string, target: number): string[] {
  const [header, ...rows] = text.split("\n");
  const parts: string[] = [];
  let current: string[] = [];
  for (const row of rows) {
    if (current.length && [header, ...current, row].join("\n").length > target) { parts.push([header, ...current].join("\n")); current = []; }
    current.push(row);
  }
  if (current.length || !parts.length) parts.push([header, ...current].join("\n"));
  return parts;
}

function chunkPrefix(title: string, sectionPath: string[], keywords: string[]): string {
  const lines = [`文章：${title}`];
  if (sectionPath.length) lines.push(`章节：${sectionPath.join(" > ")}`);
  if (keywords.length) lines.push(`关键词：${keywords.join("、")}`);
  return lines.join("\n");
}

export function chunkBlocks(documentId: string, blocks: ChunkBlock[], context: { title: string; keywords?: string[] }, options: ChunkOptions = {}): StructuredChunk[] {
  const target = options.targetChars ?? 800;
  const minimum = options.minChars ?? 200;
  const keywords = (context.keywords ?? []).slice(0, MAX_KEYWORDS);
  const chunks: StructuredChunk[] = [];
  // 同一块切出的句子直接相连，不同块之间换行。
  let buffer: string[] = [];
  let size = 0;
  let hasTable = false;
  let sectionPath: string[] = [];

  const flush = () => {
    const content = buffer.join("").trim();
    buffer = [];
    size = 0;
    if (!content) { hasTable = false; return; }
    const prefix = chunkPrefix(context.title, sectionPath, keywords);
    chunks.push({
      id: `${documentId}-${chunks.length + 1}`, index: chunks.length, content, context: prefix, sectionPath,
      contentType: hasTable ? "table" : "text", tokenEstimate: estimateTokens(`${prefix}\n\n${content}`),
    });
    hasTable = false;
  };
  const push = (piece: string, newBlock: boolean) => {
    const text = newBlock && buffer.length ? `\n${piece}` : piece;
    buffer.push(text);
    size += text.length;
  };

  for (const block of blocks) {
    const text = block.text.trim();
    if (!text) continue;
    if (block.sectionPath.join("\u0000") !== sectionPath.join("\u0000")) {
      // 过短的上一节并入下一节，避免碎片；切片的章节记为最后所在的章节。
      if (size >= minimum) flush();
      sectionPath = block.sectionPath;
    }
    if (block.kind === "table") {
      if (buffer.length && size + text.length > target) flush();
      // 表格不超过两倍目标长度时整块保留。
      const parts = text.length > target * 2 ? splitTable(text, target) : [text];
      for (const [index, part] of parts.entries()) {
        if (index > 0) flush();
        push(part, true);
        hasTable = true;
      }
      if (size >= target) flush();
      continue;
    }
    for (const [index, piece] of splitLong(text, target).entries()) {
      if (buffer.length && size + piece.length > target) flush();
      push(piece, index === 0);
    }
  }
  flush();
  return chunks;
}

// 规则 2 的长度（字数）：父块超过上限时按内容块边界均分成几段；子块目标 200～500 字、上限 600 字，至多 3 个内容块；
// 不足 50 字的子块（标题行、图注、过渡句）并入相邻子块；表格单独成子块，超过 1600 字时按行切分并重复表头。
const SECTION_MAX = 2000;
const CHILD_MIN = 200;
const CHILD_TARGET = 500;
const CHILD_MAX = 600;
const CHILD_BLOCKS = 3;
const CHILD_SHORT = 50;
const TABLE_MAX = 1600;

const pathKey = (path: string[]) => path.join("\u0000");
const blockLength = (blocks: ChunkBlock[]) => blocks.reduce((sum, block) => sum + block.text.length, 0) + Math.max(0, blocks.length - 1);

/** 连续的同章节内容块为一个父块，每个标题开始新的父块（重复的标题不会合并）；只有标题的父块并入下一个。 */
function sectionRanges(blocks: ChunkBlock[]): Array<{ sectionPath: string[]; blocks: ChunkBlock[] }> {
  const ranges: Array<{ sectionPath: string[]; blocks: ChunkBlock[] }> = [];
  for (const block of blocks) {
    const last = ranges.at(-1);
    if (!last || block.heading || pathKey(block.sectionPath) !== pathKey(last.sectionPath)) ranges.push({ sectionPath: block.sectionPath, blocks: [block] });
    else last.blocks.push(block);
  }
  const merged: typeof ranges = [];
  let pending: ChunkBlock[] = [];
  for (const range of ranges) {
    if (range.blocks.every((block) => block.heading)) { pending.push(...range.blocks); continue; }
    merged.push({ sectionPath: range.sectionPath, blocks: [...pending, ...range.blocks] });
    pending = [];
  }
  if (pending.length) {
    if (merged.length) merged.at(-1)!.blocks.push(...pending);
    else merged.push({ sectionPath: pending.at(-1)!.sectionPath, blocks: pending });
  }
  return merged;
}

/** 超长父块按内容块边界拆成长度相近的几段，不在内容块中间断开（单个内容块超长时自成一段）。 */
function sectionParts(blocks: ChunkBlock[]): ChunkBlock[][] {
  const total = blockLength(blocks);
  if (total <= SECTION_MAX) return [blocks];
  const target = total / Math.ceil(total / SECTION_MAX);
  const parts: ChunkBlock[][] = [[]];
  let size = 0;
  for (const block of blocks) {
    const current = parts.at(-1)!;
    if (current.length && (size >= target || size + 1 + block.text.length > SECTION_MAX)) { parts.push([]); size = 0; }
    size += (parts.at(-1)!.length ? 1 : 0) + block.text.length;
    parts.at(-1)!.push(block);
  }
  return parts;
}

interface ChildUnit { text: string; block: number; table: boolean }
interface ChildGroup { units: ChildUnit[]; size: number; blocks: Set<number>; table: boolean }

/** 父块内的子块：内容块为单位组合，超长段落按句、超长表格按行先拆开。 */
function childGroups(blocks: ChunkBlock[]): ChildGroup[] {
  const units = blocks.flatMap((block, index): ChildUnit[] => {
    if (block.kind === "table") return (block.text.length > TABLE_MAX ? splitTable(block.text, CHILD_TARGET) : [block.text]).map((text) => ({ text, block: index, table: true }));
    return (block.text.length > CHILD_MAX ? splitSentences(block.text, CHILD_TARGET) : [block.text]).map((text) => ({ text, block: index, table: false }));
  });
  const groups: ChildGroup[] = [];
  for (const unit of units) {
    const group = groups.at(-1);
    const size = group ? group.size + unit.text.length : 0;
    const fits = group && !unit.table && !group.table && size <= CHILD_MAX
      && (group.size < CHILD_MIN || ((group.blocks.size < CHILD_BLOCKS || group.blocks.has(unit.block)) && size <= CHILD_TARGET));
    if (group && fits) {
      group.units.push(unit);
      group.size = size;
      group.blocks.add(unit.block);
    } else {
      groups.push({ units: [unit], size: unit.text.length, blocks: new Set([unit.block]), table: unit.table });
    }
  }
  // 过短的子块并入下一个（最后一个并入上一个），不受块数与表格限制。
  for (let index = 0; index < groups.length && groups.length > 1;) {
    const group = groups[index];
    if (group.size >= CHILD_SHORT) { index += 1; continue; }
    const target = groups[index + 1] ?? groups[index - 1];
    if (target === groups[index + 1]) target.units.unshift(...group.units);
    else target.units.push(...group.units);
    target.size += group.size;
    target.table ||= group.table;
    for (const block of group.blocks) target.blocks.add(block);
    groups.splice(index, 1);
  }
  return groups;
}

// 同一内容块拆出的句子直接相连，不同内容块之间换行。
const groupText = (units: ChildUnit[]) => units.map((unit, index) => (index && unit.block !== units[index - 1].block ? `\n${unit.text}` : unit.text)).join("").trim();

/** 规则 2：章节父块 + 段落子块。子块的上下文前缀与规则 1 相同，章节取父块的章节路径。 */
export function chunkSections(documentId: string, blocks: ChunkBlock[], context: { title: string; keywords?: string[] }): ChunkedArticle {
  const keywords = (context.keywords ?? []).slice(0, MAX_KEYWORDS);
  const result: ChunkedArticle = { sections: [], chunks: [] };
  const usable = blocks.map((block) => ({ ...block, text: block.text.trim() })).filter((block) => block.text);
  for (const range of sectionRanges(usable)) {
    const prefix = chunkPrefix(context.title, range.sectionPath, keywords);
    for (const [part, partBlocks] of sectionParts(range.blocks).entries()) {
      const content = partBlocks.map((block) => block.text).join("\n");
      const section: StructuredSection = {
        id: `${documentId}-s${result.sections.length + 1}`, index: result.sections.length, sectionPath: range.sectionPath, part, content, tokenEstimate: estimateTokens(content),
      };
      result.sections.push(section);
      for (const group of childGroups(partBlocks)) {
        const text = groupText(group.units);
        result.chunks.push({
          id: `${documentId}-${result.chunks.length + 1}`, index: result.chunks.length, content: text, context: prefix, sectionPath: range.sectionPath,
          contentType: group.table ? "table" : "text", tokenEstimate: estimateTokens(`${prefix}\n\n${text}`), sectionId: section.id,
        });
      }
    }
  }
  return result;
}

/**
 * 文章只切分正文章节；元信息、相关阅读、本文链接与延伸思考不进入切片，图片与附件也不参与。
 * 以图片为主、没有正文文字的文章用摘要代替。
 */
export function articleChunkBlocks(article: Pick<ParsedArticle, "blocks" | "summary">): ChunkBlock[] {
  const blocks = article.blocks
    .filter((block) => block.role === "content" && block.type !== "image" && block.type !== "media" && block.text)
    .map((block): ChunkBlock => ({
      kind: block.type === "table" ? "table" : "text", text: block.text, sectionPath: block.sectionPath, ...(block.type === "heading" ? { heading: true } : {}),
    }));
  if (!blocks.length && article.summary?.trim()) return [{ kind: "text", text: article.summary.trim(), sectionPath: ["摘要"] }];
  return blocks;
}

/** 文章正文：参与检索的块的纯文本。 */
export const articleContent = (article: Pick<ParsedArticle, "blocks" | "summary">) => articleChunkBlocks(article).map((block) => block.text).join("\n\n");

/** 「延伸思考」中的编辑提问，去掉序号。 */
export function articleQuestions(article: Pick<ParsedArticle, "blocks">): string[] {
  return article.blocks
    .filter((block) => block.role === "questions" && block.type !== "heading")
    .flatMap((block) => block.text.split("\n"))
    .map((line) => line.replace(/^\s*(?:\d+\s*\\?[.、．)）]|[-•·])\s*/, "").trim())
    .filter(Boolean);
}

const articleKeywords = (article: ParsedArticle) => [...new Set([...(article.sourceMeta?.keywords ?? []), ...(article.projectMeta?.keywords ?? [])])];

export function chunkArticle(documentId: string, article: ParsedArticle, options?: ChunkOptions): StructuredChunk[] {
  return chunkBlocks(documentId, articleChunkBlocks(article), { title: article.title, keywords: articleKeywords(article) }, options);
}

/** 按指定规则切分文章；规则 1 没有父块。 */
export function chunkArticleWith(version: ChunkerVersion, documentId: string, article: ParsedArticle): ChunkedArticle {
  if (version === SECTION_CHUNKER_VERSION) return chunkSections(documentId, articleChunkBlocks(article), { title: article.title, keywords: articleKeywords(article) });
  return { sections: [], chunks: chunkArticle(documentId, article).map((chunk) => ({ ...chunk, sectionId: null })) };
}
