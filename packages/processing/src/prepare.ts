// 清洗与切片：由文档原始内容生成正文、解析字段与切片。纯函数，Worker 在事务内调用后写库。
import { articleContent, articleQuestions, chunkArticle, type StructuredChunk } from "./chunking.js";
import { parseArticle, type ArticleDetail, type ParsedArticle } from "./article/parse.js";
import { contentFingerprint } from "./dedup.js";
import type { DocumentContentUpdate } from "./repository.js";

export function articleDocumentUpdate(article: ParsedArticle): DocumentContentUpdate {
  const content = articleContent(article);
  return {
    content,
    title: article.title || undefined,
    markdown: article.markdown,
    author: article.author,
    category: article.category,
    tags: article.tags,
    publishedAt: article.publishedAt ? new Date(article.publishedAt) : null,
    // 按参与检索的正文计算（不含文首元信息与相关阅读），用于跨来源判重。
    contentHash: contentFingerprint(content),
    parserVersion: article.parserVersion,
    metadata: {
      summary: article.summary, cover: article.cover, doi: article.doi, sourceMeta: article.sourceMeta, relatedArticleKeys: article.relatedArticleKeys,
      projectMeta: article.projectMeta, titleMeta: article.titleMeta,
      followUpQuestions: articleQuestions(article), attachments: article.attachments, images: article.images, media: article.media,
      isVIP: article.isVIP, original: article.original, unknownNodeTypes: article.unknownNodeTypes, demotedHeadings: article.demotedHeadings,
    },
  };
}

/** 从原始 JSON 重新解析并切片（解析器升级后重新处理即可生效）。 */
export function prepareDocument(documentId: string, input: { rawJson: ArticleDetail }): { update: DocumentContentUpdate; chunks: StructuredChunk[] } {
  const article = parseArticle(input.rawJson);
  return { update: articleDocumentUpdate(article), chunks: chunkArticle(documentId, article) };
}
