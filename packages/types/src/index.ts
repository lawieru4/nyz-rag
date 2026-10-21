export interface ApiHealth {
  status: "ok";
  service: "nyz-rag-api";
  timestamp: string;
}

export interface ChatRequest {
  question: string;
  conversationId?: string;
}

export interface ChatSuccessResponse {
  messageId: string;
  answer: string;
  sources: Array<{ documentId: string; title: string; url: string }>;
}

export interface ChatErrorResponse {
  error: string;
}

export type ChatResponse = ChatSuccessResponse | ChatErrorResponse;

export type DocumentStatus = "pending" | "processing" | "ready" | "failed";
export type EmbeddingStatus = "pending" | "queued" | "processing" | "ready" | "failed";

export interface DocumentEmbeddingRecord {
  status: EmbeddingStatus;
  providerId?: string;
  model?: string;
  dimensions?: number;
  chunkCount: number;
  updatedAt?: string;
  error?: string;
}

export type DocumentProcessingStatus = "pending" | "cleaning" | "chunked" | "failed";

export interface DocumentSummary {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  /** 来源系统中的标识，例如 nyzdata 的 articleKey；网页文档没有。 */
  externalId?: string;
  author?: string;
  category?: string;
  tags: string[];
  publishedAt?: string;
  parserVersion?: number;
  status: DocumentStatus;
  processingStatus: DocumentProcessingStatus;
  processingError?: string;
  embedding: DocumentEmbeddingRecord;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRecord extends DocumentSummary {
  /** 参与检索的正文；文章来源不含文首元信息、相关阅读、本文链接与延伸思考。 */
  content: string;
  /** 文章来源的完整 Markdown（含全部章节）。 */
  markdown?: string;
  rawHtml?: string;
  metadata?: ArticleMetadata;
  chunks: DocumentChunkRecord[];
}

export interface DocumentChunkRecord {
  id: string;
  index: number;
  content: string;
  tokenEstimate: number;
  /** 向量化时拼接在正文前的上下文（文章标题、章节、关键词）。 */
  context?: string;
  sectionPath?: string[];
  contentType?: "text" | "table";
}

/** 文首元信息块：生成者、原始转载源、关键词与场景（[[双链]]）。 */
export interface ArticleSourceMeta {
  generator: string | null;
  repostSource: string | null;
  keywords: string[];
  scenarios: string[];
}

export interface ArticleImage {
  index: number;
  src: string;
  alt: string | null;
  title: string | null;
  caption: string | null;
  sectionPath: string[];
  nodeIndex: number;
}

export interface ArticleMedia {
  index: number;
  url: string;
  fileType: string | null;
  title: string | null;
  sectionPath: string[];
  nodeIndex: number;
}

export interface ArticleAttachment {
  originalName: string | null;
  storageKey: string | null;
  canDownload: boolean;
}

/** 文章解析出的结构化信息，不参与切片。 */
export interface ArticleMetadata {
  summary: string | null;
  cover: string | null;
  doi: string | null;
  sourceMeta: ArticleSourceMeta | null;
  relatedArticleKeys: string[];
  /** 「延伸思考」中的编辑提问，可用作推荐追问。 */
  followUpQuestions: string[];
  attachments: ArticleAttachment[];
  images: ArticleImage[];
  media: ArticleMedia[];
  isVIP: boolean;
  original: boolean;
  unknownNodeTypes: string[];
  demotedHeadings: number;
}

export interface DataSourceRecord {
  id: string;
  name: string;
  url: string;
  kind: "文章 API" | "网页站点";
  frequency: string;
  status: "运行中" | "已暂停";
  documentCount: number;
  updatedAt: string | null;
}

export interface CrawlTaskRecord {
  id: string;
  sourceId: string;
  sourceName: string;
  status: "等待中" | "运行中" | "已完成" | "失败";
  progress: number;
  createdAt: string;
  error?: string;
}

/** 文章 API 数据源的同步进度，保存在数据源上。 */
export interface ArticleSourceSyncState {
  /** 首次全量回填尚未完成时，下次从该页继续。 */
  backfillPage?: number;
  backfillDone?: boolean;
  /** 上次同步失败、下次优先重试的文章。 */
  retryKeys?: string[];
}

export interface KnowledgeStats {
  documents: number;
  sources: number;
  processingTasks: number;
  lastUpdated: string | null;
}

export interface KnowledgeOverview {
  sources: DataSourceRecord[];
  tasks: CrawlTaskRecord[];
  stats: KnowledgeStats;
}

export interface CreateSourceRequest {
  name: string;
  url: string;
  kind: DataSourceRecord["kind"];
  frequency: string;
}

export interface UpdateSourceStatusRequest {
  status: DataSourceRecord["status"];
}

export interface SearchResult {
  documentId: string;
  title: string;
  url: string;
  excerpt: string;
  score: number;
}

export interface DocumentListResponse {
  documents: DocumentSummary[];
  total: number;
}

export interface KnowledgeBaseRecord {
  id: string;
  name: string;
  description: string;
  topK: number;
  similarityThreshold: number;
  rerankEnabled: boolean;
  maxContextLength: number;
  prompt: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export type SaveKnowledgeBaseRequest = Omit<KnowledgeBaseRecord, "id" | "createdAt" | "updatedAt">;

export type ChatFeedbackRating = "positive" | "negative";

export interface ChatLogRecord {
  id: string;
  question: string;
  answer: string;
  sources: ChatSuccessResponse["sources"];
  rating: ChatFeedbackRating | null;
  createdAt: string;
}

export interface ChatLogListResponse {
  logs: ChatLogRecord[];
  total: number;
}

export interface ChatFeedbackRequest {
  rating: ChatFeedbackRating;
}

export interface ModelProviderRecord {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  rerankModel: string;
  credentialEnv: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SaveModelProviderRequest = Omit<ModelProviderRecord, "id" | "createdAt" | "updatedAt">;
