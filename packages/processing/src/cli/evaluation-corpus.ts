// 评估命令共用的语料读取：第二节范围内的文章（ready、非重复主文档）与语料快照。方案见 docs/evaluation-plan.md。
import { and, eq, isNull } from "drizzle-orm";
import type { ArticleMetadata } from "@nyz-rag/types";
import { getDb } from "../db.js";
import { corpusFingerprint, type CorpusSnapshot } from "../evaluation.js";
import { documents } from "../schema.js";
import type { CorpusArticle } from "../synthetic-questions.js";

export type EvaluationCorpusArticle = CorpusArticle & { documentId: string };

export async function loadCorpus(): Promise<{ articles: EvaluationCorpusArticle[]; snapshot: CorpusSnapshot }> {
  const rows = await getDb().select({
    documentId: documents.id, articleKey: documents.externalId, title: documents.title, category: documents.category, content: documents.content, metadata: documents.metadata,
    contentHash: documents.contentHash, publishedAt: documents.publishedAt, parserVersion: documents.parserVersion, embeddingStatus: documents.embeddingStatus, embeddingModel: documents.embeddingModel,
  }).from(documents).where(and(eq(documents.status, "ready"), isNull(documents.duplicateOf)));
  const parserVersions: Record<string, number> = {};
  const models = new Map<string, number>();
  let embedded = 0;
  for (const row of rows) {
    parserVersions[String(row.parserVersion)] = (parserVersions[String(row.parserVersion)] ?? 0) + 1;
    if (row.embeddingStatus === "ready") {
      embedded += 1;
      if (row.embeddingModel) models.set(row.embeddingModel, (models.get(row.embeddingModel) ?? 0) + 1);
    }
  }
  const embeddingModel = [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    articles: rows.map((row) => ({
      documentId: row.documentId, articleKey: row.articleKey, title: row.title, category: row.category, content: row.content,
      metadata: row.metadata as ArticleMetadata | null, contentHash: row.contentHash, publishedAt: row.publishedAt,
    })),
    snapshot: {
      documents: rows.length,
      fingerprint: corpusFingerprint(rows),
      parserVersions,
      chunkerVersion: null,
      embeddingModel,
      embeddingCoverage: rows.length ? Math.round((embedded / rows.length) * 10_000) / 10_000 : 0,
    },
  };
}
