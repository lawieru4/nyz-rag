export interface AdminLoginRequest {
  username: string;
  password: string;
}

export interface AdminSession {
  username: string;
  expiresAt: string;
  admin: AdminAccount;
  /** 当前生效的权限：超级管理员为全部；角色停用或未分配角色时为空。 */
  permissions: AdminPermission[];
}

export interface AdminAccount {
  id: string;
  email: string;
  nickname: string;
  isSuper: boolean;
  disabled: boolean;
  /** 超级管理员拥有全部权限，不分配角色。 */
  roleId: string | null;
  roleName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAdminRequest {
  email: string;
  nickname: string;
  password: string;
  roleId?: string | null;
}

/** 停用/启用账号或更换角色，至少提供一项。 */
export interface UpdateAdminRequest {
  disabled?: boolean;
  roleId?: string | null;
}

/** 管理端权限：模块 × 查看/管理，管理包含查看。操作日志只读。 */
export type AdminPermissionModule = "sources" | "documents" | "knowledge-bases" | "chat-logs" | "users" | "models" | "audit-logs";
type ViewOnlyModule = "audit-logs";
export type AdminPermission = `${Exclude<AdminPermissionModule, ViewOnlyModule>}:${"view" | "manage"}` | `${ViewOnlyModule}:view`;

/** 管理端操作日志的结果：成功、被拒绝（未登录或无权限）、失败（其他错误）。 */
export type AdminAuditResult = "success" | "denied" | "failed";

/** 管理端操作日志：写操作与被拒绝的访问各一条，不含请求体与密钥。 */
export interface AdminAuditLogRecord {
  id: string;
  /** 操作者；登录失败时为空。 */
  adminId: string | null;
  adminEmail: string | null;
  adminNickname: string | null;
  method: string;
  /** 路由模式，如 /api/admin/roles/:id。 */
  route: string;
  /** 路径中的资源 ID（id 或 capability）。 */
  resourceId: string | null;
  statusCode: number;
  result: AdminAuditResult;
  requestId: string;
  ip: string;
  createdAt: string;
}

export interface AdminAuditLogListResponse {
  logs: AdminAuditLogRecord[];
  total: number;
}

export interface AdminRole {
  id: string;
  name: string;
  description: string;
  permissions: AdminPermission[];
  disabled: boolean;
  /** 使用该角色的管理员数量；有管理员使用时不能删除。 */
  adminCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveAdminRoleRequest {
  name: string;
  description: string;
  permissions: AdminPermission[];
}

/** 编辑角色或停用/启用，至少提供一项。 */
export type UpdateAdminRoleRequest = Partial<SaveAdminRoleRequest> & { disabled?: boolean };

export interface UpdateAdminProfileRequest {
  email: string;
  nickname: string;
}

export interface ChangeAdminPasswordRequest {
  currentPassword: string;
  newPassword: string;
}

/** 用户端账号（邮箱注册）。未登录访客由浏览器 Cookie 识别，没有账号记录。 */
export interface UserAccount {
  id: string;
  email: string;
  createdAt: string;
}

/** 当前浏览器的身份：已登录时为账号，否则为匿名访客（user 为 null）。 */
export interface UserSessionResponse {
  user: UserAccount | null;
}

/** 发送注册或重置密码的邮件验证码。 */
export interface EmailCodeRequest {
  email: string;
}

export interface RegisterRequest {
  email: string;
  code: string;
  password: string;
}

export interface UserLoginRequest {
  email: string;
  password: string;
}

export interface ResetPasswordRequest {
  email: string;
  code: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  password: string;
}

export interface AdminUserRecord {
  id: string;
  email: string;
  disabled: boolean;
  sessionCount: number;
  messageCount: number;
  createdAt: string;
  lastLoginAt?: string;
}

export interface AdminUserListResponse {
  users: AdminUserRecord[];
  total: number;
}

export interface UpdateUserRequest {
  disabled: boolean;
}

export interface ApiHealth {
  status: "ok";
  service: "nyz-rag-api";
  timestamp: string;
}

export interface ChatRequest {
  question: string;
  filters?: RetrievalFilters;
  /** 使用的知识库配置；省略时使用最近创建的知识库，没有知识库时使用默认参数。 */
  knowledgeBaseId?: string;
}

/** 回答引用的文章，顺序即回答中的引用编号 [1]、[2]…… */
export interface ChatSource {
  documentId: string;
  title: string;
  url: string;
  /** 文章的原始转载源。 */
  repostSource?: string;
  /** 本轮送入模型的该文章片段摘录，按相关度排列；用户端问答返回，管理端问答记录不含。 */
  excerpts?: ChatSourceExcerpt[];
}

export interface ChatSourceExcerpt {
  sectionPath: string[];
  text: string;
}

/** generated：由 Chat 模型生成；extractive：未配置或调用失败时直接摘录原文片段。 */
export type ChatAnswerMode = "generated" | "extractive";

export interface ChatSuccessResponse {
  messageId: string;
  answer: string;
  answerMode: ChatAnswerMode;
  sources: ChatSource[];
}

export interface ChatErrorResponse {
  error: string;
}

export type ChatResponse = ChatSuccessResponse | ChatErrorResponse;

export interface ChatSessionRecord {
  id: string;
  /** 默认取第一个问题的前 40 字。 */
  title: string;
  /** 会话固定使用的知识库；省略时每次使用最近创建的知识库。 */
  knowledgeBaseId?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChatSessionRequest {
  title?: string;
  knowledgeBaseId?: string;
}

export interface ChatSessionListResponse {
  sessions: ChatSessionRecord[];
  total: number;
}

/** 会话中的一轮问答（用户端视图，不含召回片段与耗时）。 */
export interface ChatSessionMessage {
  id: string;
  question: string;
  answer: string;
  answerMode: ChatAnswerMode;
  sources: ChatSource[];
  rating: ChatFeedbackRating | null;
  feedbackReasons?: ChatFeedbackReason[];
  createdAt: string;
}

export interface ChatSessionMessagesResponse {
  session: ChatSessionRecord;
  messages: ChatSessionMessage[];
}

/** 流式问答请求：提出新问题，或重新生成会话中最后一轮回答（regenerate 为该轮的 messageId）。 */
export interface ChatStreamRequest {
  question?: string;
  regenerate?: string;
  filters?: RetrievalFilters;
}

/** Exact OR within each list, AND across fields. Dates are inclusive UTC calendar days. */
export interface RetrievalFilters {
  publishedFrom?: string;
  publishedTo?: string;
  categories?: string[];
  tags?: string[];
  scenarios?: string[];
  sourceId?: string;
}

export interface SearchRequest {
  query: string;
  filters?: RetrievalFilters;
}

/**
 * SSE 事件：检索完成后先发送全部 source（citation 即回答中的编号），模型生成时逐段发送 token，
 * 最后发送 done；done.answer 为最终回答，模型中途失败降级为原文摘录时与已发送的 token 不同，以 done 为准。
 * 保存前出错时发送 error，不再发送 done。
 */
export type ChatStreamEvent =
  | { event: "source"; data: ChatSource & { citation: number } }
  | { event: "token"; data: { content: string } }
  | { event: "done"; data: ChatSessionMessage }
  | { event: "error"; data: { error: string } };

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

/** duplicate：正文与已有文档相同，保留记录但不切片、不向量化，见 DocumentSummary.duplicateOf。 */
export type DocumentProcessingStatus = "pending" | "cleaning" | "chunked" | "duplicate" | "failed";

export interface DocumentSummary {
  id: string;
  sourceId: string;
  title: string;
  url: string;
  /** 规范地址，与 url 相同，同一来源内唯一。 */
  canonicalUrl: string;
  /** 来源系统中的标识，即 nyzdata 的 articleKey。 */
  externalId: string;
  author?: string;
  category?: string;
  tags: string[];
  publishedAt?: string;
  parserVersion?: number;
  status: DocumentStatus;
  processingStatus: DocumentProcessingStatus;
  processingError?: string;
  /** 正文相同的主文档 ID；重复文档不参与检索。主文档被删除后为空，需重新处理。 */
  duplicateOf?: string;
  embedding: DocumentEmbeddingRecord;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 重复关系中另一篇文档的简要信息。 */
export interface DocumentReference {
  id: string;
  sourceId: string;
  title: string;
  url: string;
}

export interface DocumentRecord extends DocumentSummary {
  /** 参与检索的正文，不含文首元信息、相关阅读、本文链接与延伸思考。 */
  content: string;
  /** 完整 Markdown（含全部章节）。 */
  markdown?: string;
  metadata?: ArticleMetadata;
  chunks: DocumentChunkRecord[];
  /** 重复文档所指向的主文档。 */
  primary?: DocumentReference;
  /** 以本文档为主文档的重复文档（同内容的其他来源或地址）。 */
  duplicates?: DocumentReference[];
}

/** Public article view: no raw input, internal processing errors or model configuration. */
export interface DocumentDetail {
  id: string;
  title: string;
  url: string;
  content: string;
  markdown?: string;
  author?: string;
  category?: string;
  tags: string[];
  publishedAt?: string;
  updatedAt: string;
  summary?: string;
  repostSource?: string;
  keywords: string[];
  scenarios: string[];
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

/** 项目导读文首字段，保留原始中英文名称，不推断机构或负责人。 */
export interface ArticleProjectMeta {
  name: string;
  principal: string | null;
  institution: string | null;
  keywords: string[];
}

/** 学术快讯标题（「机构 + 作者 + 期刊：正文标题」）中识别出的期刊与机构；未识别出期刊的标题为 null。 */
export interface ArticleTitleMeta {
  /** 期刊全称（按期刊词典规范化）。 */
  journal: string;
  journalAbbreviation: string | null;
  /** 保留标题中的写法，按出现顺序去重；仅期刊的标题为空数组。 */
  institutions: string[];
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
  /** 旧版本解析结果可能尚未包含此字段。 */
  projectMeta?: ArticleProjectMeta | null;
  /** 旧版本解析结果可能尚未包含此字段。 */
  titleMeta?: ArticleTitleMeta | null;
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
  /** 只支持 nyzdata 文章接口。 */
  kind: "文章 API";
  frequency: string;
  status: "运行中" | "已暂停";
  /** 已入库的文章数（含内容重复的文章）。 */
  documentCount: number;
  /** 最近一次同步时接口返回的文章总数；尚未同步过为 null。 */
  remoteTotal: number | null;
  /** 首次全量回填是否已完成；未完成时下次同步从断点继续。 */
  backfillDone: boolean;
  /** 上次同步失败、等待下次重试的文章数。 */
  failedCount: number;
  updatedAt: string | null;
}

export interface CrawlTaskRecord {
  id: string;
  sourceId: string;
  sourceName: string;
  status: "等待中" | "运行中" | "已完成" | "失败";
  progress: number;
  /** 本次同步已成功处理的文章数。 */
  processedCount: number;
  /** 本次同步失败（下次重试）的文章数。 */
  failedCount: number;
  /** 单次同步最多处理的文章数，Worker 开始执行后才有值。 */
  articleLimit?: number;
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
  /** 最近一次同步时接口返回的文章总数。 */
  remoteTotal?: number;
  /** 最近一次完整遍历列表的完成时间；不是远端删除/撤稿确认。 */
  lastFullInspectionAt?: string;
  /** 全量详情巡检的断点；页内已尝试的文章避免单次上限小于一页时重复刷新而无法前进。 */
  fullInspection?: { page: number; completedKeys: string[] };
}

export interface KnowledgeStats {
  documents: number;
  sources: number;
  processingTasks: number;
  lastUpdated: string | null;
}

/** 后台操作（同步、重新处理、向量化）的积压情况，用于判断 Worker 是否在正常消费。 */
export interface OperationBacklog {
  /** 已到期、等待 Worker 开始执行（含已投递到队列）的操作数。 */
  queued: number;
  running: number;
  /** 等待稍后重试（如向量化临时错误）的操作数。 */
  delayed: number;
  /** 最近 24 小时内失败的操作数。 */
  failedLastDay: number;
  /** 等待最久的操作的到期时间；没有排队的操作时为空。 */
  oldestQueuedAt: string | null;
}

/** Administrative overview returned only by /api/admin/knowledge. */
export interface KnowledgeOverview {
  sources: DataSourceRecord[];
  tasks: CrawlTaskRecord[];
  stats: KnowledgeStats;
  operations: OperationBacklog;
}

export interface CreateSourceRequest {
  name: string;
  url: string;
  kind: DataSourceRecord["kind"];
  frequency: string;
}

/** 管理端可选的同步频率；手动、空值与其他值都不自动同步。 */
export type SourceFrequency = "每小时" | "每 6 小时" | "每天" | "手动";

/** 至少包含一项。 */
export interface UpdateSourceRequest {
  status?: DataSourceRecord["status"];
  frequency?: SourceFrequency;
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
  /** 开启时使用严格引用提示词，并拒收无引用（固定拒答除外）或含越界编号的生成回答。 */
  citationCheck: boolean;
  maxContextLength: number;
  prompt: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export type SaveKnowledgeBaseRequest = Omit<KnowledgeBaseRecord, "id" | "createdAt" | "updatedAt">;

export type ChatFeedbackRating = "positive" | "negative";
export type ChatFeedbackReason = "missing-evidence" | "incorrect-answer" | "citation-mismatch" | "outdated" | "other";
export type ChatTriageStatus = "new" | "investigating" | "resolved" | "dismissed";

/** Independent, manually sanitized annotation; never an automatic replay of a log. */
export interface EvaluationCandidate {
  question: string;
  answer?: string;
  history: Array<{ question: string; answer: string }>;
  filters: RetrievalFilters | null;
  type: "fact" | "mechanism" | "compare" | "metadata" | "term" | "followup" | "unanswerable";
  split: "dev" | "test";
  answerable: boolean;
  labels: Array<{ articleKey: string; relevance: 0 | 1 | 2 | 3; evidence: string[] }>;
}

export interface ChatReviewInput {
  status: ChatTriageStatus;
  reasons: ChatFeedbackReason[];
  notes: string;
  correctedAnswer: string;
  candidate: EvaluationCandidate | null;
}

export interface ChatReviewRecord extends ChatReviewInput {
  revision: number;
  approvedRevision: number | null;
  approvedAt: string | null;
}

/** 送入模型的召回片段及各路得分。 */
export interface ChatRetrievedChunk {
  chunkId: string;
  documentId: string;
  /** 对应回答中的引用编号。 */
  citation: number;
  title: string;
  sectionPath: string[];
  excerpt: string;
  /** 合并（RRF）得分。 */
  score: number;
  vectorScore?: number;
  keywordScore?: number;
  /** 摘要召回：所属文章摘要与问题的余弦相似度。 */
  summaryScore?: number;
  rerankScore?: number;
}

/** 问答归属：注册用户、匿名访客，或用户体系上线前没有归属的历史记录。 */
export type ChatOwnerType = "user" | "visitor" | "none";

export interface ChatLogRecord {
  id: string;
  sessionId?: string;
  ownerType: ChatOwnerType;
  /** ownerType 为 user 时的账号邮箱。 */
  userEmail?: string;
  /** 被“重新生成”替换的时间；替换后不再出现在会话中，但保留在问答记录里。 */
  supersededAt?: string;
  question: string;
  answer: string;
  answerMode: ChatAnswerMode;
  knowledgeBaseId?: string;
  model?: string;
  /** 追问时改写后实际用于检索的问题；未改写时省略。 */
  retrievalQuery?: string;
  /** 检索问题改写耗时（包含在 retrievalMs 中）；未尝试改写时省略。 */
  rewriteMs?: number;
  /** 检索问题改写调用的 Token 用量（不含在 promptTokens / completionTokens 中）。 */
  rewritePromptTokens?: number;
  rewriteCompletionTokens?: number;
  retrievalMs?: number;
  firstTokenMs?: number;
  totalMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  sources: ChatSource[];
  chunks: ChatRetrievedChunk[];
  rating: ChatFeedbackRating | null;
  feedbackReasons?: ChatFeedbackReason[];
  createdAt: string;
}

export interface ChatLogListResponse {
  logs: ChatLogRecord[];
  total: number;
}

export interface ChatFeedbackRequest {
  rating: ChatFeedbackRating | null;
  reasons?: ChatFeedbackReason[];
}

/** 模型供应商只描述连接（地址与密钥），具体使用哪个模型在业务模型配置（ModelSettingRecord）中选择。 */
export interface ModelProviderRecord {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  /** 后备的密钥环境变量名，可为空；后台保存了密钥时优先使用后者。都没有时请求不带认证头（如本地模型）。 */
  credentialEnv: string;
  /** 后台是否保存了加密的 API 密钥；密钥本身从不返回。 */
  hasApiKey: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * credentialEnv 省略时新建为空、更新保持不变。
 * apiKey 非空时保存（加密）新密钥；clearApiKey 为 true 时删除已保存的密钥；都省略时保持不变。
 */
export type SaveModelProviderRequest = Pick<ModelProviderRecord, "name" | "provider" | "baseUrl" | "enabled">
  & Partial<Pick<ModelProviderRecord, "credentialEnv">>
  & { apiKey?: string; clearApiKey?: boolean };

/** 业务模型的用途：问答生成、向量化与检索、重排序、审核（评估集题目审核等离线任务）、检索问题改写（追问时改写为独立问题，未配置时用 Chat 模型）。 */
export type ModelCapability = "chat" | "embedding" | "rerank" | "review" | "rewrite";

/** 某项用途选定的供应商与模型；temperature / maxTokens 只用于 Chat、审核与改写。 */
export interface ModelSettingRecord {
  capability: ModelCapability;
  providerId: string;
  model: string;
  temperature: number;
  maxTokens: number;
  updatedAt: string;
}

/** 各用途当前的模型配置，未配置为 null。 */
export type ModelSettingsResponse = Record<ModelCapability, ModelSettingRecord | null>;

/** temperature 与 maxTokens 省略时新建使用默认值（0.3 / 1024），更新保持不变。 */
export interface SaveModelSettingRequest {
  providerId: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/** 按表单中的地址获取供应商可选模型；密钥依次取 apiKey、已保存供应商（providerId）的密钥、credentialEnv。 */
export interface ListProviderModelsRequest {
  name?: string;
  provider: string;
  baseUrl: string;
  apiKey?: string;
  providerId?: string;
  credentialEnv?: string;
}

export interface ListProviderModelsResponse {
  models: string[];
}

/** 全局密钥设置（如 nyzdata 文章接口 token）的状态；值本身从不返回。 */
export interface SecretSettingStatus {
  configured: boolean;
  updatedAt: string | null;
  /** 服务端是否配置了可用的 NYZ_SECRET_KEY；未配置时无法保存或读取。 */
  encryptionReady: boolean;
}

export interface SaveSecretSettingRequest {
  value: string;
}
