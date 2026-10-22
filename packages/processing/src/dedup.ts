// 文档去重的纯逻辑：URL 规范化、canonical 地址提取与正文指纹。
import { createHash } from "node:crypto";

// 只去掉明确的跟踪参数；其余参数可能决定页面内容（分页、ID 等），一律保留。
const TRACKING_PARAMS = new Set(["gclid", "gbraid", "wbraid", "dclid", "fbclid", "msclkid", "yclid", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "spm"]);
const isTrackingParam = (name: string) => name.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(name.toLowerCase());

/**
 * 规范化 http(s) 地址：协议与主机小写、去掉默认端口和片段、去掉跟踪参数、查询参数按名称排序（同名参数保持原顺序）。
 * 路径不做改动（尾部斜杠、大小写可能对应不同页面）。不是 http(s) 地址时返回 null。
 */
export function normalizeUrl(value: string, base?: string): string | null {
  let url: URL;
  try { url = new URL(value.trim(), base); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  // 按原始编码处理参数，不经 URLSearchParams 重新编码（`?a` 不会变成 `?a=`）。
  const paramName = (pair: string) => { const raw = pair.split("=", 1)[0].replace(/\+/g, " "); try { return decodeURIComponent(raw); } catch { return raw; } };
  const params = url.search.slice(1).split("&").filter((pair) => pair && !isTrackingParam(paramName(pair)));
  params.sort((a, b) => { const [x, y] = [paramName(a), paramName(b)]; return x < y ? -1 : x > y ? 1 : 0; });
  url.search = params.join("&");
  return url.toString();
}

/**
 * 页面声明的 canonical 地址（规范化后），没有或无效时返回 null。
 * 非首页指向站点首页的 canonical 多为站点配置错误，忽略，否则所有页面会被合并为一篇。
 */
export function canonicalUrlFromHtml(html: string, pageUrl: string): string | null {
  const head = html.match(/<head\b[\s\S]*?<\/head>/i)?.[0] ?? html;
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const rel = tag.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2] ?? tag.match(/\brel\s*=\s*([^\s"'>]+)/i)?.[1];
    if (!rel?.toLowerCase().split(/\s+/).includes("canonical")) continue;
    const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2] ?? tag.match(/\bhref\s*=\s*([^\s"'>]+)/i)?.[1];
    const canonical = href ? normalizeUrl(href.replace(/&amp;/gi, "&"), pageUrl) : null;
    if (!canonical) return null;
    const page = new URL(pageUrl);
    const target = new URL(canonical);
    if (target.pathname === "/" && !target.search && (page.pathname !== "/" || page.search)) return null;
    return canonical;
  }
  return null;
}

// 正文过短（如「加载中」占位页、无权限提示）时不判定重复，避免无关文档被合并。
export const DEDUP_MIN_LENGTH = 50;

const fingerprintText = (content: string) => content.normalize("NFKC").replace(/\s+/gu, "");

/** 正文指纹：NFKC 规范化并去掉全部空白后的 SHA-256，排版差异（换行、空格、全半角）不影响结果。 */
export function contentFingerprint(content: string): string {
  return createHash("sha256").update(fingerprintText(content)).digest("hex");
}

/** 正文是否足够长，可以参与重复判定。 */
export const isDedupCandidate = (content: string) => fingerprintText(content).length >= DEDUP_MIN_LENGTH;
