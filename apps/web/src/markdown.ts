export interface MarkdownBlock {
  kind: "heading" | "paragraph" | "list" | "code" | "table";
  level?: number;
  rows?: string[][];
  ordered?: boolean;
  /** 有序列表的起始编号。 */
  start?: number;
  text?: string;
  items?: string[];
}

const LIST_ITEM = /^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/;

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] }); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const rows = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes("|")) rows.push(splitTableRow(lines[i++]));
      blocks.push({ kind: "table", rows });
      continue;
    }
    const listMatch = line.match(LIST_ITEM);
    if (listMatch) {
      const ordered = !!listMatch[2];
      const items: string[] = [];
      while (i < lines.length) {
        // 空行隔开的同类列表项（松散列表）仍属于同一个列表。
        let next = i;
        while (next < lines.length && !lines[next].trim()) next++;
        const item = lines[next]?.match(LIST_ITEM);
        if (!item || !!item[2] !== ordered) break;
        items.push(item[3]); i = next + 1;
      }
      blocks.push({ kind: "list", ordered, items, ...(ordered ? { start: Number(listMatch[2]) } : {}) });
      continue;
    }
    const paragraph = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*(?:[-*+]\s|\d+\.\s))/.test(lines[i])) paragraph.push(lines[i++].trim());
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function splitTableRow(line: string) { return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()); }

export function safeLink(value: string, allowMail = false): string | undefined {
  try {
    const url = new URL(value, location.href);
    if (["http:", "https:", ...(allowMail ? ["mailto:"] : [])].includes(url.protocol)) return url.href;
  } catch { /* Invalid links remain plain text. */ }
}

export interface InlineToken {
  text: string;
  href?: string;
  strong?: boolean;
  code?: boolean;
  /** 回答中的引用编号 `[n]`（只在 citations 选项开启时识别）。 */
  citation?: number;
}

export function inlineTokens(text: string, options: { citations?: boolean } = {}): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = options.citations
    ? /\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\*\*(.+?)\*\*|`([^`]+)`|\[(\d{1,2})\](?!\()/g
    : /\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\*\*(.+?)\*\*|`([^`]+)`/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > cursor) tokens.push({ text: text.slice(cursor, index) });
    if (match[1] !== undefined) {
      const href = safeLink(match[2], true);
      tokens.push(href ? { text: match[1], href } : { text: match[0] });
    } else if (match[3] !== undefined) tokens.push({ text: match[3], strong: true });
    else if (match[4] !== undefined) tokens.push({ text: match[4], code: true });
    else tokens.push({ text: match[0], citation: Number(match[5]) });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor) });
  return tokens;
}
