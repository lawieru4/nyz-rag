import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, getTableColumns, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { ArticleDetail } from "./article/parse.js";
import { embeddingInput, summaryEmbeddingInput, type StructuredSection } from "./chunking.js";
import { ADMIN_PERMISSIONS, normalizeAdminPermissions } from "./admin-permissions.js";
import { contentFingerprint } from "./dedup.js";
import type { ModelProviderConfig, ModelSelection, ModelTarget } from "./provider.js";
import type { ChunkHit, SectionContext } from "./rag.js";
import { decryptSecret, encryptSecret, providerSecretContext, secretKeyConfigured } from "./secrets.js";
import { metadataScore, metadataSearchTerms, searchTerms, termCounts, type SearchableMetadata } from "./search-terms.js";
import type {
  AdminAccount, AdminAuditLogListResponse, AdminAuditLogRecord, AdminAuditResult, AdminPermission, AdminRole, AdminUserListResponse, AdminUserRecord, ArticleMetadata, ArticleSourceSyncState, ChatFeedbackRating, ChatLogListResponse, ChatLogRecord, ChatRetrievedChunk, ChatSessionListResponse, ChatSessionMessage,
  ChatSessionRecord, CrawlTaskRecord, CreateSourceRequest, DataSourceRecord, DocumentChunkRecord,
  DocumentDetail, DocumentEmbeddingRecord, DocumentReference, DocumentListResponse, DocumentProcessingStatus, DocumentRecord, DocumentStatus, DocumentSummary, KnowledgeBaseRecord,
  KnowledgeStats, ModelCapability, ModelProviderRecord, ModelSettingRecord, ModelSettingsResponse, RetrievalFilters, SaveKnowledgeBaseRequest, SaveModelProviderRequest, SaveModelSettingRequest,
  SaveAdminRoleRequest, SecretSettingStatus, UpdateAdminRoleRequest,
} from "@nyz-rag/types";
import { DocumentBusyError, getDb, lockDocumentWork, withTransaction, type Executor } from "./db.js";
import { activeOperation, insertOperation, sourceSyncRunning } from "./operations.js";
import { ACTIVE_TASK_INDEX, adminAccounts, adminAuditLogs, adminRoles, chatMessages, chatSessions, crawlTasks, dataSources, documentChunks, documents, documentSections, HNSW_DIMENSIONS, knowledgeBases, messageChunks, messageSources, modelProviders, modelSettings, secretSettings, users } from "./schema.js";

const iso = (value: Date | null | undefined) => value ? value.toISOString() : undefined;
// 可选字段在 JSON 中省略而不是返回 null，与原快照格式保持一致。
const compact = <T extends object>(value: { [K in keyof T]: T[K] | null }): T => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined)) as T;
const paging = (page: number, pageSize: number) => ({ limit: pageSize, offset: (page - 1) * pageSize });
const contains = (haystack: SQL, needle: string) => sql`strpos(lower(${haystack}), ${needle}) > 0`;
// 单表查询中 drizzle 渲染列名不带表名，相关子查询引用外层列时必须显式限定，否则会解析成子查询内的同名列。
const outer = (table: string, column: string) => sql.raw(`"${table}"."${column}"`);
// 逐个绑定参数的 text[]（drizzle 会把模板中的数组展开成参数列表）。
const textArray = (values: string[]) => sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
// 检索词项直接作为 tsvector 词位写入，不经过数据库分词器。
const searchVector = (text: string) => sql`array_to_tsvector(${textArray(searchTerms(text))})`;
const metadataSearchVector = (metadata: SearchableMetadata | null) => sql`array_to_tsvector(${textArray(metadataSearchTerms(metadata))})`;

// ---- 数据源与采集任务 ----

const sourceColumns = {
  ...getTableColumns(dataSources),
  documentCount: sql<number>`(SELECT count(*)::int FROM ${documents} WHERE ${documents.sourceId} = ${outer("data_sources", "id")} AND ${documents.status} = 'ready')`,
};

type SourceRow = typeof dataSources.$inferSelect & { documentCount: number };
const toSource = (row: SourceRow): DataSourceRecord => ({
  id: row.id, name: row.name, url: row.url, kind: row.kind, frequency: row.frequency, status: row.status,
  documentCount: row.documentCount, remoteTotal: row.syncState.remoteTotal ?? null, backfillDone: row.syncState.backfillDone === true,
  failedCount: row.syncState.retryKeys?.length ?? 0, updatedAt: iso(row.syncedAt) ?? null,
});

export async function listSources(db: Executor = getDb()): Promise<DataSourceRecord[]> {
  return (await db.select(sourceColumns).from(dataSources).orderBy(desc(dataSources.createdAt))).map(toSource);
}

export async function getSource(id: string, db: Executor = getDb()): Promise<DataSourceRecord | null> {
  const [row] = await db.select(sourceColumns).from(dataSources).where(eq(dataSources.id, id));
  return row ? toSource(row) : null;
}

export async function createSource(input: CreateSourceRequest, db: Executor = getDb()): Promise<DataSourceRecord> {
  const id = randomUUID();
  await db.insert(dataSources).values({ id, name: input.name, url: input.url, kind: input.kind, frequency: input.frequency ?? "", status: "已暂停" });
  return (await getSource(id, db))!;
}

export async function updateSourceStatus(id: string, status: DataSourceRecord["status"], db: Executor = getDb()): Promise<DataSourceRecord | null> {
  const updated = await db.update(dataSources).set({ status }).where(eq(dataSources.id, id)).returning({ id: dataSources.id });
  return updated.length ? getSource(id, db) : null;
}

export async function getSourceSyncState(id: string, db: Executor = getDb()): Promise<ArticleSourceSyncState> {
  const [row] = await db.select({ syncState: dataSources.syncState }).from(dataSources).where(eq(dataSources.id, id));
  return row?.syncState ?? {};
}

export async function saveSourceSyncState(id: string, state: ArticleSourceSyncState, db: Executor = getDb()): Promise<void> {
  await db.update(dataSources).set({ syncState: state }).where(eq(dataSources.id, id));
}

export async function markSourceSynced(id: string, db: Executor = getDb()): Promise<void> {
  await db.update(dataSources).set({ syncedAt: sql`now()` }).where(eq(dataSources.id, id));
}

const toTask = (row: typeof crawlTasks.$inferSelect): CrawlTaskRecord => compact<CrawlTaskRecord>({
  id: row.id, sourceId: row.sourceId, sourceName: row.sourceName, status: row.status, progress: row.progress,
  processedCount: row.processedCount, failedCount: row.failedCount, articleLimit: row.articleLimit, createdAt: iso(row.createdAt)!, error: row.error,
});

export async function listTasks(limit = 100, db: Executor = getDb()): Promise<CrawlTaskRecord[]> {
  return (await db.select().from(crawlTasks).orderBy(desc(crawlTasks.createdAt)).limit(limit)).map(toTask);
}

export async function getTask(id: string, db: Executor = getDb()): Promise<CrawlTaskRecord | null> {
  const [row] = await db.select().from(crawlTasks).where(eq(crawlTasks.id, id));
  return row ? toTask(row) : null;
}

/**
 * 创建同步任务及执行它的操作（同一事务，由 Worker 的投递器投递）。
 * 同一来源已有活动操作或等待中/运行中的任务时返回 null（两者都由部分唯一索引原子互斥）。
 * 自动调度在来源行锁内重新检查启停与到期时间；手动任务也会重置自动调度周期。
 */
export async function createTask(source: DataSourceRecord, options: { scheduled?: boolean } = {}): Promise<CrawlTaskRecord | null> {
  try {
    return await withTransaction(async (tx) => {
      const [current] = await tx.select().from(dataSources).where(eq(dataSources.id, source.id)).for("update");
      if (!current) return null;
      if (options.scheduled) {
        const [due] = await tx.select({ id: dataSources.id }).from(dataSources).where(and(eq(dataSources.id, source.id), sourceDue));
        if (!due) return null;
      }
      // 不等待活动操作的唯一索引：完成事务按 operation → source 更新，避免与本行锁形成反向等待。
      if (await activeOperation("source", source.id, tx)) return null;
      const operation = await insertOperation(tx, "sync-source", source.id);
      if (!operation) return null;
      const [row] = await tx.insert(crawlTasks)
        .values({ id: randomUUID(), sourceId: source.id, sourceName: current.name, status: "等待中", operationId: operation.id })
        .returning();
      return toTask(row);
    });
  } catch (error) {
    if (pgErrorCode(error) === "23505" && pgConstraint(error) === ACTIVE_TASK_INDEX) return null;
    throw error;
  }
}

// 只识别管理端提供的频率；空值、手动和未知频率均不自动执行。
// 任务创建时间包含失败尝试，不以最近成功时间单独计时，避免凭据失效时每轮都创建失败任务。
const sourceDue = sql`${dataSources.status} = '运行中' AND now() >=
  coalesce(greatest(${dataSources.syncedAt}, (SELECT max(created_at) FROM ${crawlTasks}
    WHERE source_id = ${outer("data_sources", "id")})), '-infinity'::timestamptz) +
  CASE ${dataSources.frequency}
    WHEN '每小时' THEN interval '1 hour'
    WHEN '每 6 小时' THEN interval '6 hours'
    WHEN '每天' THEN interval '1 day'
    ELSE NULL END`;

/** 每个 Worker 均可调用；到期判断和任务/outbox 写入在 createTask 内原子完成，重启不丢周期。 */
export async function scheduleDueSources(limit = 100): Promise<number> {
  const sources = await getDb().select(sourceColumns).from(dataSources).where(and(sourceDue,
    sql`NOT EXISTS (SELECT 1 FROM ${crawlTasks} WHERE source_id = ${outer("data_sources", "id")} AND status IN ('等待中', '运行中'))`,
    sql`NOT EXISTS (SELECT 1 FROM operations WHERE target_type = 'source' AND target_id = ${outer("data_sources", "id")} AND status IN ('pending', 'dispatched', 'running'))`,
  )).orderBy(asc(dataSources.id)).limit(limit);
  let created = 0;
  for (const source of sources) if (await createTask(toSource(source), { scheduled: true })) created += 1;
  return created;
}

/** 同步操作对应的任务。 */
export async function getTaskByOperation(operationId: string, db: Executor = getDb()): Promise<CrawlTaskRecord | null> {
  const [row] = await db.select().from(crawlTasks).where(eq(crawlTasks.operationId, operationId));
  return row ? toTask(row) : null;
}

const activeTask = inArray(crawlTasks.status, ["等待中", "运行中"]);

/** Worker 开始执行同步：任务已不是等待中或运行中（例如被对账标为失败）时返回 false，不再执行。 */
export async function startTask(id: string, articleLimit: number, db: Executor = getDb()): Promise<boolean> {
  const rows = await db.update(crawlTasks)
    .set({ status: "运行中", progress: 0, processedCount: 0, failedCount: 0, articleLimit, error: null })
    .where(and(eq(crawlTasks.id, id), activeTask)).returning({ id: crawlTasks.id });
  return rows.length > 0;
}

/** 未传入的字段保持不变；`error: null` 清除错误。 */
export async function updateTask(id: string, patch: Partial<Pick<CrawlTaskRecord, "status" | "progress" | "processedCount" | "failedCount" | "articleLimit">> & { error?: string | null }, db: Executor = getDb()): Promise<void> {
  await db.update(crawlTasks).set(patch).where(eq(crawlTasks.id, id));
}

export async function getStats(db: Executor = getDb()): Promise<KnowledgeStats> {
  const [[documentStats], [sourceStats], [taskStats]] = await Promise.all([
    // 重复文档不参与检索，不计入知识库文档数。
    db.select({ ready: count(sql`CASE WHEN ${documents.status} = 'ready' AND ${documents.duplicateOf} IS NULL THEN 1 END`), lastUpdated: sql<string | null>`max(${documents.updatedAt})` }).from(documents),
    db.select({ total: count() }).from(dataSources),
    db.select({ active: count() }).from(crawlTasks).where(or(eq(crawlTasks.status, "等待中"), eq(crawlTasks.status, "运行中"))),
  ]);
  // 原始 SQL 聚合不经过列映射，max() 返回数据库时间字符串。
  const lastUpdated = documentStats.lastUpdated ? new Date(documentStats.lastUpdated).toISOString() : null;
  return { documents: documentStats.ready, sources: sourceStats.total, processingTasks: taskStats.active, lastUpdated };
}

// ---- 文档与切片 ----

// 列表不读取正文、原始内容与解析结果等大字段。
const { content: _content, rawJson: _rawJson, markdown: _markdown, metadata: _metadata, ...documentColumns } = getTableColumns(documents);
const summaryColumns = {
  ...documentColumns,
  chunkCount: sql<number>`(SELECT count(*)::int FROM ${documentChunks} WHERE ${documentChunks.documentId} = ${outer("documents", "id")})`,
};

type SummaryRow = Omit<typeof documents.$inferSelect, "content" | "rawJson" | "markdown" | "metadata"> & { chunkCount: number };
const toSummary = (row: SummaryRow): DocumentSummary => compact<DocumentSummary>({
  id: row.id, sourceId: row.sourceId, title: row.title, url: row.url, canonicalUrl: row.canonicalUrl, externalId: row.externalId, author: row.author, category: row.category,
  tags: row.tags, publishedAt: iso(row.publishedAt) ?? null, parserVersion: row.parserVersion, status: row.status,
  processingStatus: row.processingStatus, processingError: row.processingError, duplicateOf: row.duplicateOf,
  embedding: compact<DocumentEmbeddingRecord>({
    status: row.embeddingStatus, providerId: row.embeddingProviderId ?? undefined, model: row.embeddingModel ?? undefined, dimensions: row.embeddingDimensions ?? undefined,
    chunkCount: row.embeddingChunkCount, updatedAt: iso(row.embeddingUpdatedAt), error: row.embeddingError ?? undefined,
  }),
  chunkCount: row.chunkCount, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
});

export async function listDocuments(filter: { query?: string; sourceId?: string; status?: string; page: number; pageSize: number }, db: Executor = getDb()): Promise<DocumentListResponse> {
  const query = filter.query?.trim().toLocaleLowerCase();
  const where = and(
    filter.sourceId ? eq(documents.sourceId, filter.sourceId) : undefined,
    filter.status ? eq(documents.status, filter.status as DocumentStatus) : undefined,
    query ? contains(sql`${documents.title} || ' ' || ${documents.url} || ' ' || ${documents.content}`, query) : undefined,
  );
  const { limit, offset } = paging(filter.page, filter.pageSize);
  const [rows, [{ total }]] = await Promise.all([
    db.select(summaryColumns).from(documents).where(where).orderBy(desc(documents.updatedAt), asc(documents.id)).limit(limit).offset(offset),
    db.select({ total: count() }).from(documents).where(where),
  ]);
  return { documents: rows.map(toSummary), total };
}

export async function listDocumentChunks(documentId: string, db: Executor = getDb()): Promise<DocumentChunkRecord[]> {
  const rows = await db.select({
    id: documentChunks.id, index: documentChunks.chunkIndex, content: documentChunks.content, tokenEstimate: documentChunks.tokenEstimate,
    context: documentChunks.context, sectionPath: documentChunks.sectionPath, contentType: documentChunks.contentType,
  }).from(documentChunks).where(eq(documentChunks.documentId, documentId)).orderBy(asc(documentChunks.chunkIndex));
  return rows;
}

export async function getDocumentSummary(id: string, db: Executor = getDb()): Promise<DocumentSummary | null> {
  const [row] = await db.select(summaryColumns).from(documents).where(eq(documents.id, id));
  return row ? toSummary(row) : null;
}

const referenceColumns = { id: documents.id, sourceId: documents.sourceId, title: documents.title, url: documents.url };

export async function getDocument(id: string, db: Executor = getDb()): Promise<DocumentRecord | null> {
  const [row] = await db.select({ ...summaryColumns, content: documents.content, markdown: documents.markdown, metadata: documents.metadata })
    .from(documents).where(eq(documents.id, id));
  if (!row) return null;
  const [chunks, [primary], duplicates] = await Promise.all([
    listDocumentChunks(id, db),
    row.duplicateOf ? db.select(referenceColumns).from(documents).where(eq(documents.id, row.duplicateOf)) : Promise.resolve([] as DocumentReference[]),
    db.select(referenceColumns).from(documents).where(eq(documents.duplicateOf, id)).orderBy(asc(documents.createdAt), asc(documents.id)),
  ]);
  return compact<DocumentRecord>({
    ...toSummary(row), content: row.content, markdown: row.markdown, metadata: row.metadata, chunks, primary: primary ?? null, duplicates,
  });
}

export async function getDocumentDetail(id: string, db: Executor = getDb()): Promise<DocumentDetail | null> {
  const [row] = await db.select({
    id: documents.id, title: documents.title, url: documents.url, content: documents.content, markdown: documents.markdown,
    author: documents.author, category: documents.category, tags: documents.tags, publishedAt: documents.publishedAt,
    updatedAt: documents.updatedAt, summary: sql<string | null>`${documents.metadata}->>'summary'`,
    repostSource: sql<string | null>`${documents.metadata}->'sourceMeta'->>'repostSource'`,
    keywords: sql<string[] | null>`${documents.metadata}->'sourceMeta'->'keywords'`,
    scenarios: sql<string[] | null>`${documents.metadata}->'sourceMeta'->'scenarios'`,
  }).from(documents).where(and(eq(documents.id, id), eq(documents.status, "ready")));
  return row ? compact<DocumentDetail>({ ...row, publishedAt: iso(row.publishedAt), updatedAt: iso(row.updatedAt)!, keywords: row.keywords ?? [], scenarios: row.scenarios ?? [] }) : null;
}

/** 在事务内锁定文档行，用于切片和向量化回写前的一致性校验。 */
export async function lockDocument(tx: Executor, id: string) {
  await lockDocumentWork(tx, id);
  const [row] = await tx.select({
    id: documents.id, content: documents.content, contentHash: documents.contentHash, processingStatus: documents.processingStatus, processingVersion: documents.processingVersion,
  })
    .from(documents).where(eq(documents.id, id)).for("update");
  return row ?? null;
}

/** 读取重新清洗切片所需的原始内容；调用前应先用 lockDocument 锁定。 */
export async function getProcessingInput(tx: Executor, id: string) {
  const [row] = await tx.select({ rawJson: documents.rawJson }).from(documents).where(eq(documents.id, id));
  return row ? { rawJson: row.rawJson as ArticleDetail } : null;
}

/** 文章级向量化输入（标题 + 摘要）；没有摘要的文档返回 null。 */
export async function getSummaryInput(id: string, db: Executor = getDb()): Promise<string | null> {
  const [row] = await db.select({ title: documents.title, summary: sql<string | null>`${documents.metadata}->>'summary'` }).from(documents).where(eq(documents.id, id));
  return row ? summaryEmbeddingInput(row.title, row.summary) : null;
}

/** 来源已入库的文章：articleKey → 来源 updateTime（毫秒），用于增量同步。 */
export async function listArticleVersions(sourceId: string, db: Executor = getDb()): Promise<Map<string, number | null>> {
  const rows = await db.select({ externalId: documents.externalId, sourceUpdatedAt: documents.sourceUpdatedAt })
    .from(documents).where(eq(documents.sourceId, sourceId));
  return new Map(rows.map((row) => [row.externalId, row.sourceUpdatedAt?.getTime() ?? null]));
}

export interface UpsertDocumentInput {
  sourceId: string;
  /** 来源标识（articleKey），同一来源内按它识别同一篇文章。 */
  externalId: string;
  url: string;
  title: string;
  content: string;
  rawJson: ArticleDetail;
  sourceUpdatedAt?: Date | null;
  status: DocumentStatus;
}

/** 按来源标识更新，地址随之更新。并发写入同一篇时由唯一约束串行化。 */
export async function upsertDocument(tx: Executor, input: UpsertDocumentInput): Promise<string> {
  const values = {
    url: input.url, canonicalUrl: input.url, title: input.title, content: input.content,
    externalId: input.externalId, rawJson: input.rawJson, sourceUpdatedAt: input.sourceUpdatedAt ?? null, status: input.status,
  };
  const [row] = await tx.insert(documents)
    .values({ id: randomUUID(), sourceId: input.sourceId, ...values })
    .onConflictDoUpdate({ target: [documents.sourceId, documents.externalId], set: { ...values, updatedAt: sql`now()` } })
    .returning({ id: documents.id });
  // Roll back the upsert if an embedding owner holds the document across transactions.
  await lockDocumentWork(tx, row.id);
  return row.id;
}

// 文章级向量的模型与维度沿用文档的向量信息，因此随之清除；切片向量自带模型与维度，向量化失败时保留。
const resetEmbedding = { embeddingProviderId: null, embeddingModel: null, embeddingDimensions: null, embeddingChunkCount: 0, summaryEmbedding: null };

/** 清洗结果：正文必填，其余为解析出的字段。 */
export interface DocumentContentUpdate {
  content: string;
  title?: string;
  markdown?: string | null;
  author?: string | null;
  category?: string | null;
  tags?: string[];
  publishedAt?: Date | null;
  contentHash?: string | null;
  parserVersion?: number | null;
  chunkerVersion?: number | null;
  metadata?: ArticleMetadata | null;
}

// 写入清洗结果并删除旧切片与父块（向量随之删除），切片版本加一，向量状态重置为待向量化。
async function writeDocumentContent(tx: Executor, documentId: string, update: DocumentContentUpdate, state: { processingStatus: "chunked" | "duplicate"; duplicateOf: string | null }) {
  await tx.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  await tx.delete(documentSections).where(eq(documentSections.documentId, documentId));
  await tx.update(documents).set({
    ...update, ...(update.metadata !== undefined ? { metadataSearchVector: metadataSearchVector(update.metadata) } : {}), ...state, processingError: null, processingVersion: sql`${documents.processingVersion} + 1`,
    embeddingStatus: "pending", ...resetEmbedding, embeddingError: null, embeddingUpdatedAt: null, updatedAt: sql`now()`,
  }).where(eq(documents.id, documentId));
}

/** 替换正文、全部切片与父块（切片规则 2）；旧切片的向量随之删除，向量状态重置为待向量化。文档不再是重复文档。 */
export async function replaceDocumentChunks(
  tx: Executor, documentId: string, update: DocumentContentUpdate, chunks: Array<DocumentChunkRecord & { sectionId?: string | null }>, sections: StructuredSection[] = [],
): Promise<void> {
  await writeDocumentContent(tx, documentId, update, { processingStatus: "chunked", duplicateOf: null });
  if (sections.length) {
    await tx.insert(documentSections).values(sections.map((section) => ({
      id: section.id, documentId, sectionIndex: section.index, sectionPath: section.sectionPath, part: section.part, content: section.content, tokenEstimate: section.tokenEstimate,
    })));
  }
  if (!chunks.length) return;
  await tx.insert(documentChunks).values(chunks.map((chunk) => ({
    id: chunk.id, documentId, sectionId: chunk.sectionId ?? null, chunkIndex: chunk.index, content: chunk.content, tokenEstimate: chunk.tokenEstimate,
    context: chunk.context ?? "", sectionPath: chunk.sectionPath ?? [], contentType: chunk.contentType ?? "text", searchVector: searchVector(embeddingInput(chunk)),
  })));
}

// ---- 重复文档 ----

/**
 * 在事务内按正文指纹加咨询锁（按值排序，避免死锁）。凡是改变重复关系的操作（切片、删除）都先锁住涉及的新旧指纹，
 * 使「查找主文档 → 标记重复」与主文档的内容变化、删除互斥。
 */
export async function lockContentHashes(tx: Executor, hashes: Array<string | null | undefined>): Promise<void> {
  for (const hash of [...new Set(hashes.filter((value): value is string => Boolean(value)))].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`nyz-rag:content-hash:${hash}`}, 0))`);
  }
}

/** 同一正文指纹的主文档（最早入库的非重复文档），不含 excludeId 本身。调用前应先 lockContentHashes。 */
export async function findPrimaryDocument(tx: Executor, contentHash: string, excludeId: string): Promise<string | null> {
  const [row] = await tx.select({ id: documents.id }).from(documents)
    .where(and(eq(documents.contentHash, contentHash), isNull(documents.duplicateOf), ne(documents.processingStatus, "duplicate"), ne(documents.id, excludeId)))
    .orderBy(asc(documents.createdAt), asc(documents.id)).limit(1);
  return row?.id ?? null;
}

/** 写入清洗结果并标记为 primaryId 的重复文档：删除切片与向量，不再参与检索与向量化。 */
export async function markDocumentDuplicate(tx: Executor, documentId: string, primaryId: string, update: DocumentContentUpdate): Promise<void> {
  await writeDocumentContent(tx, documentId, update, { processingStatus: "duplicate", duplicateOf: primaryId });
}

/** 以 primaryId 为主文档的重复文档（按入库先后），并锁定这些行。 */
export async function listDuplicateDocuments(tx: Executor, primaryId: string) {
  const rows = await tx.select({ id: documents.id, contentHash: documents.contentHash }).from(documents)
    .where(eq(documents.duplicateOf, primaryId)).orderBy(asc(documents.createdAt), asc(documents.id));
  // Try advisory locks before waiting for rows: a dependent may already be waiting for our content hash.
  for (const row of rows) await lockDocument(tx, row.id);
  return rows;
}

/** 改变重复文档的主文档；primaryId 为 null 时解除重复关系（状态仍为 duplicate，需重新处理）。 */
export async function setDuplicateOf(tx: Executor, ids: string[], primaryId: string | null): Promise<void> {
  if (ids.length) await tx.update(documents).set({ duplicateOf: primaryId }).where(inArray(documents.id, ids));
}

/**
 * 升级前的文档没有正文指纹，按当前规则补齐一批（不改变重复关系），返回最后处理的文档 ID；没有更多时返回 null。
 * 只处理已切片或已判定重复的文档，切片版本变化时跳过。
 */
export async function backfillContentHashes(afterId: string, batchSize: number, db: Executor = getDb()): Promise<string | null> {
  const rows = await db.select({ id: documents.id, content: documents.content, version: documents.processingVersion }).from(documents)
    .where(and(sql`${documents.id} > ${afterId}`, isNull(documents.contentHash), inArray(documents.processingStatus, ["chunked", "duplicate"])))
    .orderBy(asc(documents.id)).limit(batchSize);
  for (const row of rows) {
    await db.update(documents).set({ contentHash: contentFingerprint(row.content) })
      .where(and(eq(documents.id, row.id), eq(documents.processingVersion, row.version), isNull(documents.contentHash)));
  }
  return rows.at(-1)?.id ?? null;
}

/**
 * 按当前规则重新生成一批切片的检索词项（不影响向量），返回最后处理的切片 ID；没有更多切片时返回 null。
 * onlyMissing 只处理词项为空的切片（升级前已切片的数据）。
 */
export async function reindexChunkSearchTerms(afterId: string, batchSize: number, options: { onlyMissing?: boolean } = {}, db: Executor = getDb()): Promise<string | null> {
  const rows = await db.select({ id: documentChunks.id, content: documentChunks.content, context: documentChunks.context })
    .from(documentChunks).where(and(sql`${documentChunks.id} > ${afterId}`, options.onlyMissing ? sql`${documentChunks.searchVector} = ''::tsvector` : undefined))
    .orderBy(asc(documentChunks.id)).limit(batchSize);
  for (const row of rows) {
    await db.update(documentChunks).set({ searchVector: searchVector(embeddingInput({ ...row, index: 0, tokenEstimate: 0 })) })
      // 切片 ID 在重新切片后会复用，只在内容未变时写入，避免与并发的重新处理互相覆盖。
      .where(and(eq(documentChunks.id, row.id), eq(documentChunks.content, row.content), eq(documentChunks.context, row.context)));
  }
  return rows.at(-1)?.id ?? null;
}

/** 按当前规则重新生成一批文档的元数据检索词项，用法同 reindexChunkSearchTerms；尚未处理（没有元数据）的文档跳过。 */
export async function reindexDocumentMetadataTerms(afterId: string, batchSize: number, options: { onlyMissing?: boolean } = {}, db: Executor = getDb()): Promise<string | null> {
  const rows = await db.select({ id: documents.id, metadata: documents.metadata }).from(documents)
    .where(and(sql`${documents.id} > ${afterId}`, isNotNull(documents.metadata), options.onlyMissing ? sql`${documents.metadataSearchVector} = ''::tsvector` : undefined))
    .orderBy(asc(documents.id)).limit(batchSize);
  for (const row of rows) {
    await db.update(documents).set({ metadataSearchVector: metadataSearchVector(row.metadata) })
      // 只在元数据未变时写入，避免覆盖并发重新处理写入的词项。
      .where(and(eq(documents.id, row.id), sql`${documents.metadata} = ${JSON.stringify(row.metadata)}::jsonb`));
  }
  return rows.at(-1)?.id ?? null;
}

export async function setProcessingState(id: string, status: DocumentProcessingStatus, error: string | null = null, db: Executor = getDb()): Promise<void> {
  await db.update(documents).set({ processingStatus: status, processingError: error }).where(eq(documents.id, id));
}

/** 设置排队/处理中/失败状态；与原快照一致，非 ready 状态不保留模型信息。 */
export async function setEmbeddingState(id: string, status: Exclude<DocumentEmbeddingRecord["status"], "ready">, error: string | null = null, db: Executor = getDb()): Promise<void> {
  await db.update(documents).set({ embeddingStatus: status, embeddingError: error, ...resetEmbedding, embeddingUpdatedAt: sql`now()` }).where(eq(documents.id, id));
}

/**
 * 管理端请求重新处理或向量化：在同一事务内写入文档状态与操作。文档已有活动操作或所属来源正在同步时返回 busy。
 * 文档行加锁，与删除文档互斥。
 */
export async function requestDocumentOperation(id: string, kind: "reprocess-document" | "embed-document"): Promise<"created" | "busy" | "not-found"> {
  return withTransaction(async (tx) => {
    const [document] = await tx.select({ sourceId: documents.sourceId }).from(documents).where(eq(documents.id, id)).for("update");
    if (!document) return "not-found";
    if (await sourceSyncRunning(document.sourceId, tx) || !await insertOperation(tx, kind, id)) return "busy";
    if (kind === "reprocess-document") await setProcessingState(id, "pending", null, tx);
    else await setEmbeddingState(id, "queued", null, tx);
    return "created";
  });
}

/** 文档的切片与向量状态（行锁），供向量化操作结束时判断执行期间是否被重新切片。 */
export async function lockEmbeddingTarget(tx: Executor, id: string) {
  const [row] = await tx.select({ processingStatus: documents.processingStatus, processingVersion: documents.processingVersion, embeddingStatus: documents.embeddingStatus })
    .from(documents).where(eq(documents.id, id)).for("update");
  return row ?? null;
}

/**
 * 在调用方事务内为切片后的文档安排向量化操作（同步、重新处理时自动向量化）。已有活动操作的文档由那个操作处理：
 * 它尚未开始，或在执行时发现内容已重新切片（见 Worker 的 embed-document），会按最新切片向量化。
 */
export async function scheduleEmbeddings(tx: Executor, documentIds: string[]): Promise<void> {
  for (const id of documentIds) {
    if (await insertOperation(tx, "embed-document", id)) await setEmbeddingState(id, "queued", null, tx);
  }
}

function validateVectors(vectors: number[][], { provider, model }: ModelTarget): void {
  if (!provider.id.trim() || !model.trim()) throw new Error("Vector provider ID and embedding model are required.");
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => Number.isFinite(value))) throw new Error("Vectors must contain finite numeric values.");
    if (!vector.some((value) => value !== 0)) throw new Error("Vectors must not be zero vectors.");
    if (vector.length !== vectors[0].length) throw new Error("All vectors for one document must have the same dimensions.");
  }
}

/** 在调用方事务内写入整篇文档的切片向量与文章级向量（没有摘要时为 null），并把文档向量状态置为 ready。 */
export async function saveDocumentEmbeddings(
  tx: Executor, documentId: string, chunks: DocumentChunkRecord[], vectors: number[][], embedding: ModelTarget, summaryVector: number[] | null = null,
): Promise<void> {
  if (chunks.length !== vectors.length) throw new Error("The number of chunks and vectors must match.");
  // 文章级向量与切片向量必须同维度（共用文档的模型与维度信息）。
  validateVectors(summaryVector ? [...vectors, summaryVector] : vectors, embedding);
  if (!chunks.length) throw new Error("Document must have chunks before embedding");
  const { provider } = embedding;
  const model = embedding.model.trim();
  const dimensions = vectors[0].length;
  for (const [index, chunk] of chunks.entries()) {
    const updated = await tx.update(documentChunks)
      .set({ embedding: vectors[index], providerId: provider.id, model, dimensions, embeddedAt: sql`now()` })
      .where(and(eq(documentChunks.documentId, documentId), eq(documentChunks.id, chunk.id)))
      .returning({ id: documentChunks.id });
    if (!updated.length) throw new Error("Document chunks changed during embedding");
  }
  await tx.update(documents).set({
    embeddingStatus: "ready", embeddingProviderId: provider.id, embeddingModel: model, embeddingDimensions: dimensions,
    embeddingChunkCount: chunks.length, summaryEmbedding: summaryVector, embeddingError: null, embeddingUpdatedAt: sql`now()`,
  }).where(eq(documents.id, documentId));
}

/**
 * 向量空间：供应商 ID + 模型名（再加上向量维度）。不同供应商的同名模型可能不是同一个模型，
 * 向量不可比较，所以检索与回填都只匹配同一供应商、同一模型写入的向量；更换 Embedding 供应商后需重新向量化。
 */
export interface VectorSpace {
  providerId: string;
  model: string;
}

// 写入时模型名已去掉首尾空白（saveDocumentEmbeddings），比较时同样处理。
const documentSpace = (space: VectorSpace) => [eq(documents.embeddingProviderId, space.providerId), eq(documents.embeddingModel, space.model.trim())];
const chunkSpace = (space: VectorSpace) => [eq(documentChunks.providerId, space.providerId), eq(documentChunks.model, space.model.trim())];

/**
 * 升级前已向量化、缺少文章级向量的文档，按 ID 分批返回（只含当前向量空间的 ready 文档且有摘要），
 * 供 Worker 回填；没有更多文档时 cursor 为 null。
 */
export async function listMissingSummaryEmbeddings(afterId: string, batchSize: number, space: VectorSpace, db: Executor = getDb()) {
  const rows = await db.select({ id: documents.id, version: documents.processingVersion, title: documents.title, summary: sql<string | null>`${documents.metadata}->>'summary'` })
    .from(documents)
    .where(and(sql`${documents.id} > ${afterId}`, eq(documents.embeddingStatus, "ready"), ...documentSpace(space), isNull(documents.summaryEmbedding),
      sql`btrim(coalesce(${documents.metadata}->>'summary', '')) <> ''`))
    .orderBy(asc(documents.id)).limit(batchSize);
  return {
    items: rows.map((row) => ({ id: row.id, version: row.version, input: summaryEmbeddingInput(row.title, row.summary)! })),
    cursor: rows.at(-1)?.id ?? null,
  };
}

/** 回填文章级向量：只在文档仍为同一切片版本、同一向量空间与维度的 ready 状态时写入，避免覆盖并发的重新处理或向量化。 */
export async function saveSummaryEmbedding(id: string, version: number, vector: number[], space: VectorSpace, db: Executor = getDb()): Promise<boolean> {
  if (!vector.length || !vector.every((value) => Number.isFinite(value)) || !vector.some((value) => value !== 0)) throw new Error("Invalid summary vector");
  const updated = await db.update(documents).set({ summaryEmbedding: vector })
    .where(and(eq(documents.id, id), eq(documents.processingVersion, version), eq(documents.embeddingStatus, "ready"), ...documentSpace(space),
      eq(documents.embeddingDimensions, vector.length), isNull(documents.summaryEmbedding)))
    .returning({ id: documents.id });
  return updated.length > 0;
}

/**
 * 删除文档。被删除的是主文档时，最早入库的重复文档接替为主文档（状态置为待处理，同一事务内建立重新处理操作），
 * 其余重复文档改为指向它。返回 null 表示文档不存在；文档有活动操作或所属来源正在同步时抛出 DocumentBusyError。
 */
export async function deleteDocument(id: string): Promise<{ promotedId: string | null } | null> {
  return withTransaction(async (tx) => {
    const target = await lockDocument(tx, id);
    if (!target) return null;
    const [{ sourceId }] = await tx.select({ sourceId: documents.sourceId }).from(documents).where(eq(documents.id, id));
    if (await activeOperation("document", id, tx) || await sourceSyncRunning(sourceId, tx)) throw new DocumentBusyError();
    await lockContentHashes(tx, [target.contentHash]);
    const [promoted, ...rest] = await listDuplicateDocuments(tx, id);
    if (promoted) {
      await tx.update(documents).set({ duplicateOf: null, processingStatus: "pending", processingError: null }).where(eq(documents.id, promoted.id));
      await setDuplicateOf(tx, rest.map((row) => row.id), promoted.id);
      // 接替的文档已有活动操作（例如等待中的重新处理）时由它处理。
      await insertOperation(tx, "reprocess-document", promoted.id);
    }
    await tx.delete(documents).where(eq(documents.id, id));
    return { promotedId: promoted?.id ?? null };
  });
}

// ---- 检索 ----

const chunkHitColumns = {
  chunkId: documentChunks.id, documentId: documentChunks.documentId, sectionId: documentChunks.sectionId, title: documents.title, url: documents.url,
  repostSource: sql<string | null>`${documents.metadata}->'sourceMeta'->>'repostSource'`,
  content: documentChunks.content, context: documentChunks.context, sectionPath: documentChunks.sectionPath, contentType: documentChunks.contentType,
};

const toChunkHit = ({ repostSource, sectionId, score, ...row }: Omit<ChunkHit, "repostSource" | "sectionId" | "score"> & { repostSource: string | null; sectionId: string | null; score: number | string }): ChunkHit =>
  ({ ...row, score: Number(score), ...(sectionId ? { sectionId } : {}), ...(repostSource ? { repostSource } : {}) });

// 候选只由最少见的若干词项筛选（出现在超过 10% 切片中的词项只参与打分），
// 避免「如何」「电池」等常见二元组使候选覆盖大部分切片。
const COMMON_TERM_RATIO = 0.1;
const MAX_FILTER_TERMS = 8;
// SQL 按命中词项的 IDF 之和预选候选，再在应用层按 BM25（词频 + 切片长度归一化）重排。
const KEYWORD_CANDIDATES = 200;
// 只有元数据命中查询词项的文档另行召回，每篇取正文得分最高的一个切片，不占用正文候选名额。
const METADATA_CANDIDATES = 20;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
// 词项只含中文、小写字母、数字和小数点，可直接作为带引号的 tsquery 词位。
const tsqueryOf = (terms: string[]) => terms.map((term) => `'${term}'`).join(" | ");

function documentFilter(filters: RetrievalFilters): SQL | undefined {
  return and(
    eq(documents.status, "ready"),
    // 重复文档没有切片；排除后也不占用元数据召回名额和词项文档频率。
    isNull(documents.duplicateOf),
    filters.sourceId ? eq(documents.sourceId, filters.sourceId) : undefined,
    filters.publishedFrom ? sql`${documents.publishedAt} >= ${`${filters.publishedFrom}T00:00:00Z`}::timestamptz` : undefined,
    filters.publishedTo ? sql`${documents.publishedAt} < (${`${filters.publishedTo}T00:00:00Z`}::timestamptz + interval '24 hours')` : undefined,
    filters.categories?.length ? sql`${documents.category} = ANY(${textArray(filters.categories)})` : undefined,
    filters.tags?.length ? sql`${documents.tags} && ${textArray(filters.tags)}` : undefined,
    filters.scenarios?.length ? sql`(${documents.metadata}->'sourceMeta'->'scenarios') ?| ${textArray(filters.scenarios)}` : undefined,
  );
}

/**
 * 关键词召回：候选为包含任一较少见词项的切片，按 BM25 打分，只检索 ready 文档。
 * 元数据（关键词、项目名称、负责人、承担单位）命中查询词项时按 IDF × 字段权重加分；
 * 每篇文档只给得分最高的切片加一次，常见词项不参与加分，避免同一文档或泛化词挤掉正文相关的结果。
 */
export async function keywordSearchChunks(terms: string[], limit: number, db: Executor = getDb(), filters: RetrievalFilters = {}): Promise<ChunkHit[]> {
  if (!terms.length) return [];
  const eligible = documentFilter(filters);
  const [{ total }] = await db.select({ total: count() }).from(documentChunks).innerJoin(documents, eq(documents.id, documentChunks.documentId)).where(eligible);
  if (!total) return [];
  // Term selection must use the filtered corpus too: globally rare terms may be absent
  // from the requested category while its eligible documents match another query term.
  const { rows } = await db.execute<{ term: string; df: number; metadataDf: number }>(sql`SELECT term, (SELECT count(*)::int FROM ${documentChunks}
    INNER JOIN ${documents} ON ${documents.id} = ${documentChunks.documentId}
    WHERE ${eligible} AND ${documentChunks.searchVector} @@ quote_literal(term)::tsquery) AS df,
    (SELECT count(*)::int FROM ${documents} WHERE ${eligible} AND ${documents.metadataSearchVector} @@ quote_literal(term)::tsquery) AS "metadataDf"
    FROM unnest(${textArray(terms)}) AS term`);
  const idf = (df: number) => Math.log(1 + Math.max(0, total - df + 0.5) / (df + 0.5));
  const commonLimit = Math.max(total * COMMON_TERM_RATIO, 50);
  const weighted = rows.filter((row) => row.df > 0).map((row) => ({ term: row.term, df: row.df, idf: idf(row.df) })).sort((a, b) => a.df - b.df);
  // 元数据词项的文档频率取切片与元数据文档数中的较大者：只出现在元数据中的词项（如负责人姓名）也有合理的 IDF。
  const metadataTerms = rows.filter((row) => row.metadataDf > 0).map((row) => ({ term: row.term, df: Math.max(row.df, row.metadataDf) }))
    .filter((row) => row.df <= commonLimit).map((row) => ({ term: row.term, idf: idf(row.df) }));
  if (!weighted.length && !metadataTerms.length) return [];

  const searchMetadata = sql<SearchableMetadata | null>`jsonb_build_object('sourceMeta', jsonb_build_object('keywords', ${documents.metadata}->'sourceMeta'->'keywords'), 'projectMeta', ${documents.metadata}->'projectMeta', 'titleMeta', ${documents.metadata}->'titleMeta')`;
  const weights = sql.join(weighted.map((row) => sql.raw(row.idf.toFixed(6))), sql`, `);
  const prescore = sql<number>`(SELECT coalesce(sum(q.weight), 0) FROM unnest(${textArray(weighted.map((row) => row.term))}, ARRAY[${weights}]::float8[]) AS q(term, weight) WHERE ${documentChunks.searchVector} @@ quote_literal(q.term)::tsquery)`;
  const candidates: (ChunkHit & { searchMetadata: SearchableMetadata | null })[] = [];
  if (weighted.length) {
    const rare = weighted.filter((row) => row.df <= commonLimit);
    const filterTerms = (rare.length ? rare : weighted).slice(0, rare.length ? MAX_FILTER_TERMS : 3).map((row) => row.term);
    const rows = await db.select({ ...chunkHitColumns, searchMetadata, score: prescore }).from(documentChunks).innerJoin(documents, eq(documents.id, documentChunks.documentId))
      .where(and(eligible, sql`${documentChunks.searchVector} @@ ${tsqueryOf(filterTerms)}::tsquery`))
      .orderBy(desc(prescore), asc(documentChunks.documentId), asc(documentChunks.chunkIndex)).limit(KEYWORD_CANDIDATES);
    candidates.push(...rows.map(({ searchMetadata, ...row }) => ({ ...toChunkHit(row), searchMetadata })));
  }
  const bodyCandidates = candidates.length;
  if (metadataTerms.length) {
    const metadataWeights = sql.join(metadataTerms.map((row) => sql.raw(row.idf.toFixed(6))), sql`, `);
    const metadataPrescore = sql`(SELECT coalesce(sum(q.weight), 0) FROM unnest(${textArray(metadataTerms.map((row) => row.term))}, ARRAY[${metadataWeights}]::float8[]) AS q(term, weight) WHERE ${documents.metadataSearchVector} @@ quote_literal(q.term)::tsquery)`;
    const matched = db.select({ id: documents.id }).from(documents)
      .where(and(eligible, sql`${documents.metadataSearchVector} @@ ${tsqueryOf(metadataTerms.map((row) => row.term))}::tsquery`))
      .orderBy(desc(metadataPrescore), asc(documents.id)).limit(METADATA_CANDIDATES);
    const rows = await db.selectDistinctOn([documentChunks.documentId], { ...chunkHitColumns, searchMetadata, score: prescore })
      .from(documentChunks).innerJoin(documents, eq(documents.id, documentChunks.documentId))
      .where(inArray(documentChunks.documentId, matched))
      .orderBy(documentChunks.documentId, desc(prescore), asc(documentChunks.chunkIndex));
    const seen = new Set(candidates.map((hit) => hit.chunkId));
    for (const { searchMetadata, ...row } of rows) if (!seen.has(row.chunkId)) candidates.push({ ...toChunkHit(row), searchMetadata });
  }
  if (!candidates.length) return [];

  const counted = candidates.map(({ searchMetadata, ...hit }) => {
    const counts = termCounts(embeddingInput({ ...hit, id: hit.chunkId, index: 0, tokenEstimate: 0 }));
    let length = 0;
    for (const value of counts.values()) length += value;
    return { hit, counts, length, searchMetadata };
  });
  // 长度归一化只按正文候选计算，元数据候选不改变正文结果之间的相对得分。
  const lengthBase = bodyCandidates ? counted.slice(0, bodyCandidates) : counted;
  const averageLength = lengthBase.reduce((sum, item) => sum + item.length, 0) / lengthBase.length || 1;
  const scored = counted.map(({ hit, counts, length, searchMetadata }) => {
    let score = 0;
    for (const { term, idf } of weighted) {
      const frequency = counts.get(term) ?? 0;
      if (frequency) score += idf * frequency * (BM25_K1 + 1) / (frequency + BM25_K1 * (1 - BM25_B + BM25_B * length / averageLength));
    }
    return { hit: { ...hit, score }, searchMetadata };
  });
  const best = new Map<string, (typeof scored)[number]>();
  for (const item of scored) {
    const current = best.get(item.hit.documentId);
    if (!current || item.hit.score > current.hit.score) best.set(item.hit.documentId, item);
  }
  for (const item of best.values()) item.hit.score += metadataScore(item.searchMetadata, metadataTerms);
  return scored.map((item) => item.hit).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 向量召回：同一向量空间（供应商 + 模型）与维度的 ready 文档，常用维度走 HNSW，过滤后不足时精确回退。得分为余弦相似度。 */
export async function vectorSearchChunks(vector: number[], space: VectorSpace, limit: number, db: Executor = getDb(), filters: RetrievalFilters = {}): Promise<ChunkHit[]> {
  if (!vector.length || vector.length > 16000 || vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0)) throw new Error("Invalid query vector");
  const dimensions = vector.length;
  const indexed = HNSW_DIMENSIONS.some((size) => size === dimensions);
  const expression = indexed ? sql`${documentChunks.embedding}::vector(${sql.raw(String(dimensions))})` : sql`${documentChunks.embedding}`;
  const queryVector = `[${vector.join(",")}]`;
  const distance = sql`${expression} <=> ${queryVector}::vector`;
  // Literal dimension matches the partial-index predicate, including generic prepared plans.
  const where = and(documentFilter(filters), ...chunkSpace(space), sql`${documentChunks.dimensions} = ${sql.raw(String(dimensions))}`, isNotNull(documentChunks.embedding));
  const hits = await db.select({ ...chunkHitColumns, score: sql<number>`1 - (${distance})` }).from(documentChunks).innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .where(where)
    .orderBy(distance).limit(limit);
  // ANN post-filtering (including model/status) can underfill. An exact filtered fallback
  // preserves eligible results without requiring pgvector 0.8 iterative-scan settings.
  if (indexed && hits.length < limit) {
    const { rows } = await db.execute<Omit<ChunkHit, "repostSource" | "sectionId"> & { repostSource: string | null; sectionId: string | null } & Record<string, unknown>>(sql`
      WITH eligible AS MATERIALIZED (
        SELECT ${documentChunks.id} AS "chunkId", ${documentChunks.documentId} AS "documentId", ${documentChunks.sectionId} AS "sectionId", ${documents.title} AS title,
          ${documents.url} AS url, ${documents.metadata}->'sourceMeta'->>'repostSource' AS "repostSource",
          ${documentChunks.content} AS content, ${documentChunks.context} AS context, ${documentChunks.sectionPath} AS "sectionPath",
          ${documentChunks.contentType} AS "contentType", ${documentChunks.embedding} AS embedding
        FROM ${documentChunks} INNER JOIN ${documents} ON ${documents.id} = ${documentChunks.documentId} WHERE ${where}
      ) SELECT "chunkId", "documentId", "sectionId", title, url, "repostSource", content, context, "sectionPath", "contentType",
        1 - (embedding <=> ${queryVector}::vector) AS score FROM eligible
      ORDER BY embedding <=> ${queryVector}::vector, "chunkId" LIMIT ${limit}`);
    return rows.map(toChunkHit);
  }
  return hits.map(toChunkHit);
}

/**
 * 摘要召回：先按文章级向量（标题 + 摘要）召回同一向量空间与维度的 ready 文档，再用同一查询向量定位每篇文章内最相关的切片。
 * 每篇返回一个切片，得分为摘要的余弦相似度，按文章排序。常用维度走 HNSW，过滤后不足时精确回退。
 */
export async function summarySearchChunks(vector: number[], space: VectorSpace, limit: number, db: Executor = getDb(), filters: RetrievalFilters = {}): Promise<ChunkHit[]> {
  if (!vector.length || vector.length > 16000 || vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0)) throw new Error("Invalid query vector");
  const dimensions = vector.length;
  const indexed = HNSW_DIMENSIONS.some((size) => size === dimensions);
  const expression = indexed ? sql`${documents.summaryEmbedding}::vector(${sql.raw(String(dimensions))})` : sql`${documents.summaryEmbedding}`;
  const queryVector = `[${vector.join(",")}]`;
  const distance = sql`${expression} <=> ${queryVector}::vector`;
  const where = and(documentFilter(filters), ...documentSpace(space), sql`${documents.embeddingDimensions} = ${sql.raw(String(dimensions))}`, isNotNull(documents.summaryEmbedding));
  let matched = await db.select({ id: documents.id, score: sql<number>`1 - (${distance})` }).from(documents).where(where).orderBy(distance, asc(documents.id)).limit(limit);
  if (indexed && matched.length < limit) {
    ({ rows: matched } = await db.execute<{ id: string; score: number }>(sql`
      WITH eligible AS MATERIALIZED (SELECT ${documents.id} AS id, ${documents.summaryEmbedding} AS embedding FROM ${documents} WHERE ${where})
      SELECT id, 1 - (embedding <=> ${queryVector}::vector) AS score FROM eligible ORDER BY embedding <=> ${queryVector}::vector, id LIMIT ${limit}`));
  }
  if (!matched.length) return [];

  const chunkDistance = sql`${documentChunks.embedding} <=> ${queryVector}::vector`;
  const chunks = await db.selectDistinctOn([documentChunks.documentId], chunkHitColumns).from(documentChunks).innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .where(and(inArray(documentChunks.documentId, matched.map((row) => row.id)), ...chunkSpace(space), sql`${documentChunks.dimensions} = ${sql.raw(String(dimensions))}`, isNotNull(documentChunks.embedding)))
    .orderBy(documentChunks.documentId, chunkDistance, asc(documentChunks.chunkIndex));
  const byDocument = new Map(chunks.map((chunk) => [chunk.documentId, chunk]));
  return matched.flatMap(({ id, score }) => {
    const chunk = byDocument.get(id);
    return chunk ? [toChunkHit({ ...chunk, score })] : [];
  });
}

/** 父块正文及其切片（按原文顺序），供按父块组装回答上下文。 */
export async function listSectionContexts(sectionIds: string[], db: Executor = getDb()): Promise<SectionContext[]> {
  if (!sectionIds.length) return [];
  const ids = [...new Set(sectionIds)];
  const [sections, chunks] = await Promise.all([
    db.select({ id: documentSections.id, documentId: documentSections.documentId, sectionPath: documentSections.sectionPath, content: documentSections.content })
      .from(documentSections).where(inArray(documentSections.id, ids)),
    db.select({ id: documentChunks.id, sectionId: documentChunks.sectionId, content: documentChunks.content })
      .from(documentChunks).where(inArray(documentChunks.sectionId, ids)).orderBy(asc(documentChunks.chunkIndex)),
  ]);
  return sections.map((section) => ({ ...section, chunks: chunks.filter((chunk) => chunk.sectionId === section.id).map(({ id, content }) => ({ id, content })) }));
}

// ---- 知识库 ----

const toKnowledgeBase = (row: typeof knowledgeBases.$inferSelect): KnowledgeBaseRecord => ({ ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! });

export async function listKnowledgeBases(db: Executor = getDb()): Promise<KnowledgeBaseRecord[]> {
  return (await db.select().from(knowledgeBases).orderBy(desc(knowledgeBases.createdAt))).map(toKnowledgeBase);
}

export async function getKnowledgeBase(id: string, db: Executor = getDb()): Promise<KnowledgeBaseRecord | null> {
  const [row] = await db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id));
  return row ? toKnowledgeBase(row) : null;
}

// 只取可保存的字段，忽略请求体中的 id、时间戳等多余字段。
const knowledgeBaseValues = (input: SaveKnowledgeBaseRequest) => ({
  name: input.name, description: input.description, topK: input.topK, similarityThreshold: input.similarityThreshold,
  rerankEnabled: input.rerankEnabled, maxContextLength: input.maxContextLength, prompt: input.prompt, model: input.model,
});

export async function createKnowledgeBase(input: SaveKnowledgeBaseRequest, db: Executor = getDb()): Promise<KnowledgeBaseRecord> {
  const [row] = await db.insert(knowledgeBases).values({ id: randomUUID(), ...knowledgeBaseValues(input) }).returning();
  return toKnowledgeBase(row);
}

/** 未传入的可选字段保持不变（drizzle 会忽略 undefined）。 */
export async function updateKnowledgeBase(id: string, input: SaveKnowledgeBaseRequest, db: Executor = getDb()): Promise<KnowledgeBaseRecord | null> {
  const [row] = await db.update(knowledgeBases).set({ ...knowledgeBaseValues(input), updatedAt: sql`now()` }).where(eq(knowledgeBases.id, id)).returning();
  return row ? toKnowledgeBase(row) : null;
}

// ---- 模型供应商 ----

// 接口记录不含密钥密文，只标记是否已保存；运行时配置（listModelProviderConfigs）才带密文。
const toModelProvider = ({ apiKeyCiphertext, ...row }: typeof modelProviders.$inferSelect): ModelProviderRecord =>
  ({ ...row, hasApiKey: apiKeyCiphertext !== null, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! });

export async function listModelProviders(db: Executor = getDb()): Promise<ModelProviderRecord[]> {
  return (await db.select().from(modelProviders).orderBy(desc(modelProviders.createdAt))).map(toModelProvider);
}

/** 运行时（问答、向量化）使用的供应商配置，带密钥密文，由 providerCredential 在调用时解密。 */
export async function listModelProviderConfigs(db: Executor = getDb()): Promise<ModelProviderConfig[]> {
  return (await db.select().from(modelProviders).orderBy(desc(modelProviders.createdAt)))
    .map((row) => ({ ...toModelProvider(row), apiKeyCiphertext: row.apiKeyCiphertext }));
}

/** 未传入的可选字段：新建时取默认值，更新时保持不变（drizzle 会忽略 undefined）。apiKey 非空时加密保存，clearApiKey 删除已保存的密钥。 */
const modelProviderValues = (id: string, input: SaveModelProviderRequest) => ({
  name: input.name, provider: input.provider, baseUrl: input.baseUrl, credentialEnv: input.credentialEnv, enabled: input.enabled,
  apiKeyCiphertext: input.apiKey?.trim() ? encryptSecret(input.apiKey.trim(), providerSecretContext(id)) : input.clearApiKey ? null : undefined,
});

export async function createModelProvider(input: SaveModelProviderRequest, db: Executor = getDb()): Promise<ModelProviderRecord> {
  const id = randomUUID();
  const [row] = await db.insert(modelProviders).values({ id, ...modelProviderValues(id, input) }).returning();
  return toModelProvider(row);
}

export async function updateModelProvider(id: string, input: SaveModelProviderRequest, db: Executor = getDb()): Promise<ModelProviderRecord | null> {
  const [row] = await db.update(modelProviders).set({ ...modelProviderValues(id, input), updatedAt: sql`now()` }).where(eq(modelProviders.id, id)).returning();
  return row ? toModelProvider(row) : null;
}

/** 正在被业务模型使用的供应商不能删除（外键 RESTRICT）：返回是否已删除，以及使用它的用途。 */
export async function deleteModelProvider(id: string): Promise<{ deleted: boolean; usedBy: ModelCapability[] }> {
  return withTransaction(async (tx) => {
    const usedBy = (await tx.select({ capability: modelSettings.capability }).from(modelSettings).where(eq(modelSettings.providerId, id)).for("update"))
      .map((row) => row.capability);
    if (usedBy.length) return { deleted: false, usedBy };
    const deleted = await tx.delete(modelProviders).where(eq(modelProviders.id, id)).returning({ id: modelProviders.id });
    return { deleted: deleted.length > 0, usedBy };
  });
}

// ---- 业务模型（Chat / Embedding / Rerank / 审核各选一个供应商与模型） ----

const MODEL_CAPABILITIES: ModelCapability[] = ["chat", "embedding", "rerank", "review"];
const toModelSetting = (row: typeof modelSettings.$inferSelect): ModelSettingRecord => ({ ...row, updatedAt: iso(row.updatedAt)! });

export async function getModelSettings(db: Executor = getDb()): Promise<ModelSettingsResponse> {
  const rows = new Map((await db.select().from(modelSettings)).map((row) => [row.capability, toModelSetting(row)]));
  return Object.fromEntries(MODEL_CAPABILITIES.map((capability) => [capability, rows.get(capability) ?? null])) as ModelSettingsResponse;
}

/** 新建时 temperature / maxTokens 省略则取默认值，更新时保持不变。供应商须存在（外键保证）。 */
export async function saveModelSetting(capability: ModelCapability, input: SaveModelSettingRequest, db: Executor = getDb()): Promise<ModelSettingRecord> {
  const values = { providerId: input.providerId, model: input.model.trim(), temperature: input.temperature, maxTokens: input.maxTokens };
  const [row] = await db.insert(modelSettings).values({ capability, ...values })
    .onConflictDoUpdate({ target: modelSettings.capability, set: { ...values, updatedAt: sql`now()` } }).returning();
  return toModelSetting(row);
}

export async function deleteModelSetting(capability: ModelCapability, db: Executor = getDb()): Promise<boolean> {
  return (await db.delete(modelSettings).where(eq(modelSettings.capability, capability)).returning({ capability: modelSettings.capability })).length > 0;
}

/** 运行时各用途的模型（带供应商密钥密文）；未配置或供应商已停用的用途为 null。 */
export async function getModelSelections(db: Executor = getDb()): Promise<Record<ModelCapability, ModelSelection | null>> {
  const rows = await db.select({ setting: modelSettings, provider: modelProviders }).from(modelSettings)
    .innerJoin(modelProviders, eq(modelProviders.id, modelSettings.providerId)).where(eq(modelProviders.enabled, true));
  const selections = new Map(rows.map(({ setting, provider }) => [setting.capability, {
    provider: { ...toModelProvider(provider), apiKeyCiphertext: provider.apiKeyCiphertext },
    model: setting.model, temperature: setting.temperature, maxTokens: setting.maxTokens,
  }]));
  return Object.fromEntries(MODEL_CAPABILITIES.map((capability) => [capability, selections.get(capability) ?? null])) as Record<ModelCapability, ModelSelection | null>;
}

export async function getModelSelection(capability: ModelCapability, db: Executor = getDb()): Promise<ModelSelection | null> {
  return (await getModelSelections(db))[capability];
}

// ---- 后台配置的全局密钥 ----

/** nyzdata 文章接口 token（所有文章来源共用）。 */
export const ARTICLE_TOKEN_SETTING = "nyzdata_article_token";

export async function getSecretSettingStatus(name: string, db: Executor = getDb()): Promise<SecretSettingStatus> {
  const [row] = await db.select({ updatedAt: secretSettings.updatedAt }).from(secretSettings).where(eq(secretSettings.name, name));
  return { configured: Boolean(row), updatedAt: row ? iso(row.updatedAt)! : null, encryptionReady: secretKeyConfigured() };
}

/** 加密保存；密文绑定设置名，不能挪作他用。 */
export async function saveSecretSetting(name: string, value: string, db: Executor = getDb()): Promise<SecretSettingStatus> {
  const ciphertext = encryptSecret(value, name);
  await db.insert(secretSettings).values({ name, ciphertext })
    .onConflictDoUpdate({ target: secretSettings.name, set: { ciphertext, updatedAt: sql`now()` } });
  return getSecretSettingStatus(name, db);
}

export async function deleteSecretSetting(name: string, db: Executor = getDb()): Promise<boolean> {
  return (await db.delete(secretSettings).where(eq(secretSettings.name, name)).returning({ name: secretSettings.name })).length > 0;
}

/** 解密后的值；未配置时为 null，无法解密时抛出 SecretKeyError。 */
export async function readSecretSetting(name: string, db: Executor = getDb()): Promise<string | null> {
  const [row] = await db.select({ ciphertext: secretSettings.ciphertext }).from(secretSettings).where(eq(secretSettings.name, name));
  return row ? decryptSecret(row.ciphertext, name) : null;
}

// ---- 用户 ----

/** 会话与问答的归属：已登录用户，或匿名访客（访客 Cookie 的 SHA-256）。 */
export type ChatOwner = { userId: string; visitorHash?: undefined } | { visitorHash: string; userId?: undefined };

const ownedBy = (table: typeof chatSessions | typeof chatMessages, owner: ChatOwner) =>
  owner.userId !== undefined ? eq(table.userId, owner.userId) : eq(table.visitorHash, owner.visitorHash);
const ownerValues = (owner: ChatOwner | undefined) => ({ userId: owner?.userId ?? null, visitorHash: owner?.visitorHash ?? null });

/** 登录校验用的账号字段，含密码哈希，只在 API 内使用。 */
export interface UserCredentials {
  id: string;
  email: string;
  passwordHash: string;
  sessionVersion: number;
  disabled: boolean;
  createdAt: string;
}

const credentialColumns = {
  id: users.id, email: users.email, passwordHash: users.passwordHash, sessionVersion: users.sessionVersion, disabledAt: users.disabledAt, createdAt: users.createdAt,
};
type CredentialRow = { id: string; email: string; passwordHash: string; sessionVersion: number; disabledAt: Date | null; createdAt: Date };
const toCredentials = ({ disabledAt, createdAt, ...row }: CredentialRow): UserCredentials => ({ ...row, disabled: disabledAt !== null, createdAt: iso(createdAt)! });

/** email 须为小写规范形式。 */
export async function getUserCredentials(by: { id: string } | { email: string }, db: Executor = getDb()): Promise<UserCredentials | null> {
  const [row] = await db.select(credentialColumns).from(users).where("id" in by ? eq(users.id, by.id) : eq(users.email, by.email));
  return row ? toCredentials(row) : null;
}

/** 创建账号；邮箱已注册时返回 null。 */
export async function createUser(input: { email: string; passwordHash: string }, db: Executor = getDb()): Promise<UserCredentials | null> {
  const [row] = await db.insert(users).values({ id: randomUUID(), email: input.email, passwordHash: input.passwordHash })
    .onConflictDoNothing({ target: users.email }).returning(credentialColumns);
  return row ? toCredentials(row) : null;
}

/** 修改密码并使该账号已签发的登录会话全部失效，返回新的会话版本；账号不存在时返回 null。 */
export async function updateUserPassword(id: string, passwordHash: string, db: Executor = getDb()): Promise<number | null> {
  const [row] = await db.update(users).set({ passwordHash, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: sql`now()` })
    .where(eq(users.id, id)).returning({ sessionVersion: users.sessionVersion });
  return row?.sessionVersion ?? null;
}

export async function recordUserLogin(id: string, db: Executor = getDb()): Promise<void> {
  await db.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, id));
}

/**
 * 把访客在本浏览器中的会话与问答归入账号（登录或注册时调用）。
 * 与 createChatMessage 并发时，两者都先更新会话行：行锁保证新问答要么随后被一并认领，要么写入时已读到新的归属。
 */
export async function claimVisitorData(visitorHash: string, userId: string, db?: Executor): Promise<void> {
  const claim = async (tx: Executor) => {
    await tx.update(chatSessions).set({ userId, visitorHash: null }).where(eq(chatSessions.visitorHash, visitorHash));
    await tx.update(chatMessages).set({ userId, visitorHash: null }).where(eq(chatMessages.visitorHash, visitorHash));
  };
  if (db) await claim(db);
  else await withTransaction(claim);
}

const adminUserColumns = {
  id: users.id, email: users.email, disabledAt: users.disabledAt, createdAt: users.createdAt, lastLoginAt: users.lastLoginAt,
  sessionCount: sql<number>`(SELECT count(*)::int FROM ${chatSessions} WHERE ${chatSessions.userId} = ${outer("users", "id")})`,
  messageCount: sql<number>`(SELECT count(*)::int FROM ${chatMessages} WHERE ${chatMessages.userId} = ${outer("users", "id")})`,
};

type AdminUserRow = { id: string; email: string; disabledAt: Date | null; createdAt: Date; lastLoginAt: Date | null; sessionCount: number; messageCount: number };
const toAdminUser = ({ disabledAt, createdAt, lastLoginAt, ...row }: AdminUserRow): AdminUserRecord => compact<AdminUserRecord>({
  ...row, disabled: disabledAt !== null, createdAt: iso(createdAt)!, lastLoginAt: iso(lastLoginAt) ?? null,
});

export async function listUsers(filter: { query?: string; page: number; pageSize: number }, db: Executor = getDb()): Promise<AdminUserListResponse> {
  const query = filter.query?.trim().toLocaleLowerCase();
  const where = query ? contains(sql`${users.email}`, query) : undefined;
  const { limit, offset } = paging(filter.page, filter.pageSize);
  const [rows, [{ total }]] = await Promise.all([
    db.select(adminUserColumns).from(users).where(where).orderBy(desc(users.createdAt), asc(users.id)).limit(limit).offset(offset),
    db.select({ total: count() }).from(users).where(where),
  ]);
  return { users: rows.map(toAdminUser), total };
}

/** 停用账号会使其登录会话立即失效；账号不存在时返回 null。 */
export async function setUserDisabled(id: string, disabled: boolean, db: Executor = getDb()): Promise<AdminUserRecord | null> {
  const updated = await db.update(users).set(disabled
    ? { disabledAt: sql`COALESCE(${users.disabledAt}, now())`, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: sql`now()` }
    : { disabledAt: null, updatedAt: sql`now()` }).where(eq(users.id, id)).returning({ id: users.id });
  if (!updated.length) return null;
  const [row] = await db.select(adminUserColumns).from(users).where(eq(users.id, id));
  return toAdminUser(row!);
}

// ---- 问答会话 ----

const SESSION_TITLE_LENGTH = 40;
const sessionTitle = (question: string) => {
  const text = question.replace(/\s+/g, " ").trim();
  return text.length > SESSION_TITLE_LENGTH ? `${text.slice(0, SESSION_TITLE_LENGTH)}…` : text;
};

const sessionColumns = {
  ...getTableColumns(chatSessions),
  messageCount: sql<number>`(SELECT count(*)::int FROM ${chatMessages} WHERE ${chatMessages.sessionId} = ${outer("chat_sessions", "id")} AND ${chatMessages.supersededAt} IS NULL)`,
};

type SessionRow = typeof chatSessions.$inferSelect & { messageCount: number };
const toChatSession = ({ userId: _userId, visitorHash: _visitorHash, ...row }: SessionRow): ChatSessionRecord => compact<ChatSessionRecord>({
  ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
});

export async function createChatSession(input: { title?: string; knowledgeBaseId?: string; owner: ChatOwner }, db: Executor = getDb()): Promise<ChatSessionRecord> {
  const id = randomUUID();
  await db.insert(chatSessions).values({ id, title: sessionTitle(input.title ?? ""), knowledgeBaseId: input.knowledgeBaseId ?? null, ...ownerValues(input.owner) });
  return (await getChatSession(id, input.owner, db))!;
}

/** 只返回属于 owner 的会话；他人的会话与不存在的会话一样返回 null。 */
export async function getChatSession(id: string, owner: ChatOwner, db: Executor = getDb()): Promise<ChatSessionRecord | null> {
  const [row] = await db.select(sessionColumns).from(chatSessions).where(and(eq(chatSessions.id, id), ownedBy(chatSessions, owner)));
  return row ? toChatSession(row) : null;
}

export async function listChatSessions(filter: { page: number; pageSize: number }, owner: ChatOwner, db: Executor = getDb()): Promise<ChatSessionListResponse> {
  const { limit, offset } = paging(filter.page, filter.pageSize);
  const where = ownedBy(chatSessions, owner);
  const [rows, [{ total }]] = await Promise.all([
    db.select(sessionColumns).from(chatSessions).where(where).orderBy(desc(chatSessions.updatedAt), asc(chatSessions.id)).limit(limit).offset(offset),
    db.select({ total: count() }).from(chatSessions).where(where),
  ]);
  return { sessions: rows.map(toChatSession), total };
}

export async function deleteChatSession(id: string, owner: ChatOwner, db: Executor = getDb()): Promise<boolean> {
  return (await db.delete(chatSessions).where(and(eq(chatSessions.id, id), ownedBy(chatSessions, owner))).returning({ id: chatSessions.id })).length > 0;
}

// ---- 问答记录 ----

// json_strip_nulls 省略为空的可选字段（转载源、各路得分）。
const messageSourcesColumn = sql<ChatLogRecord["sources"]>`COALESCE((
    SELECT json_agg(json_strip_nulls(json_build_object('documentId', ${messageSources.documentId}, 'title', ${messageSources.title}, 'url', ${messageSources.url},
      'repostSource', ${messageSources.repostSource})) ORDER BY ${messageSources.position})
    FROM ${messageSources} WHERE ${messageSources.messageId} = ${outer("chat_messages", "id")}), '[]')`;

const messageColumns = {
  ...getTableColumns(chatMessages),
  sources: messageSourcesColumn,
  chunks: sql<ChatLogRecord["chunks"]>`COALESCE((
    SELECT json_agg(json_strip_nulls(json_build_object('chunkId', ${messageChunks.chunkId}, 'documentId', ${messageChunks.documentId}, 'citation', ${messageChunks.citation},
      'title', ${messageChunks.title}, 'sectionPath', ${messageChunks.sectionPath}, 'excerpt', ${messageChunks.excerpt}, 'score', ${messageChunks.score},
      'vectorScore', ${messageChunks.vectorScore}, 'keywordScore', ${messageChunks.keywordScore}, 'summaryScore', ${messageChunks.summaryScore},
      'rerankScore', ${messageChunks.rerankScore})) ORDER BY ${messageChunks.position})
    FROM ${messageChunks} WHERE ${messageChunks.messageId} = ${outer("chat_messages", "id")}), '[]')`,
  userEmail: sql<string | null>`(SELECT ${users.email} FROM ${users} WHERE ${users.id} = ${outer("chat_messages", "user_id")})`,
};

type ChatLogRow = typeof chatMessages.$inferSelect & { sources: ChatLogRecord["sources"]; chunks: ChatLogRecord["chunks"]; userEmail: string | null };
const toChatLog = ({ rating, userId, visitorHash, ...row }: ChatLogRow): ChatLogRecord => ({
  ...compact<Omit<ChatLogRecord, "rating" | "ownerType">>({ ...row, supersededAt: iso(row.supersededAt), createdAt: iso(row.createdAt)! }),
  ownerType: userId ? "user" : visitorHash ? "visitor" : "none",
  rating,
});

type NewChatMessage = Omit<ChatLogRecord, "createdAt" | "rating" | "answerMode" | "chunks" | "supersededAt" | "ownerType" | "userEmail"> & {
  answerMode?: ChatLogRecord["answerMode"]; chunks?: ChatRetrievedChunk[]; createdAt?: string; rating?: ChatFeedbackRating | null;
  /** 重新生成时被替换的消息；必须是同一会话中仍有效的消息。 */
  supersedes?: string;
  /** 单次问答的提问者；会话中的问答始终跟随会话归属。省略时为无归属（旧快照导入）。 */
  owner?: ChatOwner;
};

export class ChatConflictError extends Error {}

/** 保存一轮问答；属于会话时同时更新会话时间（标题为空时取问题），重新生成时标记被替换的消息。 */
export async function createChatMessage(log: NewChatMessage, db?: Executor): Promise<void> {
  const insert = async (tx: Executor) => {
    if (log.supersedes) {
      if (!log.sessionId) throw new ChatConflictError("Only session messages can be regenerated.");
      const replaced = await tx.update(chatMessages).set({ supersededAt: sql`now()` })
        .where(and(eq(chatMessages.id, log.supersedes), eq(chatMessages.sessionId, log.sessionId), isNull(chatMessages.supersededAt)))
        .returning({ id: chatMessages.id });
      if (!replaced.length) throw new ChatConflictError("The message has already been regenerated or removed.");
    }
    let owner = ownerValues(log.owner);
    if (log.sessionId) {
      // 生成期间访客可能已登录、会话已归入账号，因此以会话当前的归属为准。
      const [updated] = await tx.update(chatSessions)
        .set({ updatedAt: sql`now()`, title: sql`CASE WHEN ${chatSessions.title} = '' THEN ${sessionTitle(log.question)} ELSE ${chatSessions.title} END` })
        .where(eq(chatSessions.id, log.sessionId)).returning({ userId: chatSessions.userId, visitorHash: chatSessions.visitorHash });
      if (!updated) throw new ChatConflictError("The chat session has been deleted.");
      owner = updated;
    }
    await tx.insert(chatMessages).values({
      id: log.id, sessionId: log.sessionId ?? null, ...owner, question: log.question, answer: log.answer, answerMode: log.answerMode ?? "extractive", knowledgeBaseId: log.knowledgeBaseId ?? null, model: log.model ?? null,
      retrievalMs: log.retrievalMs ?? null, firstTokenMs: log.firstTokenMs ?? null, totalMs: log.totalMs ?? null, promptTokens: log.promptTokens ?? null,
      completionTokens: log.completionTokens ?? null, rating: log.rating ?? null, createdAt: log.createdAt ? new Date(log.createdAt) : undefined,
    });
    if (log.sources.length) {
      await tx.insert(messageSources).values(log.sources.map((source, position) => ({
        messageId: log.id, position, documentId: source.documentId, title: source.title, url: source.url, repostSource: source.repostSource ?? null,
      })));
    }
    if (log.chunks?.length) {
      await tx.insert(messageChunks).values(log.chunks.map((chunk, position) => ({
        messageId: log.id, position, chunkId: chunk.chunkId, documentId: chunk.documentId, citation: chunk.citation, title: chunk.title, sectionPath: chunk.sectionPath,
        excerpt: chunk.excerpt, score: chunk.score, vectorScore: chunk.vectorScore ?? null, keywordScore: chunk.keywordScore ?? null,
        summaryScore: chunk.summaryScore ?? null, rerankScore: chunk.rerankScore ?? null,
      })));
    }
  };
  if (db) await insert(db);
  else await withTransaction(insert);
}

export async function listChatMessages(filter: { query?: string; rating?: string; page: number; pageSize: number }, db: Executor = getDb()): Promise<ChatLogListResponse> {
  const query = filter.query?.trim().toLocaleLowerCase();
  const where = and(
    query ? or(
      contains(sql`${chatMessages.question} || ' ' || ${chatMessages.answer}`, query),
      sql`EXISTS (SELECT 1 FROM ${messageSources} WHERE ${messageSources.messageId} = ${outer("chat_messages", "id")} AND ${contains(sql`${messageSources.title}`, query)})`,
      sql`EXISTS (SELECT 1 FROM ${users} WHERE ${users.id} = ${outer("chat_messages", "user_id")} AND ${contains(sql`${users.email}`, query)})`,
    ) : undefined,
    filter.rating === "rated" ? isNotNull(chatMessages.rating) : filter.rating === "unrated" ? isNull(chatMessages.rating) : undefined,
  );
  const { limit, offset } = paging(filter.page, filter.pageSize);
  const [rows, [{ total }]] = await Promise.all([
    db.select(messageColumns).from(chatMessages).where(where).orderBy(desc(chatMessages.createdAt), asc(chatMessages.id)).limit(limit).offset(offset),
    db.select({ total: count() }).from(chatMessages).where(where),
  ]);
  return { logs: rows.map(toChatLog), total };
}

// 用户端的来源另附该文章被送入模型的片段摘录（按召回顺序）。两层子查询都有同名列，内层用别名、外层用 outer() 限定。
const messageSourcesWithExcerptsColumn = sql<ChatSessionMessage["sources"]>`COALESCE((
    SELECT json_agg(json_strip_nulls(json_build_object('documentId', ${messageSources.documentId}, 'title', ${messageSources.title}, 'url', ${messageSources.url},
      'repostSource', ${messageSources.repostSource}, 'excerpts', COALESCE((
        SELECT json_agg(json_build_object('sectionPath', mc.section_path, 'text', mc.excerpt) ORDER BY mc.position)
        FROM ${messageChunks} AS mc WHERE mc.message_id = ${outer("message_sources", "message_id")} AND mc.document_id = ${outer("message_sources", "document_id")}
      ), '[]'))) ORDER BY ${messageSources.position})
    FROM ${messageSources} WHERE ${messageSources.messageId} = ${outer("chat_messages", "id")}), '[]')`;

/** 会话中仍有效的问答，按时间正序。 */
export async function listSessionMessages(sessionId: string, db: Executor = getDb()): Promise<ChatSessionMessage[]> {
  const rows = await db.select({
    id: chatMessages.id, question: chatMessages.question, answer: chatMessages.answer, answerMode: chatMessages.answerMode, rating: chatMessages.rating,
    createdAt: chatMessages.createdAt, sources: messageSourcesWithExcerptsColumn,
  }).from(chatMessages).where(and(eq(chatMessages.sessionId, sessionId), isNull(chatMessages.supersededAt))).orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt)! }));
}

/** 只能评价自己的问答；他人的与不存在的问答一样返回 false。 */
export async function rateChatMessage(id: string, rating: ChatFeedbackRating, owner: ChatOwner, db: Executor = getDb()): Promise<boolean> {
  return (await db.update(chatMessages).set({ rating }).where(and(eq(chatMessages.id, id), ownedBy(chatMessages, owner))).returning({ id: chatMessages.id })).length > 0;
}

// ---- 管理员账号与角色 ----

/** 管理员账号与角色操作的业务错误，由 API 转为 4xx。 */
export class AdminAccountError extends Error {
  constructor(readonly reason: "super-admin-disable" | "super-admin-role" | "role-missing" | "role-in-use" | "role-name-taken") {
    super(reason);
    this.name = "AdminAccountError";
  }
}

const pgErrorCode = (error: unknown) => {
  const cause = error as { code?: string; cause?: { code?: string } };
  return cause.code ?? cause.cause?.code;
};

const pgConstraint = (error: unknown) => {
  const cause = error as { constraint?: string; cause?: { constraint?: string } };
  return cause.constraint ?? cause.cause?.constraint;
};

/** 管理员登录校验用的账号字段，含密码哈希，只在 API 内使用。 */
export interface AdminCredentials {
  id: string;
  email: string;
  nickname: string;
  isSuper: boolean;
  passwordHash: string;
  sessionVersion: number;
  disabled: boolean;
  roleId: string | null;
  roleName: string | null;
  /** 当前生效的权限：超级管理员为全部；角色停用或未分配角色时为空。 */
  permissions: AdminPermission[];
  createdAt: string;
  updatedAt: string;
}

const adminCredentialColumns = {
  id: adminAccounts.id, email: adminAccounts.email, nickname: adminAccounts.nickname, isSuper: adminAccounts.isSuper,
  passwordHash: adminAccounts.passwordHash, sessionVersion: adminAccounts.sessionVersion,
  disabledAt: adminAccounts.disabledAt, createdAt: adminAccounts.createdAt, updatedAt: adminAccounts.updatedAt,
  roleId: adminAccounts.roleId, roleName: adminRoles.name, roleDisabledAt: adminRoles.disabledAt, rolePermissions: adminRoles.permissions,
};
const selectAdmins = (db: Executor) => db.select(adminCredentialColumns).from(adminAccounts).leftJoin(adminRoles, eq(adminAccounts.roleId, adminRoles.id));
type AdminCredentialRow = Awaited<ReturnType<typeof selectAdmins>>[number];

function toAdminCredentials({ disabledAt, createdAt, updatedAt, roleDisabledAt, rolePermissions, ...row }: AdminCredentialRow): AdminCredentials {
  const permissions = row.isSuper ? [...ADMIN_PERMISSIONS] : rolePermissions && !roleDisabledAt ? normalizeAdminPermissions(rolePermissions) : [];
  return { ...row, permissions, disabled: disabledAt !== null, createdAt: iso(createdAt)!, updatedAt: iso(updatedAt)! };
}

const toAdminAccount = (row: AdminCredentialRow): AdminAccount => {
  const { passwordHash: _ph, sessionVersion: _sv, permissions: _p, ...account } = toAdminCredentials(row);
  return account;
};

async function getAdminAccount(id: string, db: Executor): Promise<AdminAccount | null> {
  const [row] = await selectAdmins(db).where(eq(adminAccounts.id, id));
  return row ? toAdminAccount(row) : null;
}

/** email 须为小写规范形式。by id 或 by email。 */
export async function getAdminCredentials(by: { id: string } | { email: string }, db: Executor = getDb()): Promise<AdminCredentials | null> {
  const [row] = await selectAdmins(db).where("id" in by ? eq(adminAccounts.id, by.id) : eq(adminAccounts.email, by.email));
  return row ? toAdminCredentials(row) : null;
}

/** 列出所有管理员账号（不含密码哈希），按创建时间排序。 */
export async function listAdminAccounts(db: Executor = getDb()): Promise<AdminAccount[]> {
  const rows = await selectAdmins(db).orderBy(asc(adminAccounts.createdAt), asc(adminAccounts.id));
  return rows.map(toAdminAccount);
}

/** 创建管理员账号；邮箱已存在时返回 null，角色不存在时抛出 AdminAccountError。 */
export async function createAdminAccount(
  input: { email: string; nickname: string; passwordHash: string; isSuper?: boolean; roleId?: string | null },
  db: Executor = getDb(),
): Promise<AdminAccount | null> {
  let row: { id: string } | undefined;
  try {
    [row] = await db.insert(adminAccounts)
      .values({ id: randomUUID(), email: input.email, nickname: input.nickname, passwordHash: input.passwordHash, isSuper: input.isSuper ?? false, roleId: input.isSuper ? null : input.roleId ?? null })
      .onConflictDoNothing({ target: adminAccounts.email })
      .returning({ id: adminAccounts.id });
  } catch (error) {
    if (pgErrorCode(error) === "23503") throw new AdminAccountError("role-missing");
    throw error;
  }
  return row ? getAdminAccount(row.id, db) : null;
}

/**
  * 种子：仅在没有超级管理员时创建初始账号，防止并发双重创建。
 * 返回已有或新建的超级管理员；若已有账号则不改动任何数据。
 */
export async function seedSuperAdmin(
  input: { email: string; nickname: string; passwordHash: string },
): Promise<{ created: boolean; id: string }> {
  return withTransaction(async (db) => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(4637202)`);
    const existing = await db.select({ id: adminAccounts.id }).from(adminAccounts)
      .where(eq(adminAccounts.isSuper, true)).limit(1);
    if (existing.length) return { created: false, id: existing[0]!.id };
    const [row] = await db.insert(adminAccounts)
      .values({ id: randomUUID(), email: input.email, nickname: input.nickname, passwordHash: input.passwordHash, isSuper: true })
      .onConflictDoNothing({ target: adminAccounts.email })
      .returning({ id: adminAccounts.id });
    if (row) return { created: true, id: row.id };
    throw new Error("Bootstrap administrator email is already in use");
  });
}

/** 修改密码并使该账号已签发的会话全部失效，返回新的会话版本；账号不存在时返回 null。 */
export async function updateAdminPassword(id: string, passwordHash: string, db: Executor = getDb()): Promise<number | null> {
  const [row] = await db.update(adminAccounts)
    .set({ passwordHash, sessionVersion: sql`${adminAccounts.sessionVersion} + 1`, updatedAt: sql`now()` })
    .where(eq(adminAccounts.id, id)).returning({ sessionVersion: adminAccounts.sessionVersion });
  return row?.sessionVersion ?? null;
}

/** 更新邮箱与昵称；返回更新后的账号；账号不存在时返回 null。邮箱冲突返回 null。 */
export async function updateAdminProfile(
  id: string,
  input: { email: string; nickname: string },
  db: Executor = getDb(),
): Promise<AdminAccount | null> {
  try {
    const [row] = await db.update(adminAccounts)
      .set({ email: input.email, nickname: input.nickname, updatedAt: sql`now()` })
      .where(eq(adminAccounts.id, id)).returning({ id: adminAccounts.id });
    return row ? getAdminAccount(row.id, db) : null;
  } catch (error) {
    if (pgErrorCode(error) === "23505") return null;
    throw error;
  }
}

/**
 * 停用/启用管理员账号或更换角色；停用时使会话失效（角色与权限每次请求重新读取，换角色无需失效）。
 * 超级管理员不能停用、不能分配角色；账号不存在时返回 null。
 */
export async function updateAdminAccount(
  id: string,
  input: { disabled?: boolean; roleId?: string | null },
  db: Executor = getDb(),
): Promise<AdminAccount | null> {
  const [existing] = await db.select({ isSuper: adminAccounts.isSuper }).from(adminAccounts).where(eq(adminAccounts.id, id));
  if (!existing) return null;
  if (existing.isSuper && input.disabled) throw new AdminAccountError("super-admin-disable");
  if (existing.isSuper && input.roleId) throw new AdminAccountError("super-admin-role");
  const changes: PgUpdateSetSource<typeof adminAccounts> = { updatedAt: sql`now()` };
  if (input.disabled === true) {
    changes.disabledAt = sql`COALESCE(${adminAccounts.disabledAt}, now())`;
    changes.sessionVersion = sql`${adminAccounts.sessionVersion} + 1`;
  } else if (input.disabled === false) {
    changes.disabledAt = null;
  }
  if (input.roleId !== undefined) changes.roleId = input.roleId;
  try {
    await db.update(adminAccounts).set(changes).where(eq(adminAccounts.id, id));
  } catch (error) {
    if (pgErrorCode(error) === "23503") throw new AdminAccountError("role-missing");
    throw error;
  }
  return getAdminAccount(id, db);
}

const adminRoleColumns = { ...getTableColumns(adminRoles), adminCount: sql<number>`count(${adminAccounts.id})::int` };
const selectRoles = (db: Executor) => db.select(adminRoleColumns).from(adminRoles)
  .leftJoin(adminAccounts, eq(adminAccounts.roleId, adminRoles.id)).groupBy(adminRoles.id);
type AdminRoleRow = Awaited<ReturnType<typeof selectRoles>>[number];
const toAdminRole = ({ permissions, disabledAt, createdAt, updatedAt, ...row }: AdminRoleRow): AdminRole =>
  ({ ...row, permissions: normalizeAdminPermissions(permissions), disabled: disabledAt !== null, createdAt: iso(createdAt)!, updatedAt: iso(updatedAt)! });

export async function listAdminRoles(db: Executor = getDb()): Promise<AdminRole[]> {
  return (await selectRoles(db).orderBy(asc(adminRoles.createdAt), asc(adminRoles.id))).map(toAdminRole);
}

export async function getAdminRole(id: string, db: Executor = getDb()): Promise<AdminRole | null> {
  const [row] = await selectRoles(db).where(eq(adminRoles.id, id));
  return row ? toAdminRole(row) : null;
}

/** 创建角色；名称重复时抛出 AdminAccountError。 */
export async function createAdminRole(input: SaveAdminRoleRequest, db: Executor = getDb()): Promise<AdminRole> {
  const id = randomUUID();
  try {
    await db.insert(adminRoles).values({ id, name: input.name, description: input.description, permissions: normalizeAdminPermissions(input.permissions) });
  } catch (error) {
    if (pgErrorCode(error) === "23505") throw new AdminAccountError("role-name-taken");
    throw error;
  }
  return (await getAdminRole(id, db))!;
}

/** 编辑角色或停用/启用；角色不存在时返回 null，名称重复时抛出 AdminAccountError。 */
export async function updateAdminRole(id: string, input: UpdateAdminRoleRequest, db: Executor = getDb()): Promise<AdminRole | null> {
  const changes: PgUpdateSetSource<typeof adminRoles> = { updatedAt: sql`now()` };
  if (input.name !== undefined) changes.name = input.name;
  if (input.description !== undefined) changes.description = input.description;
  if (input.permissions !== undefined) changes.permissions = normalizeAdminPermissions(input.permissions);
  if (input.disabled !== undefined) changes.disabledAt = input.disabled ? sql`COALESCE(${adminRoles.disabledAt}, now())` : null;
  try {
    const updated = await db.update(adminRoles).set(changes).where(eq(adminRoles.id, id)).returning({ id: adminRoles.id });
    if (!updated.length) return null;
  } catch (error) {
    if (pgErrorCode(error) === "23505") throw new AdminAccountError("role-name-taken");
    throw error;
  }
  return getAdminRole(id, db);
}

/** 删除角色；有管理员使用时抛出 AdminAccountError（外键 RESTRICT），角色不存在时返回 false。 */
export async function deleteAdminRole(id: string, db: Executor = getDb()): Promise<boolean> {
  try {
    return (await db.delete(adminRoles).where(eq(adminRoles.id, id)).returning({ id: adminRoles.id })).length > 0;
  } catch (error) {
    if (["23001", "23503"].includes(pgErrorCode(error) ?? "")) throw new AdminAccountError("role-in-use");
    throw error;
  }
}

export type AdminAuditInput = Omit<AdminAuditLogRecord, "id" | "adminEmail" | "adminNickname" | "createdAt">;

/** 写入一条管理端操作日志。 */
export async function recordAdminAudit(entry: AdminAuditInput, db: Executor = getDb()): Promise<void> {
  await db.insert(adminAuditLogs).values({ id: randomUUID(), ...entry });
}

/** 操作日志按时间倒序；query 匹配操作者邮箱/昵称、路由、资源 ID 与 IP。 */
export async function listAdminAuditLogs(
  filter: { query?: string; result?: string; page: number; pageSize: number },
  db: Executor = getDb(),
): Promise<AdminAuditLogListResponse> {
  const query = filter.query?.trim().toLocaleLowerCase();
  const where = and(
    query ? or(
      contains(sql`${adminAuditLogs.route}`, query),
      contains(sql`coalesce(${adminAuditLogs.resourceId}, '')`, query),
      contains(sql`${adminAuditLogs.ip}`, query),
      contains(sql`coalesce(${adminAccounts.email}, '') || ' ' || coalesce(${adminAccounts.nickname}, '')`, query),
    ) : undefined,
    filter.result ? eq(adminAuditLogs.result, filter.result as AdminAuditResult) : undefined,
  );
  const { limit, offset } = paging(filter.page, filter.pageSize);
  const [rows, [{ total }]] = await Promise.all([
    db.select({ ...getTableColumns(adminAuditLogs), adminEmail: adminAccounts.email, adminNickname: adminAccounts.nickname })
      .from(adminAuditLogs).leftJoin(adminAccounts, eq(adminAuditLogs.adminId, adminAccounts.id))
      .where(where).orderBy(desc(adminAuditLogs.createdAt), desc(adminAuditLogs.id)).limit(limit).offset(offset),
    db.select({ total: count() }).from(adminAuditLogs).leftJoin(adminAccounts, eq(adminAuditLogs.adminId, adminAccounts.id)).where(where),
  ]);
  return { logs: rows.map((row) => ({ ...row, createdAt: iso(row.createdAt)! })), total };
}
