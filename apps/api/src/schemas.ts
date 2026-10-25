/**
 * schemas.ts — Fastify JSON Schema registry for all API routes.
 *
 * Each entry is keyed by `METHOD /path/with/:params` (upper-case method,
 * single space, exact path template matching Fastify route registration).
 *
 * `body` and `querystring` schemas feed Fastify's AJV request validator.
 * `response` schemas feed Fastify's fast-json-stringify response serializer.
 *
 * Design notes:
 *  - `additionalProperties: false` on responses to prevent accidental leaks,
 *    while still preserving every documented field.
 *  - No coercion: expects the app to be created with `ajv: { coerceTypes: false }`.
 *  - Params with `:id` are UUID strings; validated with format:"uuid" so
 *    garbage IDs get a 400 before handlers hit the DB. The public article
 *    detail route is the exception (404 for any unknown ID).
 *  - SSE route (/api/chat/sessions/:id/stream): body schema only — no JSON
 *    response schema because the response is a raw event-stream.
 *  - Pagination querystrings accept string representations of integers
 *    (standard HTTP query string). Coercion is intentionally NOT done here;
 *    common.ts pageParams already handles parseInt.
 */

import { ADMIN_PERMISSIONS } from "@nyz-rag/processing";

// ─── Shared primitives ────────────────────────────────────────────────────────

const uuidParam = { type: "string", format: "uuid" };
// Handlers trim names and URLs, so whitespace-only values must be rejected here.
const nonBlankString = { type: "string", pattern: "\\S" } as const;

const pageQuerystring = {
  type: "object",
  properties: {
    page: { type: "string", pattern: "^[1-9][0-9]*$" },
    pageSize: { type: "string", pattern: "^[1-9][0-9]*$" },
  },
  additionalProperties: false,
} as const;

const errorResponse = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
  additionalProperties: false,
} as const;

// Common error status codes block used across most routes
const errorResponses = {
  "400": errorResponse,
  "401": errorResponse,
  "403": errorResponse,
  "404": errorResponse,
  "409": errorResponse,
  "429": errorResponse,
  "500": errorResponse,
  "503": errorResponse,
} as const;

// ─── Retrieval filter (shared sub-schema) ────────────────────────────────────

const retrievalFiltersSchema = {
  type: "object",
  properties: {
    publishedFrom: { type: "string" },
    publishedTo: { type: "string" },
    categories: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    scenarios: { type: "array", items: { type: "string" } },
    sourceId: { type: "string" },
  },
  additionalProperties: false,
} as const;

// ─── Chat source (shared sub-schema) ─────────────────────────────────────────

const chatSourceSchema = {
  type: "object",
  properties: {
    documentId: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    repostSource: { type: "string" },
    excerpts: {
      type: "array",
      items: {
        type: "object",
        properties: { sectionPath: { type: "array", items: { type: "string" } }, text: { type: "string" } },
        required: ["sectionPath", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["documentId", "title", "url"],
  additionalProperties: false,
} as const;

const sessionFeedbackReasonsSchema = { type: "array", items: { type: "string", enum: ["missing-evidence", "incorrect-answer", "citation-mismatch", "outdated", "other"] } } as const;
const chatSessionMessageSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    question: { type: "string" },
    answer: { type: "string" },
    answerMode: { type: "string", enum: ["generated", "extractive"] },
    sources: { type: "array", items: chatSourceSchema },
    rating: { type: "string", nullable: true },
    feedbackReasons: sessionFeedbackReasonsSchema,
    createdAt: { type: "string" },
  },
  required: ["id", "question", "answer", "answerMode", "sources", "createdAt"],
  additionalProperties: false,
} as const;

const chatSessionRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    knowledgeBaseId: { type: "string" },
    messageCount: { type: "number" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "title", "messageCount", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const;

// ─── Chat routes ─────────────────────────────────────────────────────────────

const chatBodySchema = {
  type: "object",
  properties: {
    question: { type: "string", maxLength: 2000 },
    filters: retrievalFiltersSchema,
    knowledgeBaseId: { type: "string" },
  },
  required: ["question"],
  additionalProperties: false,
} as const;

const chatResponseSchema = {
  "200": {
    type: "object",
    properties: {
      messageId: { type: "string" },
      answer: { type: "string" },
      answerMode: { type: "string", enum: ["generated", "extractive"] },
      sources: { type: "array", items: chatSourceSchema },
    },
    required: ["messageId", "answer", "answerMode", "sources"],
    additionalProperties: false,
  },
  ...errorResponses,
} as const;

// ─── Chat sessions ───────────────────────────────────────────────────────────

const createChatSessionBodySchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    knowledgeBaseId: { type: "string" },
  },
  additionalProperties: false,
} as const;

const chatSessionsListResponseSchema = {
  "200": {
    type: "object",
    properties: {
      sessions: { type: "array", items: chatSessionRecordSchema },
      total: { type: "number" },
    },
    required: ["sessions", "total"],
    additionalProperties: false,
  },
  ...errorResponses,
} as const;

const chatSessionMessagesResponseSchema = {
  "200": {
    type: "object",
    properties: {
      session: chatSessionRecordSchema,
      messages: { type: "array", items: chatSessionMessageSchema },
    },
    required: ["session", "messages"],
    additionalProperties: false,
  },
  ...errorResponses,
} as const;

// ─── SSE stream: body only, no JSON success response schema ──────────────────

const chatStreamBodySchema = {
  type: "object",
  properties: {
    question: { type: "string", maxLength: 2000 },
    regenerate: { type: "string" },
    filters: retrievalFiltersSchema,
  },
  additionalProperties: false,
  // At least one of question or regenerate must be present — enforced in handler.
} as const;

// ─── Chat feedback ───────────────────────────────────────────────────────────

const feedbackReasonsSchema = { type: "array", maxItems: 5, uniqueItems: true, items: { type: "string", enum: ["missing-evidence", "incorrect-answer", "citation-mismatch", "outdated", "other"] } } as const;
const chatFeedbackBodySchema = {
  type: "object",
  properties: {
    rating: { type: "string", nullable: true, enum: ["positive", "negative", null] },
    reasons: feedbackReasonsSchema,
  },
  required: ["rating"],
  additionalProperties: false,
} as const;

// ─── Admin: documents ────────────────────────────────────────────────────────

const embeddingRecordSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["pending", "queued", "processing", "ready", "failed"] },
    providerId: { type: "string" },
    model: { type: "string" },
    dimensions: { type: "number" },
    chunkCount: { type: "number" },
    updatedAt: { type: "string" },
    error: { type: "string" },
  },
  required: ["status", "chunkCount"],
  additionalProperties: false,
} as const;

const documentChunkRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    index: { type: "number" },
    content: { type: "string" },
    tokenEstimate: { type: "number" },
    context: { type: "string" },
    sectionPath: { type: "array", items: { type: "string" } },
    contentType: { type: "string", enum: ["text", "table"] },
  },
  required: ["id", "index", "content", "tokenEstimate"],
  additionalProperties: false,
} as const;

const documentSummarySchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sourceId: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    canonicalUrl: { type: "string" },
    externalId: { type: "string" },
    author: { type: "string" },
    category: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    publishedAt: { type: "string" },
    parserVersion: { type: "number" },
    status: { type: "string", enum: ["pending", "processing", "ready", "failed"] },
    processingStatus: { type: "string", enum: ["pending", "cleaning", "chunked", "duplicate", "failed"] },
    processingError: { type: "string" },
    duplicateOf: { type: "string" },
    embedding: embeddingRecordSchema,
    chunkCount: { type: "number" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "sourceId", "title", "url", "canonicalUrl", "externalId", "tags", "status", "processingStatus", "embedding", "chunkCount", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const;

const articleSourceMetaSchema = {
  type: "object",
  properties: {
    generator: { type: "string", nullable: true },
    repostSource: { type: "string", nullable: true },
    keywords: { type: "array", items: { type: "string" } },
    scenarios: { type: "array", items: { type: "string" } },
  },
  required: ["keywords", "scenarios"],
  additionalProperties: false,
} as const;

const articleImageSchema = {
  type: "object",
  properties: {
    index: { type: "number" },
    src: { type: "string" },
    alt: { type: "string", nullable: true },
    title: { type: "string", nullable: true },
    caption: { type: "string", nullable: true },
    sectionPath: { type: "array", items: { type: "string" } },
    nodeIndex: { type: "number" },
  },
  required: ["index", "src", "sectionPath", "nodeIndex"],
  additionalProperties: false,
} as const;

const articleMediaSchema = {
  type: "object",
  properties: {
    index: { type: "number" },
    url: { type: "string" },
    fileType: { type: "string", nullable: true },
    title: { type: "string", nullable: true },
    sectionPath: { type: "array", items: { type: "string" } },
    nodeIndex: { type: "number" },
  },
  required: ["index", "url", "sectionPath", "nodeIndex"],
  additionalProperties: false,
} as const;

const articleAttachmentSchema = {
  type: "object",
  properties: {
    originalName: { type: "string", nullable: true },
    storageKey: { type: "string", nullable: true },
    canDownload: { type: "boolean" },
  },
  required: ["canDownload"],
  additionalProperties: false,
} as const;

const articleMetadataSchema = {
  type: "object",
  properties: {
    summary: { type: "string", nullable: true },
    cover: { type: "string", nullable: true },
    doi: { type: "string", nullable: true },
    sourceMeta: { ...articleSourceMetaSchema, nullable: true },
    projectMeta: {
      type: "object", nullable: true,
      properties: {
        name: { type: "string" },
        principal: { type: "string", nullable: true },
        institution: { type: "string", nullable: true },
        keywords: { type: "array", items: { type: "string" } },
      },
      required: ["name", "principal", "institution", "keywords"],
      additionalProperties: false,
    },
    titleMeta: {
      type: "object", nullable: true,
      properties: {
        journal: { type: "string" },
        journalAbbreviation: { type: "string", nullable: true },
        institutions: { type: "array", items: { type: "string" } },
      },
      required: ["journal", "journalAbbreviation", "institutions"],
      additionalProperties: false,
    },
    relatedArticleKeys: { type: "array", items: { type: "string" } },
    followUpQuestions: { type: "array", items: { type: "string" } },
    attachments: { type: "array", items: articleAttachmentSchema },
    images: { type: "array", items: articleImageSchema },
    media: { type: "array", items: articleMediaSchema },
    isVIP: { type: "boolean" },
    original: { type: "boolean" },
    unknownNodeTypes: { type: "array", items: { type: "string" } },
    demotedHeadings: { type: "number" },
  },
  required: ["relatedArticleKeys", "followUpQuestions", "attachments", "images", "media", "isVIP", "original", "unknownNodeTypes", "demotedHeadings"],
  additionalProperties: false,
} as const;

const documentReferenceSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sourceId: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
  },
  required: ["id", "sourceId", "title", "url"],
  additionalProperties: false,
} as const;

const documentRecordSchema = {
  type: "object",
  properties: {
    ...documentSummarySchema.properties,
    content: { type: "string" },
    markdown: { type: "string" },
    metadata: articleMetadataSchema,
    chunks: { type: "array", items: documentChunkRecordSchema },
    primary: documentReferenceSchema,
    duplicates: { type: "array", items: documentReferenceSchema },
  },
  required: [...documentSummarySchema.required, "content", "chunks"],
  additionalProperties: false,
} as const;

const adminDocumentsQuerySchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    sourceId: { type: "string" },
    status: { type: "string", enum: ["pending", "processing", "ready", "failed"] },
    page: { type: "string", pattern: "^[1-9][0-9]*$" },
    pageSize: { type: "string", pattern: "^[1-9][0-9]*$" },
  },
  additionalProperties: false,
} as const;

const documentListResponseSchema = {
  "200": {
    type: "object",
    properties: {
      documents: { type: "array", items: documentSummarySchema },
      total: { type: "number" },
    },
    required: ["documents", "total"],
    additionalProperties: false,
  },
  ...errorResponses,
} as const;

const queuedResponseSchema = {
  type: "object",
  properties: {
    status: { type: "string" },
    documentId: { type: "string" },
  },
  required: ["status", "documentId"],
  additionalProperties: false,
} as const;

// ─── Public document detail ───────────────────────────────────────────────────

const documentDetailSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    content: { type: "string" },
    markdown: { type: "string" },
    author: { type: "string" },
    category: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    publishedAt: { type: "string" },
    updatedAt: { type: "string" },
    summary: { type: "string" },
    repostSource: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
    scenarios: { type: "array", items: { type: "string" } },
  },
  required: ["id", "title", "url", "content", "tags", "updatedAt", "keywords", "scenarios"],
  additionalProperties: false,
} as const;

// ─── Knowledge bases ──────────────────────────────────────────────────────────

const knowledgeBaseRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    topK: { type: "number" },
    similarityThreshold: { type: "number" },
    rerankEnabled: { type: "boolean" },
    maxContextLength: { type: "number" },
    prompt: { type: "string" },
    model: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "name", "description", "topK", "similarityThreshold", "rerankEnabled", "maxContextLength", "prompt", "model", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const;

const saveKnowledgeBaseBodySchema = {
  type: "object",
  properties: {
    name: nonBlankString,
    description: { type: "string" },
    topK: { type: "integer", minimum: 1, maximum: 100 },
    similarityThreshold: { type: "number", minimum: 0, maximum: 1 },
    rerankEnabled: { type: "boolean" },
    maxContextLength: { type: "integer", minimum: 256 },
    prompt: { type: "string" },
    model: { type: "string" },
  },
  required: ["name", "topK", "similarityThreshold", "rerankEnabled", "maxContextLength", "prompt", "model"],
  additionalProperties: false,
} as const;

// ─── Model providers ──────────────────────────────────────────────────────────

const modelProviderRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    provider: { type: "string" },
    baseUrl: { type: "string" },
    credentialEnv: { type: "string" },
    hasApiKey: { type: "boolean" },
    enabled: { type: "boolean" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "name", "provider", "baseUrl", "credentialEnv", "hasApiKey", "enabled", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const;

// credentialEnv 可省略（新建为空，更新保持不变）；apiKey 只写不读。
const saveModelProviderBodySchema = {
  type: "object",
  properties: {
    name: nonBlankString,
    provider: nonBlankString,
    baseUrl: { type: "string" },
    credentialEnv: { type: "string", pattern: "^([A-Z][A-Z0-9_]*)?$" },
    apiKey: { type: "string", maxLength: 4096 },
    clearApiKey: { type: "boolean" },
    enabled: { type: "boolean" },
  },
  required: ["name", "provider", "baseUrl", "enabled"],
  additionalProperties: false,
} as const;

const modelCapabilityParams = {
  type: "object",
  properties: { capability: { type: "string", enum: ["chat", "embedding", "rerank", "review"] } },
  required: ["capability"],
  additionalProperties: false,
} as const;

const modelSettingRecordSchema = {
  type: "object",
  properties: {
    capability: { type: "string" },
    providerId: { type: "string" },
    model: { type: "string" },
    temperature: { type: "number" },
    maxTokens: { type: "number" },
    updatedAt: { type: "string" },
  },
  required: ["capability", "providerId", "model", "temperature", "maxTokens", "updatedAt"],
  additionalProperties: false,
} as const;

const modelSettingsResponseSchema = {
  type: "object",
  properties: {
    chat: { ...modelSettingRecordSchema, nullable: true },
    embedding: { ...modelSettingRecordSchema, nullable: true },
    rerank: { ...modelSettingRecordSchema, nullable: true },
    review: { ...modelSettingRecordSchema, nullable: true },
  },
  required: ["chat", "embedding", "rerank", "review"],
  additionalProperties: false,
} as const;

// temperature、maxTokens 可省略（新建取默认值，更新保持不变），只用于 Chat 与审核。
const saveModelSettingBodySchema = {
  type: "object",
  properties: {
    providerId: uuidParam,
    model: { ...nonBlankString, maxLength: 200 },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    maxTokens: { type: "integer", minimum: 1, maximum: 1048576 },
  },
  required: ["providerId", "model"],
  additionalProperties: false,
} as const;

const listProviderModelsBodySchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    provider: nonBlankString,
    baseUrl: { type: "string" },
    apiKey: { type: "string", maxLength: 4096 },
    providerId: uuidParam,
    credentialEnv: { type: "string", pattern: "^([A-Z][A-Z0-9_]*)?$" },
  },
  required: ["provider", "baseUrl"],
  additionalProperties: false,
} as const;

const listProviderModelsResponseSchema = {
  type: "object",
  properties: { models: { type: "array", items: { type: "string" } } },
  required: ["models"],
  additionalProperties: false,
} as const;

// ─── Secret settings ──────────────────────────────────────────────────────────

const secretSettingStatusSchema = {
  type: "object",
  properties: {
    configured: { type: "boolean" },
    updatedAt: { type: "string", nullable: true },
    encryptionReady: { type: "boolean" },
  },
  required: ["configured", "updatedAt", "encryptionReady"],
  additionalProperties: false,
} as const;

const saveSecretSettingBodySchema = {
  type: "object",
  properties: { value: { type: "string", pattern: "^\\S+$", maxLength: 4096 } },
  required: ["value"],
  additionalProperties: false,
} as const;

// ─── Sources ──────────────────────────────────────────────────────────────────

const dataSourceRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    url: { type: "string" },
    kind: { type: "string", enum: ["文章 API"] },
    frequency: { type: "string" },
    status: { type: "string", enum: ["运行中", "已暂停"] },
    documentCount: { type: "number" },
    remoteTotal: { type: "number", nullable: true },
    backfillDone: { type: "boolean" },
    failedCount: { type: "number" },
    updatedAt: { type: "string", nullable: true },
  },
  required: ["id", "name", "url", "kind", "frequency", "status", "documentCount", "remoteTotal", "backfillDone", "failedCount"],
  additionalProperties: false,
} as const;

const createSourceBodySchema = {
  type: "object",
  properties: {
    name: nonBlankString,
    url: nonBlankString,
    kind: { type: "string", enum: ["文章 API"] },
    frequency: { type: "string" },
  },
  required: ["name", "url", "kind"],
  additionalProperties: false,
} as const;

const updateSourceStatusBodySchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["运行中", "已暂停"] },
  },
  required: ["status"],
  additionalProperties: false,
} as const;

// ─── Chat logs ────────────────────────────────────────────────────────────────

const chatLogsQuerySchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    rating: { type: "string", enum: ["rated", "unrated", "positive", "negative"] },
    status: { type: "string", enum: ["new", "investigating", "resolved", "dismissed"] },
    page: { type: "string", pattern: "^[1-9][0-9]*$" },
    pageSize: { type: "string", pattern: "^[1-9][0-9]*$" },
  },
  additionalProperties: false,
} as const;

const chatRetrievedChunkSchema = {
  type: "object",
  properties: {
    chunkId: { type: "string" },
    documentId: { type: "string" },
    citation: { type: "number" },
    title: { type: "string" },
    sectionPath: { type: "array", items: { type: "string" } },
    excerpt: { type: "string" },
    score: { type: "number" },
    vectorScore: { type: "number" },
    keywordScore: { type: "number" },
    summaryScore: { type: "number" },
    rerankScore: { type: "number" },
  },
  required: ["chunkId", "documentId", "citation", "title", "sectionPath", "excerpt", "score"],
  additionalProperties: false,
} as const;

const chatLogRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sessionId: { type: "string" },
    ownerType: { type: "string", enum: ["user", "visitor", "none"] },
    userEmail: { type: "string" },
    supersededAt: { type: "string" },
    question: { type: "string" },
    answer: { type: "string" },
    answerMode: { type: "string", enum: ["generated", "extractive"] },
    knowledgeBaseId: { type: "string" },
    model: { type: "string" },
    retrievalMs: { type: "number" },
    firstTokenMs: { type: "number" },
    totalMs: { type: "number" },
    promptTokens: { type: "number" },
    completionTokens: { type: "number" },
    sources: { type: "array", items: chatSourceSchema },
    chunks: { type: "array", items: chatRetrievedChunkSchema },
    rating: { type: "string", nullable: true },
    feedbackReasons: feedbackReasonsSchema,
    createdAt: { type: "string" },
  },
  required: ["id", "ownerType", "question", "answer", "answerMode", "sources", "chunks", "createdAt"],
  additionalProperties: false,
} as const;

const chatLogsListResponseSchema = {
  "200": {
    type: "object",
    properties: {
      logs: { type: "array", items: chatLogRecordSchema },
      total: { type: "number" },
    },
    required: ["logs", "total"],
    additionalProperties: false,
  },
  ...errorResponses,
} as const;

const candidateSchema = {
  type: "object", nullable: true,
  properties: {
    question: { type: "string", minLength: 1, maxLength: 2000 }, answer: { type: "string", maxLength: 20000 },
    history: { type: "array", maxItems: 20, items: { type: "object", properties: { question: { type: "string", maxLength: 2000 }, answer: { type: "string", maxLength: 20000 } }, required: ["question", "answer"], additionalProperties: false } },
    filters: { ...retrievalFiltersSchema, nullable: true },
    type: { type: "string", enum: ["fact", "mechanism", "compare", "metadata", "term", "followup", "unanswerable"] },
    split: { type: "string", enum: ["dev", "test"] }, answerable: { type: "boolean" },
    labels: { type: "array", maxItems: 100, items: { type: "object", properties: { articleKey: { type: "string", pattern: "^[0-9]+$" }, relevance: { type: "integer", minimum: 0, maximum: 3 }, evidence: { type: "array", maxItems: 50, items: { type: "string", maxLength: 20000 } } }, required: ["articleKey", "relevance", "evidence"], additionalProperties: false } },
  }, required: ["question", "history", "filters", "type", "split", "answerable", "labels"], additionalProperties: false,
} as const;
const reviewProperties = {
  status: { type: "string", enum: ["new", "investigating", "resolved", "dismissed"] }, reasons: feedbackReasonsSchema,
  notes: { type: "string", maxLength: 20000 }, correctedAnswer: { type: "string", maxLength: 20000 }, candidate: candidateSchema,
} as const;
const reviewInputSchema = { type: "object", properties: reviewProperties, required: ["status", "reasons", "notes", "correctedAnswer", "candidate"], additionalProperties: false } as const;
const revisionSchema = { type: "integer", minimum: 0, maximum: 2147483646 } as const;
const reviewParams = { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false } as const;
const noContentResponse = { "204": { type: "object", additionalProperties: false }, ...errorResponses } as const;

// ─── Search ───────────────────────────────────────────────────────────────────

const searchBodySchema = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 2000 },
    filters: retrievalFiltersSchema,
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const searchResultSchema = {
  type: "object",
  properties: {
    documentId: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    excerpt: { type: "string" },
    score: { type: "number" },
  },
  required: ["documentId", "title", "url", "excerpt", "score"],
  additionalProperties: false,
} as const;

const searchResponseSchema = {
  "200": {
    type: "object",
    properties: {
      query: { type: "string" },
      results: { type: "array", items: searchResultSchema },
      total: { type: "number" },
    },
    required: ["query", "results", "total"],
    additionalProperties: false,
  },
  ...errorResponses,
} as const;

// ─── Health ───────────────────────────────────────────────────────────────────

const healthResponseSchema = {
  "200": {
    type: "object",
    properties: {
      status: { type: "string", enum: ["ok"] },
      service: { type: "string", enum: ["nyz-rag-api"] },
      timestamp: { type: "string" },
    },
    required: ["status", "service", "timestamp"],
    additionalProperties: false,
  },
  ...errorResponses,
} as const;

// ─── Knowledge overview ───────────────────────────────────────────────────────

const crawlTaskRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sourceId: { type: "string" },
    sourceName: { type: "string" },
    status: { type: "string", enum: ["等待中", "运行中", "已完成", "失败"] },
    progress: { type: "number" },
    processedCount: { type: "number" },
    failedCount: { type: "number" },
    articleLimit: { type: "number" },
    createdAt: { type: "string" },
    error: { type: "string" },
  },
  required: ["id", "sourceId", "sourceName", "status", "progress", "processedCount", "failedCount", "createdAt"],
  additionalProperties: false,
} as const;

const knowledgeStatsSchema = {
  type: "object",
  properties: {
    documents: { type: "number" },
    sources: { type: "number" },
    processingTasks: { type: "number" },
    lastUpdated: { type: "string", nullable: true },
  },
  required: ["documents", "sources", "processingTasks"],
  additionalProperties: false,
} as const;

const knowledgeOverviewResponseSchema = {
  "200": {
    type: "object",
    properties: {
      sources: { type: "array", items: dataSourceRecordSchema },
      tasks: { type: "array", items: crawlTaskRecordSchema },
      stats: knowledgeStatsSchema,
    },
    required: ["sources", "tasks", "stats"],
    additionalProperties: false,
  },
  ...errorResponses,
} as const;

// ─── Registry ─────────────────────────────────────────────────────────────────

export interface RouteSchema {
  body?: Record<string, unknown>;
  querystring?: Record<string, unknown>;
  params?: Record<string, unknown>;
  response?: Record<string, Record<string, unknown>>;
}

const adminAccountSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    nickname: { type: "string" },
    isSuper: { type: "boolean" },
    disabled: { type: "boolean" },
    roleId: { type: "string", nullable: true },
    roleName: { type: "string", nullable: true },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "email", "nickname", "isSuper", "disabled", "roleId", "roleName", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const;

const adminPermissionsSchema = { type: "array", items: { type: "string", enum: [...ADMIN_PERMISSIONS] }, maxItems: ADMIN_PERMISSIONS.length, uniqueItems: true } as const;

const adminSessionSchema = {
  type: "object",
  properties: {
    username: { type: "string" },
    expiresAt: { type: "string" },
    admin: adminAccountSchema,
    permissions: adminPermissionsSchema,
  },
  required: ["username", "expiresAt", "admin", "permissions"],
  additionalProperties: false,
} as const;

const adminRoleSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    permissions: adminPermissionsSchema,
    disabled: { type: "boolean" },
    adminCount: { type: "number" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["id", "name", "description", "permissions", "disabled", "adminCount", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const;

const adminAuditLogSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    adminId: { type: "string", nullable: true },
    adminEmail: { type: "string", nullable: true },
    adminNickname: { type: "string", nullable: true },
    method: { type: "string" },
    route: { type: "string" },
    resourceId: { type: "string", nullable: true },
    statusCode: { type: "number" },
    result: { type: "string", enum: ["success", "denied", "failed"] },
    requestId: { type: "string" },
    ip: { type: "string" },
    createdAt: { type: "string" },
  },
  required: ["id", "adminId", "adminEmail", "adminNickname", "method", "route", "resourceId", "statusCode", "result", "requestId", "ip", "createdAt"],
  additionalProperties: false,
} as const;

const adminAuditLogsQuerySchema = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 200 },
    result: { type: "string", enum: ["success", "denied", "failed"] },
    page: { type: "string", pattern: "^[1-9][0-9]*$" },
    pageSize: { type: "string", pattern: "^[1-9][0-9]*$" },
  },
  additionalProperties: false,
} as const;

const adminRoleFields = {
  name: { type: "string", minLength: 1, maxLength: 50, pattern: "\\S" },
  description: { type: "string", maxLength: 200 },
  permissions: adminPermissionsSchema,
} as const;
const nullableRoleId = { type: "string", format: "uuid", nullable: true } as const;
const idParams = { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false } as const;

// ─── User accounts ────────────────────────────────────────────────────────────

// Handlers trim and lower-case emails; the format check rejects surrounding whitespace.
const emailString = { type: "string", format: "email", maxLength: 254 } as const;
const newPasswordString = { type: "string", minLength: 8, maxLength: 128, pattern: "\\S" } as const;
const emailCodeString = { type: "string", pattern: "^[0-9]{6}$" } as const;
const noContent = { "204": { type: "object", additionalProperties: true }, ...errorResponses } as const;

const userAccountSchema = {
  type: "object",
  properties: { id: { type: "string" }, email: { type: "string" }, createdAt: { type: "string" } },
  required: ["id", "email", "createdAt"],
  additionalProperties: false,
} as const;

const userSessionSchema = {
  type: "object",
  properties: { user: { ...userAccountSchema, nullable: true } },
  required: ["user"],
  additionalProperties: false,
} as const;

const objectBody = (properties: Record<string, unknown>) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});

const adminUserRecordSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    email: { type: "string" },
    disabled: { type: "boolean" },
    sessionCount: { type: "number" },
    messageCount: { type: "number" },
    createdAt: { type: "string" },
    lastLoginAt: { type: "string" },
  },
  required: ["id", "email", "disabled", "sessionCount", "messageCount", "createdAt"],
  additionalProperties: false,
} as const;

/**
 * Registry keyed by `"METHOD /path/template"` exactly as registered in Fastify.
 * Consumed by the `onRoute` hook in configureCommon to attach schemas.
 */
export const routeSchemas: Record<string, RouteSchema> = {
  "POST /api/admin/auth/login": {
    body: {
      type: "object",
      properties: { username: { type: "string", minLength: 1, maxLength: 254 }, password: { type: "string", minLength: 1, maxLength: 1024 } },
      required: ["username", "password"],
      additionalProperties: false,
    },
    response: { "200": adminSessionSchema, ...errorResponses },
  },
  "GET /api/admin/auth/session": { response: { "200": adminSessionSchema, ...errorResponses } },
  "POST /api/admin/auth/logout": { response: { "204": { type: "object" }, ...errorResponses } },
  "PATCH /api/admin/auth/profile": {
    body: {
      type: "object",
      properties: { email: { type: "string", format: "email", maxLength: 254 }, nickname: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" } },
      required: ["email", "nickname"],
      additionalProperties: false,
    },
    response: { "200": adminSessionSchema, ...errorResponses },
  },
  "POST /api/admin/auth/password": {
    body: {
      type: "object",
      properties: {
        currentPassword: { type: "string", minLength: 1, maxLength: 1024 },
        newPassword: { type: "string", minLength: 8, maxLength: 1024, pattern: "\\S" },
      },
      required: ["currentPassword", "newPassword"],
      additionalProperties: false,
    },
    response: { "204": { type: "object", additionalProperties: true }, ...errorResponses },
  },

  // ── Admin: admin accounts (super-only) ─────────────────────────────────────
  "GET /api/admin/admins": {
    response: { "200": { type: "array", items: adminAccountSchema }, ...errorResponses },
  },
  "POST /api/admin/admins": {
    body: {
      type: "object",
      properties: {
        email: { type: "string", format: "email", maxLength: 254 },
        nickname: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
        password: { type: "string", minLength: 8, maxLength: 1024, pattern: "\\S" },
        roleId: nullableRoleId,
      },
      required: ["email", "nickname", "password"],
      additionalProperties: false,
    },
    response: { "201": adminAccountSchema, ...errorResponses },
  },
  "PATCH /api/admin/admins/:id": {
    params: idParams,
    body: { type: "object", properties: { disabled: { type: "boolean" }, roleId: nullableRoleId }, minProperties: 1, additionalProperties: false },
    response: { "200": adminAccountSchema, ...errorResponses },
  },

  // ── Admin: roles (super-only) ───────────────────────────────────────────────
  "GET /api/admin/roles": {
    response: { "200": { type: "array", items: adminRoleSchema }, ...errorResponses },
  },
  "POST /api/admin/roles": {
    body: objectBody(adminRoleFields),
    response: { "201": adminRoleSchema, ...errorResponses },
  },
  "PATCH /api/admin/roles/:id": {
    params: idParams,
    body: { type: "object", properties: { ...adminRoleFields, disabled: { type: "boolean" } }, minProperties: 1, additionalProperties: false },
    response: { "200": adminRoleSchema, ...errorResponses },
  },
  "DELETE /api/admin/roles/:id": { params: idParams, response: noContent },
  "GET /api/admin/audit-logs": {
    querystring: adminAuditLogsQuerySchema,
    response: {
      "200": {
        type: "object",
        properties: { logs: { type: "array", items: adminAuditLogSchema }, total: { type: "number" } },
        required: ["logs", "total"],
        additionalProperties: false,
      },
      ...errorResponses,
    },
  },

  // ── User accounts ───────────────────────────────────────────────────────────
  "GET /api/auth/session": { response: { "200": userSessionSchema, ...errorResponses } },
  "POST /api/auth/register/code": { body: objectBody({ email: emailString }), response: noContent },
  "POST /api/auth/register": {
    body: objectBody({ email: emailString, code: emailCodeString, password: newPasswordString }),
    response: { "201": userSessionSchema, ...errorResponses },
  },
  "POST /api/auth/login": {
    body: objectBody({ email: emailString, password: { type: "string", minLength: 1, maxLength: 1024 } }),
    response: { "200": userSessionSchema, ...errorResponses },
  },
  "POST /api/auth/logout": { response: noContent },
  "POST /api/auth/password-reset/code": { body: objectBody({ email: emailString }), response: noContent },
  "POST /api/auth/password-reset": {
    body: objectBody({ email: emailString, code: emailCodeString, password: newPasswordString }),
    response: { "200": userSessionSchema, ...errorResponses },
  },
  "POST /api/auth/password": {
    body: objectBody({ currentPassword: { type: "string", minLength: 1, maxLength: 1024 }, password: newPasswordString }),
    response: noContent,
  },

  // ── Admin: users ────────────────────────────────────────────────────────────
  "GET /api/admin/users": {
    querystring: {
      type: "object",
      properties: { query: { type: "string" }, page: { type: "string", pattern: "^[1-9][0-9]*$" }, pageSize: { type: "string", pattern: "^[1-9][0-9]*$" } },
      additionalProperties: false,
    },
    response: {
      "200": {
        type: "object",
        properties: { users: { type: "array", items: adminUserRecordSchema }, total: { type: "number" } },
        required: ["users", "total"],
        additionalProperties: false,
      },
      ...errorResponses,
    },
  },
  "PATCH /api/admin/users/:id": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    body: objectBody({ disabled: { type: "boolean" } }),
    response: { "200": adminUserRecordSchema, ...errorResponses },
  },
  // ── Health ──────────────────────────────────────────────────────────────────
  "GET /health": {
    response: healthResponseSchema,
  },

  // ── Knowledge overview ──────────────────────────────────────────────────────
  "GET /api/knowledge": {
    response: {
      "200": {
        type: "object",
        properties: { stats: knowledgeStatsSchema },
        required: ["stats"],
        additionalProperties: false,
      },
      ...errorResponses,
    },
  },
  "GET /api/admin/knowledge": {
    response: knowledgeOverviewResponseSchema,
  },

  // SSE：`overview` 事件的数据与 GET /api/admin/knowledge 相同，内容变化时推送。
  "GET /api/admin/knowledge/events": {
    response: errorResponses,
  },

  // ── Chat ────────────────────────────────────────────────────────────────────
  "POST /api/chat": {
    body: chatBodySchema,
    response: chatResponseSchema,
  },

  "GET /api/chat/sessions": {
    querystring: pageQuerystring,
    response: chatSessionsListResponseSchema,
  },

  "POST /api/chat/sessions": {
    body: createChatSessionBodySchema,
    response: {
      "201": chatSessionRecordSchema,
      ...errorResponses,
    },
  },

  "GET /api/chat/sessions/:id/messages": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    response: chatSessionMessagesResponseSchema,
  },

  "DELETE /api/chat/sessions/:id": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    response: { "204": { type: "object", additionalProperties: true }, ...errorResponses },
  },

  // SSE: body validated, no JSON success response schema
  "POST /api/chat/sessions/:id/stream": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    body: chatStreamBodySchema,
    response: errorResponses,
  },

  "POST /api/messages/:id/feedback": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    body: chatFeedbackBodySchema,
    response: { "204": { type: "object", additionalProperties: true }, ...errorResponses },
  },

  // ── Admin: chat logs ────────────────────────────────────────────────────────
  "GET /api/admin/chat-logs": {
    querystring: chatLogsQuerySchema,
    response: chatLogsListResponseSchema,
  },
  "GET /api/admin/chat-logs/:id/review": {
    params: reviewParams,
    response: { "200": { ...reviewInputSchema, properties: { ...reviewProperties, revision: revisionSchema, approvedRevision: { ...revisionSchema, nullable: true }, approvedAt: { type: "string", nullable: true } }, required: [...reviewInputSchema.required, "revision", "approvedRevision", "approvedAt"] }, ...errorResponses },
  },
  "PUT /api/admin/chat-logs/:id/review": {
    params: reviewParams, body: { type: "object", properties: { revision: revisionSchema, review: reviewInputSchema }, required: ["revision", "review"], additionalProperties: false }, response: noContentResponse,
  },
  "POST /api/admin/chat-logs/:id/review/approve": {
    params: reviewParams, body: { type: "object", properties: { revision: revisionSchema, confirmSanitized: { type: "boolean" } }, required: ["revision", "confirmSanitized"], additionalProperties: false }, response: noContentResponse,
  },
  "POST /api/admin/chat-logs/:id/review/export": {
    params: reviewParams, body: { type: "object", properties: { revision: revisionSchema }, required: ["revision"], additionalProperties: false },
    response: { "200": { type: "object", properties: { schemaVersion: { type: "integer" }, name: { type: "string" }, version: { type: "string" }, provenance: { type: "string" }, questions: { type: "array", items: { ...candidateSchema, nullable: false, properties: { ...candidateSchema.properties, id: { type: "string" }, source: { type: "string", enum: ["real"] } }, required: [...candidateSchema.required, "id", "source"] } } }, required: ["schemaVersion", "name", "version", "provenance", "questions"], additionalProperties: false }, ...errorResponses },
  },

  // ── Admin: documents ────────────────────────────────────────────────────────
  "GET /api/admin/documents": {
    querystring: adminDocumentsQuerySchema,
    response: documentListResponseSchema,
  },

  "GET /api/admin/documents/:id": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    response: { "200": documentRecordSchema, ...errorResponses },
  },

  "POST /api/admin/documents/:id/reprocess": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    response: { "202": queuedResponseSchema, ...errorResponses },
  },

  "POST /api/admin/documents/:id/embed": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    response: { "202": queuedResponseSchema, ...errorResponses },
  },

  "DELETE /api/admin/documents/:id": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    response: { "204": { type: "object", additionalProperties: true }, ...errorResponses },
  },

  // ── Public document detail ──────────────────────────────────────────────────
  // Public article links are user-visible: unknown or malformed IDs return 404 rather than a validation error.
  "GET /api/documents/:id": {
    params: { type: "object", properties: { id: nonBlankString }, required: ["id"], additionalProperties: false },
    response: { "200": documentDetailSchema, ...errorResponses },
  },

  // ── Admin: knowledge bases ──────────────────────────────────────────────────
  "GET /api/admin/knowledge-bases": {
    response: { "200": { type: "array", items: knowledgeBaseRecordSchema }, ...errorResponses },
  },

  "POST /api/admin/knowledge-bases": {
    body: saveKnowledgeBaseBodySchema,
    response: { "201": knowledgeBaseRecordSchema, ...errorResponses },
  },

  "PATCH /api/admin/knowledge-bases/:id": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    body: saveKnowledgeBaseBodySchema,
    response: { "200": knowledgeBaseRecordSchema, ...errorResponses },
  },

  // ── Admin: model providers ──────────────────────────────────────────────────
  "GET /api/admin/model-providers": {
    response: { "200": { type: "array", items: modelProviderRecordSchema }, ...errorResponses },
  },

  "POST /api/admin/model-providers": {
    body: saveModelProviderBodySchema,
    response: { "201": modelProviderRecordSchema, ...errorResponses },
  },

  "PATCH /api/admin/model-providers/:id": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    body: saveModelProviderBodySchema,
    response: { "200": modelProviderRecordSchema, ...errorResponses },
  },

  "POST /api/admin/model-providers/models": {
    body: listProviderModelsBodySchema,
    response: { "200": listProviderModelsResponseSchema, ...errorResponses },
  },

  "DELETE /api/admin/model-providers/:id": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    response: { "204": { type: "object", additionalProperties: true }, ...errorResponses },
  },

  "GET /api/admin/model-providers/:id/models": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    response: { "200": listProviderModelsResponseSchema, ...errorResponses },
  },

  // ── Admin: model settings ───────────────────────────────────────────────────
  "GET /api/admin/model-settings": {
    response: { "200": modelSettingsResponseSchema, ...errorResponses },
  },

  "PUT /api/admin/model-settings/:capability": {
    params: modelCapabilityParams,
    body: saveModelSettingBodySchema,
    response: { "200": modelSettingRecordSchema, ...errorResponses },
  },

  "DELETE /api/admin/model-settings/:capability": {
    params: modelCapabilityParams,
    response: { "204": { type: "object", additionalProperties: true }, ...errorResponses },
  },

  // ── Admin: secret settings ──────────────────────────────────────────────────
  "GET /api/admin/settings/article-token": {
    response: { "200": secretSettingStatusSchema, ...errorResponses },
  },

  "PUT /api/admin/settings/article-token": {
    body: saveSecretSettingBodySchema,
    response: { "200": secretSettingStatusSchema, ...errorResponses },
  },

  "DELETE /api/admin/settings/article-token": {
    response: { "204": { type: "object", additionalProperties: true }, ...errorResponses },
  },

  // ── Admin: sources ──────────────────────────────────────────────────────────
  "POST /api/admin/sources": {
    body: createSourceBodySchema,
    response: { "200": dataSourceRecordSchema, ...errorResponses },
  },

  "POST /api/admin/sources/:id/sync": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    response: { "200": crawlTaskRecordSchema, ...errorResponses },
  },

  "PATCH /api/admin/sources/:id": {
    params: { type: "object", properties: { id: uuidParam }, required: ["id"], additionalProperties: false },
    body: updateSourceStatusBodySchema,
    response: { "200": dataSourceRecordSchema, ...errorResponses },
  },

  // ── Search ──────────────────────────────────────────────────────────────────
  "POST /api/search": {
    body: searchBodySchema,
    response: searchResponseSchema,
  },
};
