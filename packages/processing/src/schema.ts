// Drizzle 表结构定义；修改后运行 pnpm db:generate 生成迁移。列名由 casing: "snake_case" 自动映射。
import { sql } from "drizzle-orm";
import { boolean, check, customType, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  ArticleMetadata, ArticleSourceSyncState, ChatAnswerMode, ChatFeedbackRating, CrawlTaskRecord, DataSourceRecord, DocumentChunkRecord, DocumentProcessingStatus, DocumentStatus, EmbeddingStatus,
} from "@nyz-rag/types";

// pgvector 列不限维度，以支持不同 Embedding 模型；drizzle 内置 vector 类型要求固定维度，因此自定义。
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => JSON.parse(value) as number[],
});

// 只用于写入（array_to_tsvector）与 @@ 查询，不读取到应用层。
const tsvector = customType<{ data: string; driverData: string }>({ dataType: () => "tsvector" });

const timestamptz = () => timestamp({ withTimezone: true });

export const dataSources = pgTable("data_sources", {
  id: text().primaryKey(),
  name: text().notNull(),
  url: text().notNull(),
  kind: text().$type<DataSourceRecord["kind"]>().notNull(),
  frequency: text().notNull().default(""),
  status: text().$type<DataSourceRecord["status"]>().notNull(),
  syncState: jsonb().$type<ArticleSourceSyncState>().notNull().default({}),
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
  // 文章 API 来源：来源标识、原始详情 JSON（解析器升级时据此重新解析）与解析结果。
  externalId: text(),
  rawJson: jsonb(),
  sourceUpdatedAt: timestamptz(),
  markdown: text(),
  author: text(),
  category: text(),
  tags: text().array().notNull().default(sql`'{}'::text[]`),
  publishedAt: timestamptz(),
  contentHash: text(),
  parserVersion: integer(),
  metadata: jsonb().$type<ArticleMetadata>(),
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
  unique("documents_source_id_external_id_key").on(table.sourceId, table.externalId),
  index("documents_published_at_idx").on(table.publishedAt.desc()),
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
  // 向量化时拼接在正文前的上下文前缀。
  context: text().notNull().default(""),
  sectionPath: text().array().notNull().default(sql`'{}'::text[]`),
  contentType: text().$type<NonNullable<DocumentChunkRecord["contentType"]>>().notNull().default("text"),
  // 关键词检索词项（NFKC 规范化后的中文重叠二元组与英文/数字词）：由 search-terms.ts 在应用层生成，
  // 经 array_to_tsvector 写入，不经过数据库分词器，与 locale 无关。
  searchVector: tsvector().notNull().default(sql`''::tsvector`),
  tokenEstimate: integer().notNull(),
  providerId: text(),
  model: text(),
  dimensions: integer(),
  embedding: vector(),
  embeddedAt: timestamptz(),
}, (table) => [
  unique("document_chunks_document_id_chunk_index_key").on(table.documentId, table.chunkIndex),
  index("document_chunks_search_vector_idx").using("gin", table.searchVector),
  check("document_chunks_chunk_index_check", sql`${table.chunkIndex} >= 0`),
  check("document_chunks_content_type_check", sql`${table.contentType} IN ('text', 'table')`),
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
  temperature: doublePrecision().notNull().default(0.3),
  maxTokens: integer().notNull().default(1024),
  credentialEnv: text().notNull(),
  enabled: boolean().notNull().default(false),
  isDefault: boolean().notNull().default(false),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  uniqueIndex("model_providers_single_default_idx").on(table.isDefault).where(sql`${table.isDefault}`),
  check("model_providers_temperature_check", sql`${table.temperature} BETWEEN 0 AND 2`),
  check("model_providers_max_tokens_check", sql`${table.maxTokens} BETWEEN 1 AND 32768`),
]);

export const chatSessions = pgTable("chat_sessions", {
  id: text().primaryKey(),
  title: text().notNull().default(""),
  // 知识库可能被删除，不设外键；删除后回退到最近创建的知识库。
  knowledgeBaseId: text(),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [index("chat_sessions_updated_at_idx").on(table.updatedAt.desc())]);

export const chatMessages = pgTable("chat_messages", {
  id: text().primaryKey(),
  // 早期单次问答没有会话。
  sessionId: text().references(() => chatSessions.id, { onDelete: "cascade" }),
  // 被重新生成替换的回答不再出现在会话中。
  supersededAt: timestamptz(),
  question: text().notNull(),
  answer: text().notNull(),
  answerMode: text().$type<ChatAnswerMode>().notNull().default("extractive"),
  // 知识库可能被删除，不设外键。
  knowledgeBaseId: text(),
  model: text(),
  retrievalMs: integer(),
  firstTokenMs: integer(),
  totalMs: integer(),
  promptTokens: integer(),
  completionTokens: integer(),
  rating: text().$type<ChatFeedbackRating>(),
  createdAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  index("chat_messages_created_at_idx").on(table.createdAt.desc()),
  index("chat_messages_session_id_idx").on(table.sessionId, table.createdAt),
  check("chat_messages_rating_check", sql`${table.rating} IN ('positive', 'negative')`),
  check("chat_messages_answer_mode_check", sql`${table.answerMode} IN ('generated', 'extractive')`),
]);

// 文档删除后仍保留问答记录中的引用标题与链接，因此 document_id 不设外键。
export const messageSources = pgTable("message_sources", {
  messageId: text().notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
  position: integer().notNull(),
  documentId: text().notNull(),
  title: text().notNull(),
  url: text().notNull(),
  repostSource: text(),
}, (table) => [primaryKey({ columns: [table.messageId, table.position] })]);

// 送入模型的召回片段；切片会随重新处理变化，因此保存摘录与章节，chunk_id 不设外键。
export const messageChunks = pgTable("message_chunks", {
  messageId: text().notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
  position: integer().notNull(),
  chunkId: text().notNull(),
  documentId: text().notNull(),
  citation: integer().notNull(),
  title: text().notNull(),
  sectionPath: text().array().notNull().default(sql`'{}'::text[]`),
  excerpt: text().notNull(),
  score: doublePrecision().notNull(),
  vectorScore: doublePrecision(),
  keywordScore: doublePrecision(),
  rerankScore: doublePrecision(),
}, (table) => [primaryKey({ columns: [table.messageId, table.position] })]);
