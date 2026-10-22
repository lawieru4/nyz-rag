// 结构化切片：按章节与块累积到目标长度，不跨章节（过短章节并入下一节），表格整块保留，超长段落按句切分。
// 每个切片带上下文前缀（文章标题、章节、关键词），向量化时拼接在正文前。
import type { DocumentChunkRecord } from "@nyz-rag/types";
import type { ParsedArticle } from "./article/parse.js";

export interface ChunkBlock {
  kind: "text" | "table";
  text: string;
  sectionPath: string[];
}

export interface ChunkOptions {
  /** 单个切片正文的目标字数。 */
  targetChars?: number;
  /** 不足该字数的章节并入下一节。 */
  minChars?: number;
}

export type StructuredChunk = Required<DocumentChunkRecord>;

const SENTENCE = /[^。！？!?；;\n]+(?:[。！？!?；;]+|$)/g;
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

/** 文章级向量化输入：标题 + 摘要；没有摘要（如网页来源）时为 null，不生成文章级向量。 */
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
    const lines = [`文章：${context.title}`];
    if (sectionPath.length) lines.push(`章节：${sectionPath.join(" > ")}`);
    if (keywords.length) lines.push(`关键词：${keywords.join("、")}`);
    const prefix = lines.join("\n");
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

/**
 * 文章只切分正文章节；元信息、相关阅读、本文链接与延伸思考不进入切片，图片与附件也不参与。
 * 以图片为主、没有正文文字的文章用摘要代替。
 */
export function articleChunkBlocks(article: Pick<ParsedArticle, "blocks" | "summary">): ChunkBlock[] {
  const blocks = article.blocks
    .filter((block) => block.role === "content" && block.type !== "image" && block.type !== "media" && block.text)
    .map((block): ChunkBlock => ({ kind: block.type === "table" ? "table" : "text", text: block.text, sectionPath: block.sectionPath }));
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

export function chunkArticle(documentId: string, article: ParsedArticle, options?: ChunkOptions): StructuredChunk[] {
  const keywords = [...new Set([...(article.sourceMeta?.keywords ?? []), ...(article.projectMeta?.keywords ?? [])])];
  return chunkBlocks(documentId, articleChunkBlocks(article), { title: article.title, keywords }, options);
}

/** 网页等纯文本正文：按行作为块，没有章节信息。 */
export function chunkText(documentId: string, title: string, content: string, options?: ChunkOptions): StructuredChunk[] {
  const blocks = content.split(/\n+/).map((line) => ({ kind: "text" as const, text: line.replace(/[ \t]+/g, " "), sectionPath: [] }));
  return chunkBlocks(documentId, blocks, { title }, options);
}
