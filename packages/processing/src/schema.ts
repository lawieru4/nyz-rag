// Drizzle 表结构定义；修改后运行 pnpm db:generate 生成迁移。列名由 casing: "snake_case" 自动映射。
import { sql } from "drizzle-orm";
import { boolean, check, customType, type AnyPgColumn, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  AdminAuditResult, ArticleMetadata, ArticleSourceSyncState, ChatAnswerMode, ChatFeedbackRating, CrawlTaskRecord, DataSourceRecord, DocumentChunkRecord, DocumentProcessingStatus, DocumentStatus, EmbeddingStatus, ModelCapability,
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

// vector HNSW supports at most 2000 dimensions; other sizes retain exact search.
export const HNSW_DIMENSIONS = [384, 512, 768, 1024, 1536, 2000] as const;

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
  // 只接入 nyzdata 文章接口。
  check("data_sources_kind_check", sql`${table.kind} = '文章 API'`),
  check("data_sources_status_check", sql`${table.status} IN ('运行中', '已暂停')`),
]);

export const ACTIVE_TASK_INDEX = "crawl_tasks_active_source_idx";

export const crawlTasks = pgTable("crawl_tasks", {
  id: text().primaryKey(),
  sourceId: text().notNull().references(() => dataSources.id, { onDelete: "cascade" }),
  sourceName: text().notNull(),
  status: text().$type<CrawlTaskRecord["status"]>().notNull(),
  progress: integer().notNull().default(0),
  /** 本次已处理（成功）与失败的文章数，以及单次同步上限。 */
  processedCount: integer().notNull().default(0),
  failedCount: integer().notNull().default(0),
  articleLimit: integer(),
  error: text(),
  createdAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  index("crawl_tasks_created_at_idx").on(table.createdAt.desc()),
  // 同一来源同时只能有一个等待中或运行中的同步任务（API 创建任务时由它原子互斥）。
  uniqueIndex(ACTIVE_TASK_INDEX).on(table.sourceId).where(sql`${table.status} IN ('等待中', '运行中')`),
  check("crawl_tasks_status_check", sql`${table.status} IN ('等待中', '运行中', '已完成', '失败')`),
  check("crawl_tasks_progress_check", sql`${table.progress} BETWEEN 0 AND 100`),
]);

export const documents = pgTable("documents", {
  id: text().primaryKey(),
  sourceId: text().notNull().references(() => dataSources.id, { onDelete: "cascade" }),
  title: text().notNull(),
  // 规范化后的文章地址（引用与「打开原文」使用）。
  url: text().notNull(),
  // 规范地址，与 url 相同，同一来源内唯一。
  canonicalUrl: text().notNull(),
  content: text().notNull().default(""),
  // 来源标识（articleKey）、原始详情 JSON（解析器升级时据此重新解析）与解析结果。
  externalId: text().notNull(),
  rawJson: jsonb().notNull(),
  sourceUpdatedAt: timestamptz(),
  markdown: text(),
  author: text(),
  category: text(),
  tags: text().array().notNull().default(sql`'{}'::text[]`),
  publishedAt: timestamptz(),
  // 正文指纹（dedup.ts 的 contentFingerprint），切片时计算，用于跨来源/跨地址的重复判定。
  contentHash: text(),
  // 正文相同的主文档：重复文档保留来源记录与原始内容，但不切片、不向量化。主文档删除时由 API 选出接替者，此处置空只是兜底。
  duplicateOf: text().references((): AnyPgColumn => documents.id, { onDelete: "set null" }),
  parserVersion: integer(),
  // 切片规则版本（chunking.ts 的 CHUNKER_VERSION）；为空（引入前）或 1 的文档按丢字修正前的规则 1 切片，规则 1 现为 3。
  chunkerVersion: integer(),
  metadata: jsonb().$type<ArticleMetadata>(),
  // 元数据检索词项（关键词、项目名称、负责人、承担单位），规则与切片词项相同，用于关键词检索加权。
  metadataSearchVector: tsvector().notNull().default(sql`''::tsvector`),
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
  // 文章级向量（标题 + 摘要），与切片向量同一次写入，模型与维度沿用 embedding_model / embedding_dimensions；没有摘要的文章为空。
  summaryEmbedding: vector(),
  embeddingError: text(),
  embeddingUpdatedAt: timestamptz(),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  unique("documents_source_id_canonical_url_key").on(table.sourceId, table.canonicalUrl),
  unique("documents_source_id_external_id_key").on(table.sourceId, table.externalId),
  index("documents_published_at_idx").on(table.publishedAt.desc()),
  index("documents_category_idx").on(table.category),
  index("documents_tags_idx").using("gin", table.tags),
  index("documents_scenarios_idx").using("gin", sql`(${table.metadata}->'sourceMeta'->'scenarios')`),
  index("documents_metadata_search_vector_idx").using("gin", table.metadataSearchVector),
  index("documents_status_idx").on(table.status),
  index("documents_content_hash_idx").on(table.contentHash),
  index("documents_duplicate_of_idx").on(table.duplicateOf),
  index("documents_updated_at_idx").on(table.updatedAt.desc()),
  ...HNSW_DIMENSIONS.map((dimensions) => index(`documents_summary_embedding_${dimensions}_hnsw_idx`)
    .using("hnsw", sql`(${table.summaryEmbedding}::vector(${sql.raw(String(dimensions))})) vector_cosine_ops`)
    .where(sql`${table.embeddingDimensions} = ${sql.raw(String(dimensions))}`)),
  check("documents_summary_embedding_check", sql`${table.summaryEmbedding} IS NULL OR vector_dims(${table.summaryEmbedding}) = ${table.embeddingDimensions}`),
  check("documents_status_check", sql`${table.status} IN ('pending', 'processing', 'ready', 'failed')`),
  check("documents_processing_status_check", sql`${table.processingStatus} IN ('pending', 'cleaning', 'chunked', 'duplicate', 'failed')`),
  check("documents_duplicate_of_check", sql`${table.duplicateOf} <> ${table.id}`),
  check("documents_embedding_status_check", sql`${table.embeddingStatus} IN ('pending', 'queued', 'processing', 'ready', 'failed')`),
]);

// 切片规则 2 的父块（章节）：回答上下文的单位，不向量化、不建关键词词项，与切片在同一事务中整体替换。
export const documentSections = pgTable("document_sections", {
  id: text().primaryKey(),
  documentId: text().notNull().references(() => documents.id, { onDelete: "cascade" }),
  sectionIndex: integer().notNull(),
  sectionPath: text().array().notNull().default(sql`'{}'::text[]`),
  // 同一章节拆成多段时的段序号。
  part: integer().notNull().default(0),
  content: text().notNull(),
  tokenEstimate: integer().notNull(),
}, (table) => [
  unique("document_sections_document_id_section_index_key").on(table.documentId, table.sectionIndex),
  check("document_sections_index_check", sql`${table.sectionIndex} >= 0 AND ${table.part} >= 0`),
]);

export const documentChunks = pgTable("document_chunks", {
  id: text().primaryKey(),
  documentId: text().notNull().references(() => documents.id, { onDelete: "cascade" }),
  // 所属父块；切片规则 1 没有父块。
  sectionId: text().references(() => documentSections.id, { onDelete: "cascade" }),
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
  index("document_chunks_section_id_idx").on(table.sectionId),
  index("document_chunks_search_vector_idx").using("gin", table.searchVector),
  ...HNSW_DIMENSIONS.map((dimensions) => index(`document_chunks_embedding_${dimensions}_hnsw_idx`)
    .using("hnsw", sql`(${table.embedding}::vector(${sql.raw(String(dimensions))})) vector_cosine_ops`)
    .where(sql`${table.dimensions} = ${sql.raw(String(dimensions))}`)),
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

// 供应商只描述连接：密钥优先使用后台保存的密文（secrets.ts，绑定供应商 ID），其次读取 credential_env 指定的环境变量；都没有时不带认证头（本地模型）。
export const modelProviders = pgTable("model_providers", {
  id: text().primaryKey(),
  name: text().notNull(),
  provider: text().notNull(),
  baseUrl: text().notNull().default(""),
  credentialEnv: text().notNull().default(""),
  apiKeyCiphertext: text(),
  enabled: boolean().notNull().default(false),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
});

// 业务模型：Chat、Embedding、Rerank 各选一个供应商与模型；temperature / max_tokens 只用于 Chat。被使用的供应商不能删除。
export const modelSettings = pgTable("model_settings", {
  capability: text().$type<ModelCapability>().primaryKey(),
  providerId: text().notNull().references(() => modelProviders.id, { onDelete: "restrict" }),
  model: text().notNull(),
  temperature: doublePrecision().notNull().default(0.3),
  maxTokens: integer().notNull().default(1024),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  check("model_settings_capability_check", sql`${table.capability} IN ('chat', 'embedding', 'rerank', 'review')`),
  check("model_settings_model_check", sql`btrim(${table.model}) <> ''`),
  check("model_settings_temperature_check", sql`${table.temperature} BETWEEN 0 AND 2`),
  check("model_settings_max_tokens_check", sql`${table.maxTokens} BETWEEN 1 AND 1048576`),
]);

// 后台配置的全局密钥（如 nyzdata 文章接口 token），只存 secrets.ts 加密后的密文。
export const secretSettings = pgTable("secret_settings", {
  name: text().primaryKey(),
  ciphertext: text().notNull(),
  updatedAt: timestamptz().notNull().defaultNow(),
});

// 管理员角色：权限为 admin-permissions.ts 中的权限码（读取时过滤未知项）；停用后使用该角色的管理员没有任何权限。
export const adminRoles = pgTable("admin_roles", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text().notNull().default(""),
  permissions: text().array().notNull().default(sql`'{}'::text[]`),
  disabledAt: timestamptz(),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  uniqueIndex("admin_roles_name_idx").on(table.name),
]);

// 管理员账号：由超级管理员（或 seed）创建；email 存小写形式；isSuper 仅首个 seed 账号为 true。
export const adminAccounts = pgTable("admin_accounts", {
  id: text().primaryKey(),
  email: text().notNull(),
  nickname: text().notNull(),
  passwordHash: text().notNull(),
  isSuper: boolean().notNull().default(false),
  // 普通管理员的角色（一人一个）；超级管理员拥有全部权限，不分配角色。有管理员使用的角色不能删除。
  roleId: text().references(() => adminRoles.id, { onDelete: "restrict" }),
  // 修改密码或停用时加一，使已签发的会话全部失效。
  sessionVersion: integer().notNull().default(0),
  disabledAt: timestamptz(),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  uniqueIndex("admin_accounts_email_idx").on(table.email),
]);

// 管理端操作日志：由 API 在响应后写入（写操作与被拒绝的访问），只记操作者、动作、资源与结果，不含请求体与密钥。
// 匿名请求只记登录尝试（受登录限流约束），其余未登录请求只写进程日志，避免被刷库。
export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: text().primaryKey(),
  adminId: text().references(() => adminAccounts.id, { onDelete: "set null" }),
  method: text().notNull(),
  route: text().notNull(),
  resourceId: text(),
  statusCode: integer().notNull(),
  result: text().$type<AdminAuditResult>().notNull(),
  requestId: text().notNull(),
  ip: text().notNull(),
  createdAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  index("admin_audit_logs_created_at_idx").on(table.createdAt.desc(), table.id),
  index("admin_audit_logs_admin_id_idx").on(table.adminId, table.createdAt.desc()),
  check("admin_audit_logs_result_check", sql`${table.result} IN ('success', 'denied', 'failed')`),
]);

// 用户端账号：邮箱经验证码验证后才创建，email 存小写形式。
export const users = pgTable("users", {
  id: text().primaryKey(),
  email: text().notNull(),
  passwordHash: text().notNull(),
  // 修改/重置密码或停用时加一，使已签发的登录会话全部失效。
  sessionVersion: integer().notNull().default(0),
  disabledAt: timestamptz(),
  lastLoginAt: timestamptz(),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  uniqueIndex("users_email_idx").on(table.email),
  index("users_created_at_idx").on(table.createdAt.desc()),
]);

// 会话与问答的归属：注册用户（user_id）或匿名访客（visitor_hash，访客 Cookie 的 SHA-256），二者至多其一；
// 都为空的是用户体系上线前的历史数据，只在管理端可见。
export const chatSessions = pgTable("chat_sessions", {
  id: text().primaryKey(),
  title: text().notNull().default(""),
  // 知识库可能被删除，不设外键；删除后回退到最近创建的知识库。
  knowledgeBaseId: text(),
  userId: text().references(() => users.id, { onDelete: "cascade" }),
  visitorHash: text(),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  index("chat_sessions_updated_at_idx").on(table.updatedAt.desc()),
  index("chat_sessions_user_id_idx").on(table.userId, table.updatedAt.desc()).where(sql`${table.userId} IS NOT NULL`),
  index("chat_sessions_visitor_hash_idx").on(table.visitorHash, table.updatedAt.desc()).where(sql`${table.visitorHash} IS NOT NULL`),
  check("chat_sessions_single_owner_check", sql`${table.userId} IS NULL OR ${table.visitorHash} IS NULL`),
]);

export const chatMessages = pgTable("chat_messages", {
  id: text().primaryKey(),
  // 早期单次问答没有会话。
  sessionId: text().references(() => chatSessions.id, { onDelete: "cascade" }),
  // 与所属会话一致（单次问答取提问者），用于反馈归属校验；账号删除后保留问答记录。
  userId: text().references(() => users.id, { onDelete: "set null" }),
  visitorHash: text(),
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
  index("chat_messages_user_id_idx").on(table.userId).where(sql`${table.userId} IS NOT NULL`),
  index("chat_messages_visitor_hash_idx").on(table.visitorHash).where(sql`${table.visitorHash} IS NOT NULL`),
  check("chat_messages_single_owner_check", sql`${table.userId} IS NULL OR ${table.visitorHash} IS NULL`),
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
  summaryScore: doublePrecision(),
  rerankScore: doublePrecision(),
}, (table) => [primaryKey({ columns: [table.messageId, table.position] })]);
