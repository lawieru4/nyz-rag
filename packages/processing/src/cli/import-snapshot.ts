// 一次性导入：旧 JSON 快照 + document_vectors 表 → PostgreSQL 新表。可重复执行，已存在的记录跳过。
// 用法：pnpm db:import-snapshot [快照绝对路径]；默认读取 NYZ_STORE_PATH 或仓库根目录 .nyz-data/knowledge.json。
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, exists, isNull, notExists, sql } from "drizzle-orm";
import type { ChatLogRecord, CrawlTaskRecord, DataSourceRecord, DocumentChunkRecord, DocumentEmbeddingRecord, DocumentRecord, KnowledgeBaseRecord, ModelProviderRecord } from "@nyz-rag/types";
import { closeDatabase, migrate, withTransaction } from "../db.js";
import { createChatMessage } from "../repository.js";
import { chatMessages, crawlTasks, dataSources, documentChunks, documents, knowledgeBases, modelProviders } from "../schema.js";

type LegacyDocument = Omit<DocumentRecord, "canonicalUrl" | "processingStatus" | "embedding" | "chunks" | "chunkCount"> & {
  processingStatus?: DocumentRecord["processingStatus"];
  embedding?: DocumentEmbeddingRecord;
  chunks?: DocumentChunkRecord[];
};

interface LegacySnapshot {
  sources?: DataSourceRecord[];
  tasks?: CrawlTaskRecord[];
  documents?: LegacyDocument[];
  knowledgeBases?: KnowledgeBaseRecord[];
  chatLogs?: ChatLogRecord[];
  modelProviders?: ModelProviderRecord[];
}

const path = resolve(process.argv[2] ?? process.env.NYZ_STORE_PATH ?? "../../.nyz-data/knowledge.json");
const snapshot = JSON.parse(await readFile(path, "utf8")) as LegacySnapshot;
// 旧快照按“新的在前”保存且来源没有创建时间，按数组顺序递减生成，保持列表顺序。
const orderedTime = (index: number) => new Date(Date.now() - index);
const date = (value: string | null | undefined, fallback: Date | null = null) => value ? new Date(value) : fallback;

try {
  await migrate();
  const counts = await withTransaction(async (tx) => {
    const counts = { sources: 0, tasks: 0, documents: 0, skippedDocuments: 0, chunks: 0, vectors: 0, knowledgeBases: 0, modelProviders: 0, chatLogs: 0 };
    for (const [index, source] of (snapshot.sources ?? []).entries()) {
      counts.sources += (await tx.insert(dataSources).values({
        id: source.id, name: source.name, url: source.url, kind: source.kind, frequency: source.frequency ?? "", status: source.status,
        createdAt: orderedTime(index), syncedAt: date(source.updatedAt),
      }).onConflictDoNothing().returning({ id: dataSources.id })).length;
    }
    const sourceIds = new Set((await tx.select({ id: dataSources.id }).from(dataSources)).map((row) => row.id));

    for (const task of snapshot.tasks ?? []) {
      if (!sourceIds.has(task.sourceId)) continue;
      // 导入时仍处于等待/运行状态的任务已不在队列中，标记为失败。
      const stale = task.status === "等待中" || task.status === "运行中";
      counts.tasks += (await tx.insert(crawlTasks).values({
        id: task.id, sourceId: task.sourceId, sourceName: task.sourceName, status: stale ? "失败" : task.status, progress: task.progress,
        error: stale ? "迁移到数据库时任务未完成" : task.error ?? null, createdAt: new Date(task.createdAt),
      }).onConflictDoNothing().returning({ id: crawlTasks.id })).length;
    }

    for (const document of snapshot.documents ?? []) {
      if (!sourceIds.has(document.sourceId)) { counts.skippedDocuments += 1; continue; }
      const chunks = document.chunks ?? [];
      const processingStatus = document.processingStatus === "cleaning" ? "pending" : document.processingStatus ?? (document.status === "ready" ? "chunked" : "pending");
      const embedding = document.embedding?.status === "ready" || document.embedding?.status === "failed" ? document.embedding : { status: "pending" as const, chunkCount: 0 };
      const inserted = await tx.insert(documents).values({
        id: document.id, sourceId: document.sourceId, title: document.title, url: document.url, canonicalUrl: document.url, content: document.content ?? "", rawHtml: document.rawHtml ?? null,
        status: document.status, processingStatus, processingError: document.processingError ?? null, processingVersion: processingStatus === "chunked" ? 1 : 0,
        embeddingStatus: embedding.status, embeddingProviderId: embedding.providerId ?? null, embeddingModel: embedding.model ?? null,
        embeddingDimensions: embedding.dimensions ?? null, embeddingChunkCount: embedding.chunkCount, embeddingError: embedding.error ?? null,
        embeddingUpdatedAt: date(embedding.updatedAt), createdAt: new Date(document.createdAt), updatedAt: new Date(document.updatedAt),
      }).onConflictDoNothing().returning({ id: documents.id });
      if (!inserted.length) continue;
      counts.documents += 1;
      if (!chunks.length) continue;
      counts.chunks += (await tx.insert(documentChunks).values(chunks.map((chunk) => ({
        id: chunk.id, documentId: document.id, chunkIndex: chunk.index, content: chunk.content, tokenEstimate: chunk.tokenEstimate,
      }))).onConflictDoNothing().returning({ id: documentChunks.id })).length;
    }

    // 旧向量表不在 Drizzle schema 中，使用原始 SQL；表已删除时跳过。
    const { rows: [legacy] } = await tx.execute<{ present: boolean }>(sql`SELECT to_regclass('document_vectors') IS NOT NULL AS present`);
    if (legacy.present) {
      counts.vectors = (await tx.execute(sql`
        UPDATE document_chunks c SET embedding = v.embedding, provider_id = v.provider_id, model = v.model, dimensions = v.dimensions, embedded_at = v.updated_at
        FROM document_vectors v WHERE v.document_id = c.document_id AND v.chunk_id = c.id AND c.embedding IS NULL`)).rowCount ?? 0;
    }
    // 快照标记已向量化、但向量缺失或切片不完整的文档，重置为待向量化。
    const chunksOf = tx.select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentId, documents.id));
    const missingVector = tx.select({ id: documentChunks.id }).from(documentChunks).where(and(eq(documentChunks.documentId, documents.id), isNull(documentChunks.embedding)));
    await tx.update(documents)
      .set({ embeddingStatus: "pending", embeddingProviderId: null, embeddingModel: null, embeddingDimensions: null, embeddingChunkCount: 0 })
      .where(and(eq(documents.embeddingStatus, "ready"), sql`(${notExists(chunksOf)} OR ${exists(missingVector)})`));

    for (const [index, base] of (snapshot.knowledgeBases ?? []).entries()) {
      counts.knowledgeBases += (await tx.insert(knowledgeBases).values({
        id: base.id, name: base.name, description: base.description ?? "", topK: base.topK, similarityThreshold: base.similarityThreshold,
        rerankEnabled: base.rerankEnabled ?? false, maxContextLength: base.maxContextLength, prompt: base.prompt ?? "", model: base.model ?? "",
        createdAt: date(base.createdAt, orderedTime(index))!, updatedAt: date(base.updatedAt, orderedTime(index))!,
      }).onConflictDoNothing().returning({ id: knowledgeBases.id })).length;
    }

    // 数据库唯一索引只允许一个默认供应商；旧数据有多个默认时保留第一个。
    let defaultTaken = (await tx.select({ id: modelProviders.id }).from(modelProviders).where(eq(modelProviders.isDefault, true))).length > 0;
    for (const [index, provider] of (snapshot.modelProviders ?? []).entries()) {
      const isDefault = provider.isDefault && !defaultTaken;
      const inserted = (await tx.insert(modelProviders).values({
        id: provider.id, name: provider.name, provider: provider.provider, baseUrl: provider.baseUrl ?? "", chatModel: provider.chatModel,
        embeddingModel: provider.embeddingModel ?? "", rerankModel: provider.rerankModel ?? "", credentialEnv: provider.credentialEnv,
        enabled: provider.enabled, isDefault, createdAt: date(provider.createdAt, orderedTime(index))!, updatedAt: date(provider.updatedAt, orderedTime(index))!,
      }).onConflictDoNothing().returning({ id: modelProviders.id })).length;
      if (inserted && isDefault) defaultTaken = true;
      counts.modelProviders += inserted;
    }

    for (const log of snapshot.chatLogs ?? []) {
      if ((await tx.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.id, log.id))).length) continue;
      await createChatMessage(log, tx);
      counts.chatLogs += 1;
    }
    return counts;
  });
  console.info(`导入完成（${path}）：`, counts);
  if (counts.skippedDocuments) console.warn(`${counts.skippedDocuments} 篇文档的数据源不存在，已跳过`);
  if (counts.vectors) console.info("确认数据无误后，可由管理员执行 DROP TABLE document_vectors 删除旧向量表。");
} finally {
  await closeDatabase();
}
