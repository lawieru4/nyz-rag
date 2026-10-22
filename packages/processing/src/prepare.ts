// 清洗与切片：由文档原始内容生成正文、解析字段与切片。纯函数，Worker 在事务内调用后写库。
import { articleContent, articleQuestions, chunkArticle, chunkText, type StructuredChunk } from "./chunking.js";
import { parseArticle, type ArticleDetail, type ParsedArticle } from "./article/parse.js";
import type { DocumentContentUpdate } from "./repository.js";

export function articleDocumentUpdate(article: ParsedArticle): DocumentContentUpdate {
  return {
    content: articleContent(article),
    title: article.title || undefined,
    markdown: article.markdown,
    author: article.author,
    category: article.category,
    tags: article.tags,
    publishedAt: article.publishedAt ? new Date(article.publishedAt) : null,
    contentHash: article.contentHash,
    parserVersion: article.parserVersion,
    metadata: {
      summary: article.summary, cover: article.cover, doi: article.doi, sourceMeta: article.sourceMeta, relatedArticleKeys: article.relatedArticleKeys,
      projectMeta: article.projectMeta,
      followUpQuestions: articleQuestions(article), attachments: article.attachments, images: article.images, media: article.media,
      isVIP: article.isVIP, original: article.original, unknownNodeTypes: article.unknownNodeTypes, demotedHeadings: article.demotedHeadings,
    },
  };
}

/** 文章来源从原始 JSON 重新解析（解析器升级后重新处理即可生效）；其他来源按已提取的正文切片，保留换行结构。 */
export function prepareDocument(documentId: string, input: { title: string; content: string; rawJson: ArticleDetail | null }): { update: DocumentContentUpdate; chunks: StructuredChunk[] } {
  if (input.rawJson) {
    const article = parseArticle(input.rawJson);
    return { update: articleDocumentUpdate(article), chunks: chunkArticle(documentId, article) };
  }
  return { update: { content: input.content }, chunks: chunkText(documentId, input.title, input.content) };
}
