import cors from "@fastify/cors";
import Fastify from "fastify";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  closeDatabase, createChatMessage, createKnowledgeBase, createModelProvider, createSource, createTask, deleteDocument, deleteModelProvider, getDocument,
  getDocumentSummary, getSource, getStats, listChatMessages, listDocuments, listKnowledgeBases, listModelProviders, listSources, listTasks, migrate,
  rateChatMessage, searchDocuments, selectEmbeddingProvider, setEmbeddingState, setProcessingState, updateKnowledgeBase, updateModelProvider, updateSourceStatus,
} from "@nyz-rag/processing";
import type { ApiHealth, ChatFeedbackRequest, ChatLogListResponse, ChatRequest, ChatResponse, CreateSourceRequest, DocumentListResponse, DocumentSummary, KnowledgeOverview, SearchResult, SaveKnowledgeBaseRequest, SaveModelProviderRequest, UpdateSourceStatusRequest } from "@nyz-rag/types";

const app = Fastify({ logger: true });
const port = Number(process.env.API_PORT ?? 3000);
const queueConnection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const documentQueue = new Queue(process.env.DOCUMENT_QUEUE_NAME ?? "document-processing", { connection: queueConnection });
const queryTerms = (value: string) => value.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/gi) ?? [];
const pageParams = (page: string, pageSize: string) => ({ page: Math.max(1, Number.parseInt(page, 10) || 1), pageSize: Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 20)) });
const documentJobOptions = (documentId: string) => ({ jobId: `document-${documentId}`, removeOnComplete: true, removeOnFail: true });

async function hasDocumentJob(document: DocumentSummary) {
  if (await documentQueue.getJob(`document-${document.id}`)) return true;
  const activeJobs = await documentQueue.getJobs(["active"]);
  return activeJobs.some((job) => job.name === "sync-source" && job.data.sourceId === document.sourceId);
}

function validKnowledgeBase(input: SaveKnowledgeBaseRequest) {
  return Number.isInteger(input.topK) && input.topK >= 1 && input.topK <= 100 && Number.isFinite(input.similarityThreshold) && input.similarityThreshold >= 0
    && input.similarityThreshold <= 1 && Number.isInteger(input.maxContextLength) && input.maxContextLength >= 256;
}

function modelProviderError(input: SaveModelProviderRequest | undefined) {
  if (!input?.name?.trim() || !input.provider?.trim() || !input.chatModel?.trim() || !input.credentialEnv?.trim() || !/^[A-Z][A-Z0-9_]*$/.test(input.credentialEnv)) {
    return "name, provider, chatModel and a valid credential environment variable are required";
  }
  if (input.baseUrl) {
    try { if (!["http:", "https:"].includes(new URL(input.baseUrl).protocol)) throw new Error(); }
    catch { return "baseUrl must be a valid http(s) URL"; }
  }
  return null;
}

await app.register(cors, { origin: true });

app.get<{ Reply: ApiHealth }>("/health", async () => ({
  status: "ok",
  service: "nyz-rag-api",
  timestamp: new Date().toISOString(),
}));

app.post<{ Body: ChatRequest; Reply: ChatResponse }>("/api/chat", async (request, reply) => {
  const question = request.body?.question?.trim();
  if (!question) {
    return reply.code(400).send({ error: "question is required" });
  }

  const matches = await searchDocuments(queryTerms(question), { readyOnly: true, limit: 3 });
  const answer = matches.length ? `根据知识库中的《${matches[0].title}》，${matches[0].head.slice(0, 180)}${matches[0].head.length > 180 ? "……" : ""}` : "知识库中暂未找到与问题直接匹配的文章，请尝试更具体的关键词。";
  const sources = matches.map(({ documentId, title, url }) => ({ documentId, title, url }));
  const messageId = crypto.randomUUID();
  await createChatMessage({ id: messageId, question, answer, sources });
  return { messageId, answer, sources };
});

app.get<{ Querystring: { query?: string; rating?: string; page?: string; pageSize?: string } }>("/api/admin/chat-logs", async (request): Promise<ChatLogListResponse> => {
  const { query = "", rating, page = "1", pageSize = "20" } = request.query;
  return listChatMessages({ query, rating, ...pageParams(page, pageSize) });
});

app.post<{ Params: { id: string }; Body: ChatFeedbackRequest }>("/api/messages/:id/feedback", async (request, reply) => {
  const { rating } = request.body ?? {};
  if (rating !== "positive" && rating !== "negative") return reply.code(400).send({ error: "rating must be positive or negative" });
  if (!await rateChatMessage(request.params.id, rating)) return reply.code(404).send({ error: "message not found" });
  return reply.code(204).send();
});

app.get("/api/knowledge", async (): Promise<KnowledgeOverview> => {
  const [sources, tasks, stats] = await Promise.all([listSources(), listTasks(), getStats()]);
  return { sources, tasks, stats };
});

app.get<{ Querystring: { query?: string; sourceId?: string; status?: string; page?: string; pageSize?: string } }>("/api/admin/documents", async (request): Promise<DocumentListResponse> => {
  const { query = "", sourceId, status, page = "1", pageSize = "20" } = request.query;
  return listDocuments({ query, sourceId, status, ...pageParams(page, pageSize) });
});

app.get<{ Params: { id: string } }>("/api/admin/documents/:id", async (request, reply) => {
  const document = await getDocument(request.params.id);
  if (!document) return reply.code(404).send({ error: "document not found" });
  return document;
});

app.post<{ Params: { id: string } }>("/api/admin/documents/:id/reprocess", async (request, reply) => {
  const document = await getDocumentSummary(request.params.id);
  if (!document) return reply.code(404).send({ error: "document not found" });
  if (await hasDocumentJob(document)) return reply.code(409).send({ error: "document already has a processing job" });
  // 先写状态再入队，避免 Worker 处理完成后状态又被改回待处理。
  await setProcessingState(document.id, "pending");
  try {
    await documentQueue.add("reprocess-document", { documentId: document.id }, documentJobOptions(document.id));
  } catch (error) {
    await setProcessingState(document.id, "failed", "任务入队失败，请重试");
    throw error;
  }
  return reply.code(202).send({ status: "queued", documentId: document.id });
});

app.post<{ Params: { id: string } }>("/api/admin/documents/:id/embed", async (request, reply) => {
  const document = await getDocumentSummary(request.params.id);
  if (!document) return reply.code(404).send({ error: "document not found" });
  if (await hasDocumentJob(document)) return reply.code(409).send({ error: "document already has a processing job" });
  if (document.processingStatus !== "chunked" || !document.chunkCount) return reply.code(409).send({ error: "请先完成文档清洗与切片" });
  try {
    const provider = selectEmbeddingProvider(await listModelProviders());
    if (!process.env[provider.credentialEnv]?.trim()) throw new Error(`请在 API 和 Worker 环境配置 ${provider.credentialEnv}`);
  } catch (cause) {
    return reply.code(409).send({ error: cause instanceof Error ? cause.message : "Embedding configuration is invalid" });
  }
  await setEmbeddingState(document.id, "queued");
  try {
    await documentQueue.add("embed-document", { documentId: document.id }, documentJobOptions(document.id));
  } catch (error) {
    await setEmbeddingState(document.id, "failed", "任务入队失败，请重试");
    throw error;
  }
  return reply.code(202).send({ status: "queued", documentId: document.id });
});

app.delete<{ Params: { id: string } }>("/api/admin/documents/:id", async (request, reply) => {
  const document = await getDocumentSummary(request.params.id);
  if (!document) return reply.code(404).send({ error: "document not found" });
  if (await hasDocumentJob(document)) return reply.code(409).send({ error: "document already has a processing job" });
  // 切片与向量随文档级联删除。
  if (!await deleteDocument(document.id)) return reply.code(404).send({ error: "document not found" });
  return reply.code(204).send();
});

app.get("/api/admin/knowledge-bases", async () => listKnowledgeBases());

app.post<{ Body: SaveKnowledgeBaseRequest }>("/api/admin/knowledge-bases", async (request, reply) => {
  const input = request.body;
  if (!input?.name?.trim()) return reply.code(400).send({ error: "name is required" });
  if (!validKnowledgeBase(input)) return reply.code(400).send({ error: "knowledge base settings are invalid" });
  return reply.code(201).send(await createKnowledgeBase({ ...input, name: input.name.trim() }));
});

app.patch<{ Params: { id: string }; Body: SaveKnowledgeBaseRequest }>("/api/admin/knowledge-bases/:id", async (request, reply) => {
  const input = request.body;
  if (!input?.name?.trim()) return reply.code(400).send({ error: "name is required" });
  if (!validKnowledgeBase(input)) return reply.code(400).send({ error: "knowledge base settings are invalid" });
  const updated = await updateKnowledgeBase(request.params.id, { ...input, name: input.name.trim() });
  if (!updated) return reply.code(404).send({ error: "knowledge base not found" });
  return updated;
});

app.get("/api/admin/model-providers", async () => listModelProviders());

app.post<{ Body: SaveModelProviderRequest }>("/api/admin/model-providers", async (request, reply) => {
  const error = modelProviderError(request.body);
  if (error) return reply.code(400).send({ error });
  return reply.code(201).send(await createModelProvider({ ...request.body, name: request.body.name.trim() }));
});

app.patch<{ Params: { id: string }; Body: SaveModelProviderRequest }>("/api/admin/model-providers/:id", async (request, reply) => {
  const error = modelProviderError(request.body);
  if (error) return reply.code(400).send({ error });
  const updated = await updateModelProvider(request.params.id, { ...request.body, name: request.body.name.trim() });
  if (!updated) return reply.code(404).send({ error: "model provider not found" });
  return updated;
});

app.delete<{ Params: { id: string } }>("/api/admin/model-providers/:id", async (request, reply) => {
  if (!await deleteModelProvider(request.params.id)) return reply.code(404).send({ error: "model provider not found" });
  return reply.code(204).send();
});

app.post<{ Body: CreateSourceRequest }>("/api/admin/sources", async (request, reply) => {
  const { name, url, kind, frequency } = request.body ?? {};
  if (!name?.trim() || !url?.trim()) return reply.code(400).send({ error: "name and url are required" });
  if (kind !== "文章 API" && kind !== "网页站点") return reply.code(400).send({ error: "kind must be 文章 API or 网页站点" });
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return reply.code(400).send({ error: "url must be a valid http(s) URL" }); }
  if (!["http:", "https:"].includes(parsed.protocol)) return reply.code(400).send({ error: "url must be a valid http(s) URL" });
  // 地址会展示在管理端并写入日志，文章接口 token 只能通过 Worker 环境变量 NYZ_ARTICLE_TOKEN 提供。
  if (kind === "文章 API" && parsed.searchParams.has("token")) return reply.code(400).send({ error: "文章 API 地址不能包含 token，请在 Worker 环境变量 NYZ_ARTICLE_TOKEN 中配置" });
  return createSource({ name: name.trim(), url: url.trim(), kind, frequency: frequency ?? "" });
});

app.post<{ Params: { id: string } }>("/api/admin/sources/:id/sync", async (request, reply) => {
  const source = await getSource(request.params.id);
  if (!source) return reply.code(404).send({ error: "source not found" });
  if (source.status !== "运行中") return reply.code(409).send({ error: "source is paused" });
  const task = await createTask(source);
  await documentQueue.add("sync-source", { sourceId: source.id, taskId: task.id });
  return task;
});

app.patch<{ Params: { id: string }; Body: UpdateSourceStatusRequest }>("/api/admin/sources/:id", async (request, reply) => {
  const { status } = request.body ?? {};
  if (status !== "运行中" && status !== "已暂停") return reply.code(400).send({ error: "status must be 运行中 or 已暂停" });
  const updated = await updateSourceStatus(request.params.id, status);
  if (!updated) return reply.code(404).send({ error: "source not found" });
  return updated;
});

app.post<{ Body: { query?: string } }>("/api/search", async (request) => {
  const query = request.body?.query?.trim() ?? "";
  const results: SearchResult[] = (await searchDocuments(queryTerms(query), { readyOnly: false }))
    .map(({ head, ...result }) => ({ ...result, excerpt: head.slice(0, 160) }));
  return { query, results, total: results.length };
});

app.addHook("onClose", async () => {
  await documentQueue.close();
  await queueConnection.quit();
  await closeDatabase();
});
process.once("SIGINT", () => void app.close());
process.once("SIGTERM", () => void app.close());

try {
  await migrate();
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
