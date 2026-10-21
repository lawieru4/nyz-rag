// Drizzle 表结构定义；修改后运行 pnpm db:generate 生成迁移。列名由 casing: "snake_case" 自动映射。
import { sql } from "drizzle-orm";
import { boolean, check, customType, doublePrecision, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type { ChatFeedbackRating, CrawlTaskRecord, DataSourceRecord, DocumentProcessingStatus, DocumentStatus, EmbeddingStatus } from "@nyz-rag/types";

// pgvector 列不限维度，以支持不同 Embedding 模型；drizzle 内置 vector 类型要求固定维度，因此自定义。
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

const timestamptz = () => timestamp({ withTimezone: true });

export const dataSources = pgTable("data_sources", {
  id: text().primaryKey(),
  name: text().notNull(),
  url: text().notNull(),
  kind: text().$type<DataSourceRecord["kind"]>().notNull(),
  frequency: text().notNull().default(""),
  status: text().$type<DataSourceRecord["status"]>().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
  syncedAt: timestamptz(),
}, (table) => [
  check("data_sources_kind_check", sql`${table.kind} IN ('文章 API', '网页站点')`),
  check("data_sources_status_check", sql`${table.status} IN ('运行中', '已暂停')`),
]);

export const crawlTasks = pgTable("crawl_tasks", {
  id: text().primaryKey(),
  sourceId: text().notNull().references(() => dataSources.id, { onDelete: "cascade" }),
  sourceName: text().notNull(),
  status: text().$type<CrawlTaskRecord["status"]>().notNull(),
  progress: integer().notNull().default(0),
  error: text(),
  createdAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  index("crawl_tasks_created_at_idx").on(table.createdAt.desc()),
  check("crawl_tasks_status_check", sql`${table.status} IN ('等待中', '运行中', '已完成', '失败')`),
  check("crawl_tasks_progress_check", sql`${table.progress} BETWEEN 0 AND 100`),
]);

export const documents = pgTable("documents", {
  id: text().primaryKey(),
  sourceId: text().notNull().references(() => dataSources.id, { onDelete: "cascade" }),
  title: text().notNull(),
  url: text().notNull(),
  content: text().notNull().default(""),
  rawHtml: text(),
  status: text().$type<DocumentStatus>().notNull(),
  processingStatus: text().$type<DocumentProcessingStatus>().notNull().default("pending"),
  processingError: text(),
  // 每次重新切片加一；向量化回写前比对，防止把旧切片的向量写到新切片上。
  processingVersion: integer().notNull().default(0),
  embeddingStatus: text().$type<EmbeddingStatus>().notNull().default("pending"),
  embeddingProviderId: text(),
  embeddingModel: text(),
  embeddingDimensions: integer(),
  embeddingChunkCount: integer().notNull().default(0),
  embeddingError: text(),
  embeddingUpdatedAt: timestamptz(),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  unique("documents_source_id_url_key").on(table.sourceId, table.url),
  index("documents_status_idx").on(table.status),
  index("documents_updated_at_idx").on(table.updatedAt.desc()),
  check("documents_status_check", sql`${table.status} IN ('pending', 'processing', 'ready', 'failed')`),
  check("documents_processing_status_check", sql`${table.processingStatus} IN ('pending', 'cleaning', 'chunked', 'failed')`),
  check("documents_embedding_status_check", sql`${table.embeddingStatus} IN ('pending', 'queued', 'processing', 'ready', 'failed')`),
]);

export const documentChunks = pgTable("document_chunks", {
  id: text().primaryKey(),
  documentId: text().notNull().references(() => documents.id, { onDelete: "cascade" }),
  chunkIndex: integer().notNull(),
  content: text().notNull(),
  tokenEstimate: integer().notNull(),
  providerId: text(),
  model: text(),
  dimensions: integer(),
  embedding: vector(),
  embeddedAt: timestamptz(),
}, (table) => [
  unique("document_chunks_document_id_chunk_index_key").on(table.documentId, table.chunkIndex),
  check("document_chunks_chunk_index_check", sql`${table.chunkIndex} >= 0`),
  check("document_chunks_embedding_check", sql`(${table.embedding} IS NULL) = (${table.dimensions} IS NULL)`),
]);

export const knowledgeBases = pgTable("knowledge_bases", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text().notNull().default(""),
  topK: integer().notNull(),
  similarityThreshold: doublePrecision().notNull(),
  rerankEnabled: boolean().notNull().default(false),
  maxContextLength: integer().notNull(),
  prompt: text().notNull().default(""),
  model: text().notNull().default(""),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  check("knowledge_bases_top_k_check", sql`${table.topK} BETWEEN 1 AND 100`),
  check("knowledge_bases_similarity_threshold_check", sql`${table.similarityThreshold} BETWEEN 0 AND 1`),
  check("knowledge_bases_max_context_length_check", sql`${table.maxContextLength} >= 256`),
]);

// 只保存密钥的环境变量名，密钥值不入库。
export const modelProviders = pgTable("model_providers", {
  id: text().primaryKey(),
  name: text().notNull(),
  provider: text().notNull(),
  baseUrl: text().notNull().default(""),
  chatModel: text().notNull(),
  embeddingModel: text().notNull().default(""),
  rerankModel: text().notNull().default(""),
  credentialEnv: text().notNull(),
  enabled: boolean().notNull().default(false),
  isDefault: boolean().notNull().default(false),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  uniqueIndex("model_providers_single_default_idx").on(table.isDefault).where(sql`${table.isDefault}`),
]);

export const chatMessages = pgTable("chat_messages", {
  id: text().primaryKey(),
  question: text().notNull(),
  answer: text().notNull(),
  rating: text().$type<ChatFeedbackRating>(),
  createdAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  index("chat_messages_created_at_idx").on(table.createdAt.desc()),
  check("chat_messages_rating_check", sql`${table.rating} IN ('positive', 'negative')`),
]);

// 文档删除后仍保留问答记录中的引用标题与链接，因此 document_id 不设外键。
export const messageSources = pgTable("message_sources", {
  messageId: text().notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
  position: integer().notNull(),
  documentId: text().notNull(),
  title: text().notNull(),
  url: text().notNull(),
}, (table) => [primaryKey({ columns: [table.messageId, table.position] })]);
