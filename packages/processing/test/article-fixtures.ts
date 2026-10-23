// 集成测试共用的文章夹具：数据源只接入 nyzdata 文章接口，文档必须带原始详情 JSON。
import type { ArticleDetail } from "../src/article/parse.js";
import type { UpsertDocumentInput } from "../src/repository.js";

export const ARTICLE_LIST_URL = "https://example.test/nyz/article?tagKey=1";

/** 文章详情：每段一个 ProseMirror 段落，没有标题与文首元信息。 */
export function articleDetail(key: string, title: string, body: string | string[], extra: Partial<ArticleDetail> = {}): ArticleDetail {
  const paragraphs = (Array.isArray(body) ? body : [body]).filter(Boolean);
  return { _key: key, title, content: { type: "doc", content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) }, ...extra };
}

/** 文档写入参数；content 为解析前的占位正文，processDocument 会按原始 JSON 重新生成。 */
export function articleDocument(sourceId: string, key: string, title: string, body: string | string[]): UpsertDocumentInput {
  return {
    sourceId, externalId: key, url: `https://example.test/articles/${key}`, title, content: Array.isArray(body) ? body.join("\n\n") : body,
    rawJson: articleDetail(key, title, body), status: "ready",
  };
}
