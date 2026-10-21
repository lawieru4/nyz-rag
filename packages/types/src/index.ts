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

export interface DocumentRecord {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  content: string;
  status: DocumentStatus;
  createdAt: string;
  updatedAt: string;
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

export interface KnowledgeStats {
  documents: number;
  sources: number;
  processingTasks: number;
  lastUpdated: string | null;
}

export interface KnowledgeSnapshot {
  sources: DataSourceRecord[];
  documents: DocumentRecord[];
  tasks: CrawlTaskRecord[];
  stats: KnowledgeStats;
}

export interface CreateSourceRequest {
  name: string;
  url: string;
  kind: DataSourceRecord["kind"];
  frequency: string;
}

export interface SearchResult {
  documentId: string;
  title: string;
  url: string;
  excerpt: string;
  score: number;
}

export interface DocumentListResponse {
  documents: DocumentRecord[];
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
