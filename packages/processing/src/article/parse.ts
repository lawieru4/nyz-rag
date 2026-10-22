// nyzdata 文章解析：ProseMirror/Tiptap JSON → 结构化块、Markdown 与纯文本。未知节点记录后继续处理。
// 原型为 scripts/nyz-articles/parse.mjs（v3），规则调整时同步提升 PARSER_VERSION。
import { createHash } from "node:crypto";
import type { ArticleAttachment, ArticleImage, ArticleMedia, ArticleProjectMeta, ArticleSourceMeta, ArticleTitleMeta } from "@nyz-rag/types";
import { parseArticleTitle } from "./title.js";

export const PARSER_VERSION = 5;

export type BlockRole = "content" | "meta" | "related" | "reference" | "questions";
export type BlockType = "paragraph" | "heading" | "quote" | "list" | "code" | "table" | "image" | "caption" | "media";

export interface ArticleBlock {
  index: number;
  type: BlockType;
  role: BlockRole;
  sectionPath: string[];
  /** 文档顶层节点序号，用于定位原文。 */
  nodeIndex: number;
  text: string;
  markdown: string;
  level?: number;
  imageIndex?: number;
  mediaIndex?: number;
}

export interface ParsedArticle {
  articleKey: string;
  title: string;
  author: string | null;
  category: string | null;
  tags: string[];
  summary: string | null;
  cover: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  isVIP: boolean;
  original: boolean;
  attachments: ArticleAttachment[];
  doi: string | null;
  sourceMeta: ArticleSourceMeta | null;
  projectMeta: ArticleProjectMeta | null;
  titleMeta: ArticleTitleMeta | null;
  relatedArticleKeys: string[];
  images: ArticleImage[];
  media: ArticleMedia[];
  blocks: ArticleBlock[];
  markdown: string;
  plainText: string;
  contentHash: string;
  unknownNodeTypes: string[];
  unknownMarkTypes: string[];
  skipped: Array<{ type: string; reason: string }>;
  demotedHeadings: number;
  parserVersion: number;
}

/** 文章详情接口 data 字段中解析用到的部分。 */
export interface ArticleDetail {
  _key: string;
  title?: string;
  content?: unknown;
  createTime?: number;
  updateTime?: number;
  summary?: string | null;
  cover?: string | null;
  isVIP?: number | boolean;
  original?: boolean | string;
  tagName?: string | null;
  tagArray?: Array<{ name?: string }>;
  creator?: { nickName?: string } | null;
  attachment?: Array<{ originalName?: string; onlineStorageKey?: string; canDownload?: boolean }>;
  invalidToken?: boolean;
}

interface PmNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  content?: PmNode[];
}

// 标题过长或以句末/引导标点结尾，通常是误用标题样式的图注或正文。
const MAX_HEADING_CHARS = 60;
const SENTENCE_HEADING = /[。！？；：:]$/;
// 文首元信息块：作者/转载源/关键词/场景，关键词与场景使用 [[双链]] 标注。
const META_LINE = /^(作者|转载源|关键词|场景)：(.*)$/;
const WIKI_LINK = /\[\[([^\]]+)\]\]/g;
// 按章节标题判定章节角色：related/reference 不参与检索，questions 为编辑提问、不含答案；文首元信息块为 meta。
const SECTION_ROLES: Array<[RegExp, BlockRole]> = [
  [/^(相关阅读|延伸阅读|推荐阅读|往期回顾|往期推荐)$/, "related"],
  [/^(本文链接|原文链接|文章链接|参考文献|参考资料|references?)$/i, "reference"],
  [/^(延伸思考|阅读思考|思考题)$/, "questions"],
];
const sectionRole = (heading: string): BlockRole => SECTION_ROLES.find(([pattern]) => pattern.test(heading.replace(/^[【\[]|[】\]]$/g, "").trim()))?.[1] ?? "content";

class Context {
  blocks: ArticleBlock[] = [];
  images: ArticleImage[] = [];
  media: ArticleMedia[] = [];
  links: string[] = [];
  headings: Array<{ level: number; text: string }> = [];
  skipped: Array<{ type: string; reason: string }> = [];
  demotedHeadings = 0;
  unknownNodes = new Set<string>();
  unknownMarks = new Set<string>();
  nodeIndex = 0;
  inCenter = false;
  lastImageBlock = -1;
  sourceMeta: ArticleSourceMeta | null = null;
  sectionPath() { return this.headings.map((heading) => heading.text); }
}

function inline(nodes: PmNode[] = [], ctx: Context, markdown: boolean): string {
  return nodes.map((node) => {
    if (node.type === "text") {
      let text = node.text ?? "";
      if (!markdown || !text.trim()) return text;
      for (const mark of node.marks ?? []) {
        if (mark.type === "bold" || mark.type === "strong") text = `**${text}**`;
        else if (mark.type === "italic" || mark.type === "em") text = `*${text}*`;
        else if (mark.type === "strike") text = `~~${text}~~`;
        else if (mark.type === "code") text = `\`${text}\``;
        else if (mark.type === "link" && mark.attrs?.href) { text = `[${text}](${mark.attrs.href})`; ctx.links.push(mark.attrs.href); }
        else if (mark.type === "subscript") text = `<sub>${text}</sub>`;
        else if (mark.type === "superscript") text = `<sup>${text}</sup>`;
        else if (!["underline", "textStyle", "highlight"].includes(mark.type)) ctx.unknownMarks.add(mark.type);
      }
      return text;
    }
    if (node.type === "hardBreak") return "\n";
    // 每个块先取纯文本再取 Markdown，内联图片只在 Markdown 遍历中登记一次。
    if (node.type === "image") { if (!markdown) return ""; addImage(node, ctx); return `![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})`; }
    ctx.unknownNodes.add(node.type);
    return inline(node.content, ctx, markdown);
  }).join("");
}

function addImage(node: PmNode, ctx: Context): number | undefined {
  const src = node.attrs?.src;
  if (!src || !/^https?:\/\//.test(src)) { ctx.skipped.push({ type: "image", reason: "invalid src" }); return undefined; }
  ctx.images.push({ index: ctx.images.length, src, alt: node.attrs?.alt ?? null, title: node.attrs?.title ?? null, caption: null, sectionPath: ctx.sectionPath(), nodeIndex: ctx.nodeIndex });
  return ctx.images.length - 1;
}

function parseMeta(text: string): ArticleSourceMeta | null {
  const lines = text.split("\n").map((line) => line.trim().match(META_LINE)).filter((match): match is RegExpMatchArray => Boolean(match));
  if (lines.length < 2) return null;
  const field = (name: string) => lines.find((match) => match[1] === name)?.[2].trim() || null;
  const links = (value: string | null) => value ? [...value.matchAll(WIKI_LINK)].map((match) => match[1].trim()) : [];
  return { generator: field("作者"), repostSource: field("转载源"), keywords: links(field("关键词")), scenarios: links(field("场景")) };
}

function extractProjectMeta(blocks: ArticleBlock[]): ArticleProjectMeta | null {
  const fields = new Map<string, string>();
  const candidates: ArticleBlock[] = [];
  // 只识别文首连续的完整字段块；遇到正文即停止，混合正文的块不移除。
  for (const block of blocks) {
    if (block.role === "meta") continue;
    if (block.role !== "content" || !["paragraph", "quote", "list"].includes(block.type)) break;
    const lines = block.text.split("\n").map((line) => line.trim()).filter(Boolean);
    const matches = lines.map((line) => line.match(/^(项目名称|项目负责人|承担单位|关键词)\s*[:：]\s*(.+)$/));
    if (!matches.length || matches.some((match) => !match)) break;
    // 重复字段可能是正文里的项目对比，不把后一个项目并入导读。
    const labels = matches.map((match) => match![1]);
    if (new Set(labels).size !== labels.length || labels.some((label) => fields.has(label))) break;
    for (const match of matches) fields.set(match![1], match![2].trim());
    candidates.push(block);
  }
  const name = fields.get("项目名称");
  if (!name || !(fields.get("项目负责人") || fields.get("承担单位"))) return null;
  for (const block of candidates) block.role = "meta";
  const keywords = fields.get("关键词") ?? "";
  const links = [...keywords.matchAll(WIKI_LINK)].map((match) => match[1].trim());
  return {
    name: name.replace(WIKI_LINK, "$1"),
    principal: fields.get("项目负责人")?.replace(WIKI_LINK, "$1") ?? null,
    institution: fields.get("承担单位")?.replace(WIKI_LINK, "$1") ?? null,
    keywords: [...new Set((links.length ? links : keywords.split(/[,，、;；]/)).map((value) => value.trim()).filter(Boolean))],
  };
}

function pushBlock(ctx: Context, type: BlockType, text: string, markdown: string, extra: Partial<ArticleBlock> = {}) {
  const plain = text.replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!plain && type !== "image" && type !== "media") return;
  let role: BlockRole = ctx.headings.length ? sectionRole(ctx.headings.at(-1)!.text) : "content";
  const meta = !ctx.sourceMeta && type !== "heading" ? parseMeta(plain) : null;
  if (meta) { ctx.sourceMeta = meta; role = "meta"; }
  ctx.blocks.push({ index: ctx.blocks.length, type, role, sectionPath: ctx.sectionPath(), nodeIndex: ctx.nodeIndex, text: plain, markdown: markdown.replace(WIKI_LINK, "$1").trim(), ...extra });
}

const isList = (node: PmNode) => node.type === "bulletList" || node.type === "orderedList";

function listItems(node: PmNode, ctx: Context, depth: number): string[] {
  const lines: string[] = [];
  (node.content ?? []).forEach((item, position) => {
    const bullet = node.type === "orderedList" ? `${(node.attrs?.start ?? 1) + position}.` : "-";
    const children = item.content ?? [];
    const text = children.filter((child) => !isList(child)).map((child) => inline(child.content, ctx, true)).join(" ").trim();
    if (text) lines.push(`${"  ".repeat(depth)}${bullet} ${text}`);
    for (const child of children.filter(isList)) lines.push(...listItems(child, ctx, depth + 1));
  });
  return lines;
}

function block(node: PmNode, ctx: Context): void {
  switch (node.type) {
    case "doc":
      (node.content ?? []).forEach((child) => block(child, ctx));
      return;
    case "paragraph": {
      const text = inline(node.content, ctx, false);
      const markdown = inline(node.content, ctx, true);
      // 居中 wrapDiv 中紧随图片的短文本视为图片说明。
      if (ctx.inCenter && ctx.lastImageBlock === ctx.blocks.length && ctx.images.length && text.trim() && text.length <= 120) {
        ctx.images[ctx.images.length - 1].caption = text.trim();
        pushBlock(ctx, "caption", text, `*${text.trim()}*`);
        return;
      }
      pushBlock(ctx, "paragraph", text, markdown);
      return;
    }
    case "heading": {
      const level = Math.min(6, Math.max(1, node.attrs?.level ?? 2));
      const text = inline(node.content, ctx, false).trim();
      if (!text) return;
      if (text.length > MAX_HEADING_CHARS || SENTENCE_HEADING.test(text)) {
        ctx.demotedHeadings += 1;
        pushBlock(ctx, "paragraph", text, inline(node.content, ctx, true));
        return;
      }
      ctx.headings = ctx.headings.filter((heading) => heading.level < level);
      ctx.headings.push({ level, text });
      pushBlock(ctx, "heading", text, `${"#".repeat(level)} ${inline(node.content, ctx, true).trim()}`, { level });
      return;
    }
    case "blockquote": {
      const inner = (node.content ?? []).map((child) => child.content ? inline(child.content, ctx, false) : "").filter((value) => value.trim());
      const innerMd = (node.content ?? []).map((child) => child.content ? inline(child.content, ctx, true) : "").filter((value) => value.trim());
      pushBlock(ctx, "quote", inner.join("\n"), innerMd.map((line) => `> ${line}`).join("\n>\n"));
      return;
    }
    case "bulletList":
    case "orderedList": {
      const lines = listItems(node, ctx, 0);
      pushBlock(ctx, "list", lines.map((line) => line.replace(/^\s*(?:-|\d+\.)\s/, "").replace(/\*\*|`/g, "")).join("\n"), lines.join("\n"));
      return;
    }
    case "codeBlock": {
      const code = (node.content ?? []).map((child) => child.text ?? "").join("");
      pushBlock(ctx, "code", code, `\`\`\`${node.attrs?.language ?? ""}\n${code}\n\`\`\``);
      return;
    }
    case "table": {
      const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => (cell.content ?? []).map((child) => inline(child.content, ctx, false)).join(" ").replace(/\|/g, "\\|").trim()));
      if (!rows.length) return;
      const width = Math.max(...rows.map((row) => row.length));
      const pad = (row: string[]) => [...row, ...Array<string>(width - row.length).fill("")];
      const markdown = [pad(rows[0]), Array<string>(width).fill("---"), ...rows.slice(1).map(pad)].map((row) => `| ${row.join(" | ")} |`).join("\n");
      pushBlock(ctx, "table", rows.map((row) => row.join(" | ")).join("\n"), markdown);
      return;
    }
    case "horizontalRule":
      return;
    case "image": {
      const imageIndex = addImage(node, ctx);
      if (imageIndex === undefined) return;
      pushBlock(ctx, "image", "", `![${node.attrs?.alt ?? ""}](${node.attrs?.src})`, { imageIndex });
      ctx.lastImageBlock = ctx.blocks.length;
      return;
    }
    case "attachFile": {
      const url = node.attrs?.url;
      if (!url) { ctx.skipped.push({ type: "attachFile", reason: "missing url" }); return; }
      ctx.media.push({ index: ctx.media.length, url, fileType: node.attrs?.fileType ?? null, title: node.attrs?.title ?? null, sectionPath: ctx.sectionPath(), nodeIndex: ctx.nodeIndex });
      pushBlock(ctx, "media", "", `[${node.attrs?.title ?? "附件"}](${url})`, { mediaIndex: ctx.media.length - 1 });
      return;
    }
    case "wrapDiv": {
      const previous = ctx.inCenter;
      ctx.inCenter = /center/.test(node.attrs?.class ?? "");
      (node.content ?? []).forEach((child) => block(child, ctx));
      ctx.inCenter = previous;
      return;
    }
    default:
      ctx.unknownNodes.add(node.type);
      if (node.content) node.content.forEach((child) => block(child, ctx));
      else if (node.text) pushBlock(ctx, "paragraph", node.text, node.text);
  }
}

const isoTime = (value: number | undefined) => value ? new Date(value).toISOString() : null;

export function parseArticle(detail: ArticleDetail): ParsedArticle {
  const content = (typeof detail.content === "string" ? JSON.parse(detail.content) : detail.content) as PmNode | undefined;
  if (content?.type !== "doc" || !Array.isArray(content.content)) throw new Error("文章正文不是 ProseMirror 文档");
  const ctx = new Context();
  content.content.forEach((node, index) => { ctx.nodeIndex = index; block(node, ctx); });
  const projectMeta = extractProjectMeta(ctx.blocks);
  for (const item of ctx.blocks) item.text = item.text.replace(WIKI_LINK, "$1");

  const doi = ctx.links.map((link) => link.match(/10\.\d{4,9}\/[^\s?#]+/)?.[0]).find(Boolean) ?? null;
  const relatedArticleKeys = [...new Set(ctx.links.map((link) => link.match(/ArticleDetail\?id=(\d+)/)?.[1]).filter((key): key is string => Boolean(key)))];
  const markdown = ctx.blocks.map((item) => item.markdown).filter(Boolean).join("\n\n");
  const title = detail.title?.trim() ?? "";
  const plainText = ctx.blocks.map((item) => item.text).filter(Boolean).join("\n\n");
  return {
    articleKey: detail._key,
    title,
    author: detail.creator?.nickName ?? null,
    category: detail.tagName ?? null,
    tags: (detail.tagArray ?? []).map((tag) => tag.name).filter((name): name is string => Boolean(name)),
    summary: detail.summary ?? null,
    cover: detail.cover ?? null,
    publishedAt: isoTime(detail.createTime),
    updatedAt: isoTime(detail.updateTime),
    isVIP: Boolean(detail.isVIP),
    original: detail.original === true,
    attachments: (detail.attachment ?? []).map((item) => ({ originalName: item.originalName ?? null, storageKey: item.onlineStorageKey ?? null, canDownload: Boolean(item.canDownload) })),
    doi,
    sourceMeta: ctx.sourceMeta,
    projectMeta,
    titleMeta: parseArticleTitle(title),
    relatedArticleKeys,
    images: ctx.images,
    media: ctx.media,
    blocks: ctx.blocks,
    markdown,
    plainText,
    contentHash: createHash("sha256").update(plainText).digest("hex"),
    unknownNodeTypes: [...ctx.unknownNodes],
    unknownMarkTypes: [...ctx.unknownMarks],
    skipped: ctx.skipped,
    demotedHeadings: ctx.demotedHeadings,
    parserVersion: PARSER_VERSION,
  };
}
