// 评估命令共用的语料读取：第二节范围内的文章（ready、非重复主文档）与语料快照；评估用的实验 schema 与模型调用重试。方案见 docs/evaluation-plan.md。
import { and, eq, isNull } from "drizzle-orm";
import type { ArticleMetadata } from "@nyz-rag/types";
import { AdmissionError } from "../admission.js";
import { getDb } from "../db.js";
import { corpusFingerprint, normalizeEvidenceText, type CorpusSnapshot, type EvaluationQuestion } from "../evaluation.js";
import { sourceLabels } from "../evaluation-run.js";
import { documents } from "../schema.js";
import { evidenceSource, type CorpusArticle } from "../synthetic-questions.js";

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

/**
 * 只在本地限流（AdmissionError）时重试，其他错误照常抛出。用于检索问题改写：问答中改写超时或失败即用原问题检索、只有限流整次报错，
 * 评估按同样规则不重试改写，否则长尾延迟会被重试掩盖；限流取决于评估自身的并发，重试后不计入改写耗时（每次调用重新计时）。
 */
export async function withAdmissionRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try { return await call(); }
    catch (error) {
      if (!(error instanceof AdmissionError) || retry >= 2) throw error;
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

/**
 * 因语料变化需排除的原因：来源文章已不在语料中，或证据已不在原文（metadata 题含标题与元数据线索）中；仍有效时为 undefined。
 * 标注到「文章 + 证据」，与切片无关。
 */
export function staleQuestionReason(question: EvaluationQuestion, byKey: Map<string, CorpusArticle>): string | undefined {
  for (const label of sourceLabels(question)) {
    const article = byKey.get(label.articleKey);
    if (!article) return `来源文章 ${label.articleKey} 不在语料中`;
    const source = normalizeEvidenceText(evidenceSource(article, question.type === "metadata" ? "metadata" : "fact"));
    if (label.evidence.some((text) => !source.includes(normalizeEvidenceText(text)))) return `证据已不在来源文章 ${label.articleKey} 中`;
  }
  return undefined;
}
