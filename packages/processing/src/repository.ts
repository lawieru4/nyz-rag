import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, getTableColumns, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { ArticleDetail } from "./article/parse.js";
import { embeddingInput, summaryEmbeddingInput } from "./chunking.js";
import type { ChunkHit } from "./rag.js";
import { metadataScore, metadataSearchTerms, searchTerms, termCounts, type SearchableMetadata } from "./search-terms.js";
import type {
  ArticleMetadata, ArticleSourceSyncState, ChatFeedbackRating, ChatLogListResponse, ChatLogRecord, ChatRetrievedChunk, ChatSessionListResponse, ChatSessionMessage,
  ChatSessionRecord, CrawlTaskRecord, CreateSourceRequest, DataSourceRecord, DocumentChunkRecord,
  DocumentDetail, DocumentEmbeddingRecord, DocumentListResponse, DocumentProcessingStatus, DocumentRecord, DocumentStatus, DocumentSummary, KnowledgeBaseRecord,
  KnowledgeStats, ModelProviderRecord, RetrievalFilters, SaveKnowledgeBaseRequest, SaveModelProviderRequest,
} from "@nyz-rag/types";
import { getDb, withTransaction, type Executor } from "./db.js";
import { chatMessages, chatSessions, crawlTasks, dataSources, documentChunks, documents, HNSW_DIMENSIONS, knowledgeBases, messageChunks, messageSources, modelProviders } from "./schema.js";

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

const { syncState: _syncState, ...sourceTableColumns } = getTableColumns(dataSources);
const sourceColumns = {
  ...sourceTableColumns,
  documentCount: sql<number>`(SELECT count(*)::int FROM ${documents} WHERE ${documents.sourceId} = ${outer("data_sources", "id")} AND ${documents.status} = 'ready')`,
};

type SourceRow = Omit<typeof dataSources.$inferSelect, "syncState"> & { documentCount: number };
const toSource = (row: SourceRow): DataSourceRecord => ({
  id: row.id, name: row.name, url: row.url, kind: row.kind, frequency: row.frequency, status: row.status,
  documentCount: row.documentCount, updatedAt: iso(row.syncedAt) ?? null,
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
  id: row.id, sourceId: row.sourceId, sourceName: row.sourceName, status: row.status, progress: row.progress, createdAt: iso(row.createdAt)!, error: row.error,
});

export async function listTasks(limit = 100, db: Executor = getDb()): Promise<CrawlTaskRecord[]> {
  return (await db.select().from(crawlTasks).orderBy(desc(crawlTasks.createdAt)).limit(limit)).map(toTask);
}

export async function getTask(id: string, db: Executor = getDb()): Promise<CrawlTaskRecord | null> {
  const [row] = await db.select().from(crawlTasks).where(eq(crawlTasks.id, id));
  return row ? toTask(row) : null;
}

export async function createTask(source: DataSourceRecord, db: Executor = getDb()): Promise<CrawlTaskRecord> {
  const [row] = await db.insert(crawlTasks)
    .values({ id: `CR-${Date.now().toString().slice(-8)}`, sourceId: source.id, sourceName: source.name, status: "等待中" })
    .returning();
  return toTask(row);
}

/** 未传入的字段保持不变；`error: null` 清除错误。 */
export async function updateTask(id: string, patch: { status?: CrawlTaskRecord["status"]; progress?: number; error?: string | null }, db: Executor = getDb()): Promise<void> {
  await db.update(crawlTasks).set(patch).where(eq(crawlTasks.id, id));
}

export async function getStats(db: Executor = getDb()): Promise<KnowledgeStats> {
  const [[documentStats], [sourceStats], [taskStats]] = await Promise.all([
    db.select({ ready: count(sql`CASE WHEN ${documents.status} = 'ready' THEN 1 END`), lastUpdated: sql<string | null>`max(${documents.updatedAt})` }).from(documents),
    db.select({ total: count() }).from(dataSources),
    db.select({ active: count() }).from(crawlTasks).where(or(eq(crawlTasks.status, "等待中"), eq(crawlTasks.status, "运行中"))),
  ]);
  // 原始 SQL 聚合不经过列映射，max() 返回数据库时间字符串。
  const lastUpdated = documentStats.lastUpdated ? new Date(documentStats.lastUpdated).toISOString() : null;
  return { documents: documentStats.ready, sources: sourceStats.total, processingTasks: taskStats.active, lastUpdated };
}

// ---- 文档与切片 ----

// 列表不读取正文、原始内容与解析结果等大字段。
const { content: _content, rawHtml: _rawHtml, rawJson: _rawJson, markdown: _markdown, metadata: _metadata, ...documentColumns } = getTableColumns(documents);
const summaryColumns = {
  ...documentColumns,
  chunkCount: sql<number>`(SELECT count(*)::int FROM ${documentChunks} WHERE ${documentChunks.documentId} = ${outer("documents", "id")})`,
};

type SummaryRow = Omit<typeof documents.$inferSelect, "content" | "rawHtml" | "rawJson" | "markdown" | "metadata"> & { chunkCount: number };
const toSummary = (row: SummaryRow): DocumentSummary => compact<DocumentSummary>({
  id: row.id, sourceId: row.sourceId, title: row.title, url: row.url, externalId: row.externalId, author: row.author, category: row.category,
  tags: row.tags, publishedAt: iso(row.publishedAt) ?? null, parserVersion: row.parserVersion, status: row.status,
  processingStatus: row.processingStatus, processingError: row.processingError,
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

export async function getDocument(id: string, db: Executor = getDb()): Promise<DocumentRecord | null> {
  const [row] = await db.select({ ...summaryColumns, content: documents.content, rawHtml: documents.rawHtml, markdown: documents.markdown, metadata: documents.metadata })
    .from(documents).where(eq(documents.id, id));
  if (!row) return null;
  return compact<DocumentRecord>({
    ...toSummary(row), content: row.content, markdown: row.markdown, rawHtml: row.rawHtml, metadata: row.metadata, chunks: await listDocumentChunks(id, db),
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
  const [row] = await tx.select({ id: documents.id, content: documents.content, processingStatus: documents.processingStatus, processingVersion: documents.processingVersion })
    .from(documents).where(eq(documents.id, id)).for("update");
  return row ?? null;
}

/** 读取重新清洗切片所需的原始内容；调用前应先用 lockDocument 锁定。 */
export async function getProcessingInput(tx: Executor, id: string) {
  const [row] = await tx.select({ title: documents.title, content: documents.content, rawJson: documents.rawJson }).from(documents).where(eq(documents.id, id));
  return row ? { title: row.title, content: row.content, rawJson: row.rawJson as ArticleDetail | null } : null;
}

/** 文章级向量化输入（标题 + 摘要）；没有摘要的文档返回 null。 */
export async function getSummaryInput(id: string, db: Executor = getDb()): Promise<string | null> {
  const [row] = await db.select({ title: documents.title, summary: sql<string | null>`${documents.metadata}->>'summary'` }).from(documents).where(eq(documents.id, id));
  return row ? summaryEmbeddingInput(row.title, row.summary) : null;
}

/** 文章 API 来源已入库的文章：articleKey → 来源 updateTime（毫秒），用于增量同步。 */
export async function listArticleVersions(sourceId: string, db: Executor = getDb()): Promise<Map<string, number | null>> {
  const rows = await db.select({ externalId: documents.externalId, sourceUpdatedAt: documents.sourceUpdatedAt })
    .from(documents).where(and(eq(documents.sourceId, sourceId), isNotNull(documents.externalId)));
  return new Map(rows.map((row) => [row.externalId!, row.sourceUpdatedAt?.getTime() ?? null]));
}

export interface UpsertDocumentInput {
  sourceId: string;
  url: string;
  title: string;
  content: string;
  rawHtml?: string;
  externalId?: string;
  rawJson?: ArticleDetail;
  sourceUpdatedAt?: Date | null;
  status: DocumentStatus;
}

export async function upsertDocument(tx: Executor, input: UpsertDocumentInput): Promise<string> {
  const values = {
    title: input.title, content: input.content, rawHtml: input.rawHtml ?? null, externalId: input.externalId ?? null, rawJson: input.rawJson ?? null,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null, status: input.status,
  };
  const [row] = await tx.insert(documents)
    .values({ id: randomUUID(), sourceId: input.sourceId, url: input.url, ...values })
    .onConflictDoUpdate({ target: [documents.sourceId, documents.url], set: { ...values, updatedAt: sql`now()` } })
    .returning({ id: documents.id });
  return row.id;
}

// 文章级向量的模型与维度沿用文档的向量信息，因此随之清除；切片向量自带模型与维度，向量化失败时保留。
const resetEmbedding = { embeddingProviderId: null, embeddingModel: null, embeddingDimensions: null, embeddingChunkCount: 0, summaryEmbedding: null };

/** 清洗结果：正文必填；文章来源同时更新解析出的字段。 */
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
  metadata?: ArticleMetadata | null;
}

/** 替换正文与全部切片；旧切片的向量随之删除，向量状态重置为待向量化。 */
export async function replaceDocumentChunks(tx: Executor, documentId: string, update: DocumentContentUpdate, chunks: DocumentChunkRecord[]): Promise<void> {
  await tx.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
  await tx.update(documents).set({
    ...update, ...(update.metadata !== undefined ? { metadataSearchVector: metadataSearchVector(update.metadata) } : {}), processingStatus: "chunked", processingError: null, processingVersion: sql`${documents.processingVersion} + 1`,
    embeddingStatus: "pending", ...resetEmbedding, embeddingError: null, embeddingUpdatedAt: null, updatedAt: sql`now()`,
  }).where(eq(documents.id, documentId));
  if (!chunks.length) return;
  await tx.insert(documentChunks).values(chunks.map((chunk) => ({
    id: chunk.id, documentId, chunkIndex: chunk.index, content: chunk.content, tokenEstimate: chunk.tokenEstimate,
    context: chunk.context ?? "", sectionPath: chunk.sectionPath ?? [], contentType: chunk.contentType ?? "text", searchVector: searchVector(embeddingInput(chunk)),
  })));
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

/** 按当前规则重新生成一批文档的元数据检索词项，用法同 reindexChunkSearchTerms；没有元数据的文档（网页）跳过。 */
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

function validateVectors(vectors: number[][], provider: ModelProviderRecord): void {
  if (!provider.id.trim() || !provider.embeddingModel.trim()) throw new Error("Vector provider ID and embedding model are required.");
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => Number.isFinite(value))) throw new Error("Vectors must contain finite numeric values.");
    if (!vector.some((value) => value !== 0)) throw new Error("Vectors must not be zero vectors.");
    if (vector.length !== vectors[0].length) throw new Error("All vectors for one document must have the same dimensions.");
  }
}

/** 在调用方事务内写入整篇文档的切片向量与文章级向量（没有摘要时为 null），并把文档向量状态置为 ready。 */
export async function saveDocumentEmbeddings(
  tx: Executor, documentId: string, chunks: DocumentChunkRecord[], vectors: number[][], provider: ModelProviderRecord, summaryVector: number[] | null = null,
): Promise<void> {
  if (chunks.length !== vectors.length) throw new Error("The number of chunks and vectors must match.");
  // 文章级向量与切片向量必须同维度（共用文档的模型与维度信息）。
  validateVectors(summaryVector ? [...vectors, summaryVector] : vectors, provider);
  if (!chunks.length) throw new Error("Document must have chunks before embedding");
  const model = provider.embeddingModel.trim();
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
 * 升级前已向量化、缺少文章级向量的文档，按 ID 分批返回（只含当前模型的 ready 文档且有摘要），
 * 供 Worker 回填；没有更多文档时 cursor 为 null。
 */
export async function listMissingSummaryEmbeddings(afterId: string, batchSize: number, model: string, db: Executor = getDb()) {
  const rows = await db.select({ id: documents.id, version: documents.processingVersion, title: documents.title, summary: sql<string | null>`${documents.metadata}->>'summary'` })
    .from(documents)
    .where(and(sql`${documents.id} > ${afterId}`, eq(documents.embeddingStatus, "ready"), eq(documents.embeddingModel, model), isNull(documents.summaryEmbedding),
      sql`btrim(coalesce(${documents.metadata}->>'summary', '')) <> ''`))
    .orderBy(asc(documents.id)).limit(batchSize);
  return {
    items: rows.map((row) => ({ id: row.id, version: row.version, input: summaryEmbeddingInput(row.title, row.summary)! })),
    cursor: rows.at(-1)?.id ?? null,
  };
}

/** 回填文章级向量：只在文档仍为同一切片版本、同一模型与维度的 ready 状态时写入，避免覆盖并发的重新处理或向量化。 */
export async function saveSummaryEmbedding(id: string, version: number, vector: number[], model: string, db: Executor = getDb()): Promise<boolean> {
  if (!vector.length || !vector.every((value) => Number.isFinite(value)) || !vector.some((value) => value !== 0)) throw new Error("Invalid summary vector");
  const updated = await db.update(documents).set({ summaryEmbedding: vector })
    .where(and(eq(documents.id, id), eq(documents.processingVersion, version), eq(documents.embeddingStatus, "ready"), eq(documents.embeddingModel, model),
      eq(documents.embeddingDimensions, vector.length), isNull(documents.summaryEmbedding)))
    .returning({ id: documents.id });
  return updated.length > 0;
}

export async function deleteDocument(id: string, db: Executor = getDb()): Promise<boolean> {
  return (await db.delete(documents).where(eq(documents.id, id)).returning({ id: documents.id })).length > 0;
}

// ---- 检索 ----

const chunkHitColumns = {
  chunkId: documentChunks.id, documentId: documentChunks.documentId, title: documents.title, url: documents.url,
  repostSource: sql<string | null>`${documents.metadata}->'sourceMeta'->>'repostSource'`,
  content: documentChunks.content, context: documentChunks.context, sectionPath: documentChunks.sectionPath, contentType: documentChunks.contentType,
};

const toChunkHit = ({ repostSource, score, ...row }: Omit<ChunkHit, "repostSource" | "score"> & { repostSource: string | null; score: number | string }): ChunkHit =>
  ({ ...row, score: Number(score), ...(repostSource ? { repostSource } : {}) });

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

  const searchMetadata = sql<SearchableMetadata | null>`jsonb_build_object('sourceMeta', jsonb_build_object('keywords', ${documents.metadata}->'sourceMeta'->'keywords'), 'projectMeta', ${documents.metadata}->'projectMeta')`;
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

/** 向量召回：同模型/维度的 ready 文档，常用维度走 HNSW，过滤后不足时精确回退。得分为余弦相似度。 */
export async function vectorSearchChunks(vector: number[], model: string, limit: number, db: Executor = getDb(), filters: RetrievalFilters = {}): Promise<ChunkHit[]> {
  if (!vector.length || vector.length > 16000 || vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0)) throw new Error("Invalid query vector");
  const dimensions = vector.length;
  const indexed = HNSW_DIMENSIONS.some((size) => size === dimensions);
  const expression = indexed ? sql`${documentChunks.embedding}::vector(${sql.raw(String(dimensions))})` : sql`${documentChunks.embedding}`;
  const queryVector = `[${vector.join(",")}]`;
  const distance = sql`${expression} <=> ${queryVector}::vector`;
  // Literal dimension matches the partial-index predicate, including generic prepared plans.
  const where = and(documentFilter(filters), eq(documentChunks.model, model), sql`${documentChunks.dimensions} = ${sql.raw(String(dimensions))}`, isNotNull(documentChunks.embedding));
  const hits = await db.select({ ...chunkHitColumns, score: sql<number>`1 - (${distance})` }).from(documentChunks).innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .where(where)
    .orderBy(distance).limit(limit);
  // ANN post-filtering (including model/status) can underfill. An exact filtered fallback
  // preserves eligible results without requiring pgvector 0.8 iterative-scan settings.
  if (indexed && hits.length < limit) {
    const { rows } = await db.execute<Omit<ChunkHit, "repostSource"> & { repostSource: string | null } & Record<string, unknown>>(sql`
      WITH eligible AS MATERIALIZED (
        SELECT ${documentChunks.id} AS "chunkId", ${documentChunks.documentId} AS "documentId", ${documents.title} AS title,
          ${documents.url} AS url, ${documents.metadata}->'sourceMeta'->>'repostSource' AS "repostSource",
          ${documentChunks.content} AS content, ${documentChunks.context} AS context, ${documentChunks.sectionPath} AS "sectionPath",
          ${documentChunks.contentType} AS "contentType", ${documentChunks.embedding} AS embedding
        FROM ${documentChunks} INNER JOIN ${documents} ON ${documents.id} = ${documentChunks.documentId} WHERE ${where}
      ) SELECT "chunkId", "documentId", title, url, "repostSource", content, context, "sectionPath", "contentType",
        1 - (embedding <=> ${queryVector}::vector) AS score FROM eligible
      ORDER BY embedding <=> ${queryVector}::vector, "chunkId" LIMIT ${limit}`);
    return rows.map(toChunkHit);
  }
  return hits.map(toChunkHit);
}

/**
 * 摘要召回：先按文章级向量（标题 + 摘要）召回同模型/维度的 ready 文档，再用同一查询向量定位每篇文章内最相关的切片。
 * 每篇返回一个切片，得分为摘要的余弦相似度，按文章排序。常用维度走 HNSW，过滤后不足时精确回退。
 */
export async function summarySearchChunks(vector: number[], model: string, limit: number, db: Executor = getDb(), filters: RetrievalFilters = {}): Promise<ChunkHit[]> {
  if (!vector.length || vector.length > 16000 || vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0)) throw new Error("Invalid query vector");
  const dimensions = vector.length;
  const indexed = HNSW_DIMENSIONS.some((size) => size === dimensions);
  const expression = indexed ? sql`${documents.summaryEmbedding}::vector(${sql.raw(String(dimensions))})` : sql`${documents.summaryEmbedding}`;
  const queryVector = `[${vector.join(",")}]`;
  const distance = sql`${expression} <=> ${queryVector}::vector`;
  const where = and(documentFilter(filters), eq(documents.embeddingModel, model), sql`${documents.embeddingDimensions} = ${sql.raw(String(dimensions))}`, isNotNull(documents.summaryEmbedding));
  let matched = await db.select({ id: documents.id, score: sql<number>`1 - (${distance})` }).from(documents).where(where).orderBy(distance, asc(documents.id)).limit(limit);
  if (indexed && matched.length < limit) {
    ({ rows: matched } = await db.execute<{ id: string; score: number }>(sql`
      WITH eligible AS MATERIALIZED (SELECT ${documents.id} AS id, ${documents.summaryEmbedding} AS embedding FROM ${documents} WHERE ${where})
      SELECT id, 1 - (embedding <=> ${queryVector}::vector) AS score FROM eligible ORDER BY embedding <=> ${queryVector}::vector, id LIMIT ${limit}`));
  }
  if (!matched.length) return [];

  const chunkDistance = sql`${documentChunks.embedding} <=> ${queryVector}::vector`;
  const chunks = await db.selectDistinctOn([documentChunks.documentId], chunkHitColumns).from(documentChunks).innerJoin(documents, eq(documents.id, documentChunks.documentId))
    .where(and(inArray(documentChunks.documentId, matched.map((row) => row.id)), eq(documentChunks.model, model), sql`${documentChunks.dimensions} = ${sql.raw(String(dimensions))}`, isNotNull(documentChunks.embedding)))
    .orderBy(documentChunks.documentId, chunkDistance, asc(documentChunks.chunkIndex));
  const byDocument = new Map(chunks.map((chunk) => [chunk.documentId, chunk]));
  return matched.flatMap(({ id, score }) => {
    const chunk = byDocument.get(id);
    return chunk ? [toChunkHit({ ...chunk, score })] : [];
  });
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

const toModelProvider = (row: typeof modelProviders.$inferSelect): ModelProviderRecord => ({ ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! });

export async function listModelProviders(db: Executor = getDb()): Promise<ModelProviderRecord[]> {
  return (await db.select().from(modelProviders).orderBy(desc(modelProviders.createdAt))).map(toModelProvider);
}

const modelProviderValues = (input: SaveModelProviderRequest) => ({
  name: input.name, provider: input.provider, baseUrl: input.baseUrl, chatModel: input.chatModel, embeddingModel: input.embeddingModel,
  rerankModel: input.rerankModel, temperature: input.temperature, maxTokens: input.maxTokens, credentialEnv: input.credentialEnv, enabled: input.enabled, isDefault: input.isDefault,
});

export async function createModelProvider(input: SaveModelProviderRequest): Promise<ModelProviderRecord> {
  return withTransaction(async (tx) => {
    if (input.isDefault) await tx.update(modelProviders).set({ isDefault: false }).where(eq(modelProviders.isDefault, true));
    const [row] = await tx.insert(modelProviders).values({ id: randomUUID(), ...modelProviderValues(input) }).returning();
    return toModelProvider(row);
  });
}

export async function updateModelProvider(id: string, input: SaveModelProviderRequest): Promise<ModelProviderRecord | null> {
  return withTransaction(async (tx) => {
    if (input.isDefault) await tx.update(modelProviders).set({ isDefault: false }).where(and(eq(modelProviders.isDefault, true), ne(modelProviders.id, id)));
    const [row] = await tx.update(modelProviders).set({ ...modelProviderValues(input), updatedAt: sql`now()` }).where(eq(modelProviders.id, id)).returning();
    return row ? toModelProvider(row) : null;
  });
}

export async function deleteModelProvider(id: string, db: Executor = getDb()): Promise<boolean> {
  return (await db.delete(modelProviders).where(eq(modelProviders.id, id)).returning({ id: modelProviders.id })).length > 0;
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

const toChatSession = (row: typeof chatSessions.$inferSelect & { messageCount: number }): ChatSessionRecord => compact<ChatSessionRecord>({
  ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
});

export async function createChatSession(input: { title?: string; knowledgeBaseId?: string }, db: Executor = getDb()): Promise<ChatSessionRecord> {
  const id = randomUUID();
  await db.insert(chatSessions).values({ id, title: sessionTitle(input.title ?? ""), knowledgeBaseId: input.knowledgeBaseId ?? null });
  return (await getChatSession(id, db))!;
}

export async function getChatSession(id: string, db: Executor = getDb()): Promise<ChatSessionRecord | null> {
  const [row] = await db.select(sessionColumns).from(chatSessions).where(eq(chatSessions.id, id));
  return row ? toChatSession(row) : null;
}

export async function listChatSessions(filter: { page: number; pageSize: number }, db: Executor = getDb()): Promise<ChatSessionListResponse> {
  const { limit, offset } = paging(filter.page, filter.pageSize);
  const [rows, [{ total }]] = await Promise.all([
    db.select(sessionColumns).from(chatSessions).orderBy(desc(chatSessions.updatedAt), asc(chatSessions.id)).limit(limit).offset(offset),
    db.select({ total: count() }).from(chatSessions),
  ]);
  return { sessions: rows.map(toChatSession), total };
}

export async function deleteChatSession(id: string, db: Executor = getDb()): Promise<boolean> {
  return (await db.delete(chatSessions).where(eq(chatSessions.id, id)).returning({ id: chatSessions.id })).length > 0;
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
};

type ChatLogRow = typeof chatMessages.$inferSelect & { sources: ChatLogRecord["sources"]; chunks: ChatLogRecord["chunks"] };
const toChatLog = ({ rating, ...row }: ChatLogRow): ChatLogRecord => ({
  ...compact<Omit<ChatLogRecord, "rating">>({ ...row, supersededAt: iso(row.supersededAt), createdAt: iso(row.createdAt)! }), rating,
});

type NewChatMessage = Omit<ChatLogRecord, "createdAt" | "rating" | "answerMode" | "chunks" | "supersededAt"> & {
  answerMode?: ChatLogRecord["answerMode"]; chunks?: ChatRetrievedChunk[]; createdAt?: string; rating?: ChatFeedbackRating | null;
  /** 重新生成时被替换的消息；必须是同一会话中仍有效的消息。 */
  supersedes?: string;
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
    if (log.sessionId) {
      const updated = await tx.update(chatSessions)
        .set({ updatedAt: sql`now()`, title: sql`CASE WHEN ${chatSessions.title} = '' THEN ${sessionTitle(log.question)} ELSE ${chatSessions.title} END` })
        .where(eq(chatSessions.id, log.sessionId)).returning({ id: chatSessions.id });
      if (!updated.length) throw new ChatConflictError("The chat session has been deleted.");
    }
    await tx.insert(chatMessages).values({
      id: log.id, sessionId: log.sessionId ?? null, question: log.question, answer: log.answer, answerMode: log.answerMode ?? "extractive", knowledgeBaseId: log.knowledgeBaseId ?? null, model: log.model ?? null,
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

/** 会话中仍有效的问答，按时间正序。 */
export async function listSessionMessages(sessionId: string, db: Executor = getDb()): Promise<ChatSessionMessage[]> {
  const rows = await db.select({
    id: chatMessages.id, question: chatMessages.question, answer: chatMessages.answer, answerMode: chatMessages.answerMode, rating: chatMessages.rating,
    createdAt: chatMessages.createdAt, sources: messageSourcesColumn,
  }).from(chatMessages).where(and(eq(chatMessages.sessionId, sessionId), isNull(chatMessages.supersededAt))).orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt)! }));
}

export async function rateChatMessage(id: string, rating: ChatFeedbackRating, db: Executor = getDb()): Promise<boolean> {
  return (await db.update(chatMessages).set({ rating }).where(eq(chatMessages.id, id)).returning({ id: chatMessages.id })).length > 0;
}
