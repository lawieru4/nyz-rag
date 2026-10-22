// ProseMirror/Tiptap 文章解析：生成结构化块、Markdown 与纯文本。未知节点记录后继续处理。
import { createHash } from "node:crypto";

export const PARSER_VERSION = 3;

// 标题过长或以句末/引导标点结尾，通常是误用标题样式的图注或正文。
const MAX_HEADING_CHARS = 60;
const SENTENCE_HEADING = /[。！？；：:]$/;
// 文首元信息块：作者/转载源/关键词/场景，关键词与场景使用 [[双链]] 标注。
const META_LINE = /^(作者|转载源|关键词|场景)：(.*)$/;
const WIKI_LINK = /\[\[([^\]]+)\]\]/g;
// 按章节标题判定章节角色：related/reference 不参与检索，questions 为编辑提问、不含答案；文首元信息块为 meta。
const SECTION_ROLES = [
  [/^(相关阅读|延伸阅读|推荐阅读|往期回顾|往期推荐)$/, "related"],
  [/^(本文链接|原文链接|文章链接|参考文献|参考资料|references?)$/i, "reference"],
  [/^(延伸思考|阅读思考|思考题)$/, "questions"],
];
const sectionRole = (heading) => SECTION_ROLES.find(([pattern]) => pattern.test(heading.replace(/^[【\[]|[】\]]$/g, "").trim()))?.[1] ?? "content";

function inline(nodes = [], ctx, markdown) {
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

function addImage(node, ctx) {
  const src = node.attrs?.src;
  if (!src || !/^https?:\/\//.test(src)) { ctx.skipped.push({ type: "image", reason: "invalid src" }); return; }
  ctx.images.push({ index: ctx.images.length, src, alt: node.attrs?.alt ?? null, title: node.attrs?.title ?? null, caption: null, sectionPath: [...ctx.sectionPath()], nodeIndex: ctx.nodeIndex });
  return ctx.images.length - 1;
}

function parseMeta(text) {
  const lines = text.split("\n").map((line) => line.trim().match(META_LINE)).filter(Boolean);
  if (lines.length < 2) return null;
  const field = (name) => lines.find((match) => match[1] === name)?.[2].trim() ?? null;
  const links = (value) => value ? [...value.matchAll(WIKI_LINK)].map((match) => match[1].trim()) : [];
  return { generator: field("作者"), repostSource: field("转载源"), keywords: links(field("关键词")), scenarios: links(field("场景")) };
}

function pushBlock(ctx, type, text, markdown, extra = {}) {
  let plain =text.replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!plain && type !== "image" && type !== "media") return;
  let role = ctx.headings.length ? sectionRole(ctx.headings.at(-1).text) : "content";
  const meta = !ctx.sourceMeta && type !== "heading" ? parseMeta(plain) : null;
  if (meta) { ctx.sourceMeta = meta; role = "meta"; }
  plain = plain.replace(WIKI_LINK, "$1");
  ctx.blocks.push({ index: ctx.blocks.length, type, role, sectionPath: [...ctx.sectionPath()], nodeIndex: ctx.nodeIndex, text: plain, markdown: markdown.replace(WIKI_LINK, "$1").trim(), ...extra });
}

function listItems(node, ctx, depth) {
  const lines = [];
  (node.content ?? []).forEach((item, position) => {
    const bullet = node.type === "orderedList" ? `${(node.attrs?.start ?? 1) + position}.` : "-";
    const children = item.content ?? [];
    const isList = (child) => child.type === "bulletList" || child.type === "orderedList";
    const text = children.filter((child) => !isList(child)).map((child) => inline(child.content, ctx, true)).join(" ").trim();
    if (text) lines.push(`${"  ".repeat(depth)}${bullet} ${text}`);
    for (const child of children.filter(isList)) lines.push(...listItems(child, ctx, depth + 1));
  });
  return lines;
}

function block(node, ctx) {
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
      const pad = (row) => [...row, ...Array(width - row.length).fill("")];
      const markdown = [pad(rows[0]), Array(width).fill("---"), ...rows.slice(1).map(pad)].map((row) => `| ${row.join(" | ")} |`).join("\n");
      pushBlock(ctx, "table", rows.map((row) => row.join(" | ")).join("\n"), markdown);
      return;
    }
    case "horizontalRule":
      return;
    case "image": {
      const imageIndex = addImage(node, ctx);
      if (imageIndex === undefined) return;
      pushBlock(ctx, "image", "", `![${node.attrs?.alt ?? ""}](${node.attrs.src})`, { imageIndex });
      ctx.lastImageBlock = ctx.blocks.length;
      return;
    }
    case "attachFile": {
      const url = node.attrs?.url;
      if (!url) { ctx.skipped.push({ type: "attachFile", reason: "missing url" }); return; }
      ctx.media.push({ index: ctx.media.length, url, fileType: node.attrs?.fileType ?? null, title: node.attrs?.title ?? null, sectionPath: [...ctx.sectionPath()], nodeIndex: ctx.nodeIndex });
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
      if (node.content) (node.content ?? []).forEach((child) => block(child, ctx));
      else if (node.text) pushBlock(ctx, "paragraph", node.text, node.text);
  }
}

export function parseArticle(detail) {
  const content = typeof detail.content === "string" ? JSON.parse(detail.content) : detail.content;
  const ctx = {
    blocks: [], images: [], media: [], links: [], headings: [], skipped: [], demotedHeadings: 0, unknownNodes: new Set(), unknownMarks: new Set(),
    nodeIndex: 0, inCenter: false, lastImageBlock: -1, sourceMeta: null,
    sectionPath() { return this.headings.map((heading) => heading.text); },
  };
  if (content?.type !== "doc" || !Array.isArray(content.content)) throw new Error("data.content is not a ProseMirror doc");
  content.content.forEach((node, index) => { ctx.nodeIndex = index; block(node, ctx); });

  const doi = ctx.links.map((link) => link.match(/10\.\d{4,9}\/[^\s?#]+/)?.[0]).find(Boolean) ?? null;
  const relatedArticleKeys = [...new Set(ctx.links.map((link) => link.match(/ArticleDetail\?id=(\d+)/)?.[1]).filter(Boolean))];
  const markdown = ctx.blocks.map((item) => item.markdown).filter(Boolean).join("\n\n");
  const plainText = ctx.blocks.map((item) => item.text).filter(Boolean).join("\n\n");
  return {
    articleKey: detail._key,
    title: detail.title?.trim() ?? "",
    author: detail.creator?.nickName ?? null,
    category: detail.tagName ?? null,
    tags: (detail.tagArray ?? []).map((tag) => tag.name).filter(Boolean),
    summary: detail.summary ?? null,
    cover: detail.cover ?? null,
    publishedAt: detail.createTime ? new Date(detail.createTime).toISOString() : null,
    updatedAt: detail.updateTime ? new Date(detail.updateTime).toISOString() : null,
    isVIP: Boolean(detail.isVIP),
    original: detail.original === true,
    sourceWordNumber: detail.wordNumber ?? null,
    attachments: (detail.attachment ?? []).map((item) => ({ originalName: item.originalName, storageKey: item.onlineStorageKey, canDownload: Boolean(item.canDownload) })),
    doi,
    sourceMeta: ctx.sourceMeta,
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
