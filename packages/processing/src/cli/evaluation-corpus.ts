// 评估命令共用的语料读取：第二节范围内的文章（ready、非重复主文档）与语料快照；评估用的实验 schema 与模型调用重试。方案见 docs/evaluation-plan.md。
import { and, eq, isNull } from "drizzle-orm";
import type { ArticleMetadata } from "@nyz-rag/types";
import { getDb } from "../db.js";
import { corpusFingerprint, type CorpusSnapshot } from "../evaluation.js";
import { documents } from "../schema.js";
import type { CorpusArticle } from "../synthetic-questions.js";

export type EvaluationCorpusArticle = CorpusArticle & { documentId: string };

/** 实验 schema 的名称：evaluate:index 只创建、重建这种名称的 schema，避免误删业务或测试 schema。 */
export const EVALUATION_SCHEMA = /^eval_[a-z0-9_]{1,40}$/;

/**
 * 让之后创建的数据库连接使用实验 schema（search_path 为「实验 schema, public」，pgvector 类型仍从 public 解析），须在首次 getDb() 前调用。
 * 实验 schema 由 evaluate:index 建立，包含完整的表结构，不会落到 public 的同名表。
 */
export function useEvaluationSchema(schema: string): void {
  if (!EVALUATION_SCHEMA.test(schema)) throw new Error("--schema must look like eval_<name> (lowercase letters, digits and underscores)");
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("DATABASE_URL is required.");
  const url = new URL(raw);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** 模型调用（含限流拒绝）最多重试 2 次，避免偶发故障把 Rerank 降级为合并排序、污染指标。 */
export async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try { return await call(); }
    catch (error) {
      if (retry >= 2) throw error;
      await sleep(2_000 * (retry + 1) ** 2);
    }
  }
}

export async function loadCorpus(): Promise<{ articles: EvaluationCorpusArticle[]; snapshot: CorpusSnapshot }> {
  const rows = await getDb().select({
    documentId: documents.id, articleKey: documents.externalId, title: documents.title, category: documents.category, content: documents.content, metadata: documents.metadata,
    contentHash: documents.contentHash, publishedAt: documents.publishedAt, parserVersion: documents.parserVersion, chunkerVersion: documents.chunkerVersion,
    embeddingStatus: documents.embeddingStatus, embeddingModel: documents.embeddingModel,
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
  // 全部文档使用同一切片规则时记录其版本；引入版本号前切片的文档（规则 1）或规则混用时为 null。
  const chunkerVersions = new Set(rows.map((row) => row.chunkerVersion));
  return {
    articles: rows.map((row) => ({
      documentId: row.documentId, articleKey: row.articleKey, title: row.title, category: row.category, content: row.content,
      metadata: row.metadata as ArticleMetadata | null, contentHash: row.contentHash, publishedAt: row.publishedAt,
    })),
    snapshot: {
      documents: rows.length,
      fingerprint: corpusFingerprint(rows),
      parserVersions,
      chunkerVersion: chunkerVersions.size === 1 ? [...chunkerVersions][0] : null,
      embeddingModel,
      embeddingCoverage: rows.length ? Math.round((embedded / rows.length) * 10_000) / 10_000 : 0,
    },
  };
}
