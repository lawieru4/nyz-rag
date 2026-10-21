import cors from "@fastify/cors";
import Fastify from "fastify";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { closeVectorStore, deleteDocumentVectors, selectEmbeddingProvider } from "@nyz-rag/processing";
import type { ApiHealth, ChatFeedbackRequest, ChatLogListResponse, ChatRequest, ChatResponse, CreateSourceRequest, DocumentListResponse, DocumentRecord, SearchResult, SaveKnowledgeBaseRequest, SaveModelProviderRequest, UpdateSourceStatusRequest } from "@nyz-rag/types";
import { readStore, updateStore } from "./store.js";

const app = Fastify({ logger: true });
const port = Number(process.env.API_PORT ?? 3000);
const queueConnection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const documentQueue = new Queue(process.env.DOCUMENT_QUEUE_NAME ?? "document-processing", { connection: queueConnection });
const queryTerms = (value: string) => value.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/gi) ?? [];

async function hasDocumentJob(document: DocumentRecord) {
  if (await documentQueue.getJob(`document-${document.id}`)) return true;
  const activeJobs = await documentQueue.getJobs(["active"]);
  return activeJobs.some((job) => job.name === "sync-source" && job.data.sourceId === document.sourceId);
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

  const snapshot = await readStore();
  const terms = queryTerms(question);
  const matches = snapshot.documents.filter((document) => document.status === "ready").map((document) => {
    const haystack = `${document.title} ${document.content}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    return { document, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  const answer = matches.length ? `根据知识库中的《${matches[0].document.title}》，${matches[0].document.content.slice(0, 180)}${matches[0].document.content.length > 180 ? "……" : ""}` : "知识库中暂未找到与问题直接匹配的文章，请尝试更具体的关键词。";
  const sources = matches.map(({ document }) => ({ documentId: document.id, title: document.title, url: document.url }));
  const log = { id: crypto.randomUUID(), question, answer, sources, rating: null, createdAt: new Date().toISOString() };
  await updateStore((current) => { current.chatLogs.unshift(log); });
  return { messageId: log.id, answer, sources };
});

app.get<{ Querystring: { query?: string; rating?: string; page?: string; pageSize?: string } }>("/api/admin/chat-logs", async (request): Promise<ChatLogListResponse> => {
  const { query = "", rating, page = "1", pageSize = "20" } = request.query;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 20));
  const filtered = (await readStore()).chatLogs.filter((log) => {
    if (rating === "rated" && !log.rating) return false;
    if (rating === "unrated" && log.rating) return false;
    return !normalizedQuery || `${log.question} ${log.answer} ${log.sources.map((source) => source.title).join(" ")}`.toLocaleLowerCase().includes(normalizedQuery);
  });
  return { logs: filtered.slice((currentPage - 1) * limit, currentPage * limit), total: filtered.length };
});

app.post<{ Params: { id: string }; Body: ChatFeedbackRequest }>("/api/messages/:id/feedback", async (request, reply) => {
  const { rating } = request.body ?? {};
  if (rating !== "positive" && rating !== "negative") return reply.code(400).send({ error: "rating must be positive or negative" });
  let found = false;
  await updateStore((snapshot) => {
    const log = snapshot.chatLogs.find((item) => item.id === request.params.id);
    if (log) { log.rating = rating; found = true; }
  });
  if (!found) return reply.code(404).send({ error: "message not found" });
  return reply.code(204).send();
});

app.get("/api/knowledge", async () => readStore());

app.get<{ Querystring: { query?: string; sourceId?: string; status?: string; page?: string; pageSize?: string } }>("/api/admin/documents", async (request): Promise<DocumentListResponse> => {
  const { query = "", sourceId, status, page = "1", pageSize = "20" } = request.query;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 20));
  const filtered = (await readStore()).documents.filter((document) => {
    if (sourceId && document.sourceId !== sourceId) return false;
    if (status && document.status !== status) return false;
    return !normalizedQuery || `${document.title} ${document.url} ${document.content}`.toLocaleLowerCase().includes(normalizedQuery);
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return { documents: filtered.slice((currentPage - 1) * limit, currentPage * limit), total: filtered.length };
});

app.get<{ Params: { id: string } }>("/api/admin/documents/:id", async (request, reply) => {
  const document = (await readStore()).documents.find((item) => item.id === request.params.id);
  if (!document) return reply.code(404).send({ error: "document not found" });
  return document;
});

app.post<{ Params: { id: string } }>("/api/admin/documents/:id/reprocess", async (request, reply) => {
  let error: { code: number; error: string } | undefined;
  await updateStore(async (current) => {
    const document = current.documents.find((item) => item.id === request.params.id);
    if (!document) { error = { code: 404, error: "document not found" }; return; }
    if (await hasDocumentJob(document)) {
      error = { code: 409, error: "document already has a processing job" }; return;
    }
    await documentQueue.add("reprocess-document", { documentId: document.id }, { jobId: `document-${document.id}`, removeOnComplete: true, removeOnFail: true });
    document.processingStatus = "pending";
    delete document.processingError;
  });
  if (error) return reply.code(error.code).send({ error: error.error });
  return reply.code(202).send({ status: "queued", documentId: request.params.id });
});

app.post<{ Params: { id: string } }>("/api/admin/documents/:id/embed", async (request, reply) => {
  let error: { code: number; error: string } | undefined;
  await updateStore(async (current) => {
    const document = current.documents.find((item) => item.id === request.params.id);
    if (!document) { error = { code: 404, error: "document not found" }; return; }
    if (await hasDocumentJob(document)) {
      error = { code: 409, error: "document already has a processing job" }; return;
    }
    if (document.processingStatus !== "chunked" || !document.chunks?.length) {
      error = { code: 409, error: "请先完成文档清洗与切片" }; return;
    }
    try {
      const provider = selectEmbeddingProvider(current.modelProviders);
      if (!process.env[provider.credentialEnv]?.trim()) throw new Error(`请在 API 和 Worker 环境配置 ${provider.credentialEnv}`);
      if (!process.env.DATABASE_URL) throw new Error("请配置 DATABASE_URL 后再执行向量化");
    } catch (cause) {
      error = { code: 409, error: cause instanceof Error ? cause.message : "Embedding configuration is invalid" }; return;
    }
    await documentQueue.add("embed-document", { documentId: document.id }, { jobId: `document-${document.id}`, removeOnComplete: true, removeOnFail: true });
    document.embedding = { status: "queued", chunkCount: 0, updatedAt: new Date().toISOString() };
  });
  if (error) return reply.code(error.code).send({ error: error.error });
  return reply.code(202).send({ status: "queued", documentId: request.params.id });
});

app.delete<{ Params: { id: string } }>("/api/admin/documents/:id", async (request, reply) => {
  let error: { code: number; error: string } | undefined;
  await updateStore(async (current) => {
    const document = current.documents.find((item) => item.id === request.params.id);
    if (!document) { error = { code: 404, error: "document not found" }; return; }
    if (await hasDocumentJob(document)) {
      error = { code: 409, error: "document already has a processing job" }; return;
    }
    await deleteDocumentVectors(document.id);
    current.documents = current.documents.filter((item) => item.id !== request.params.id);
    for (const source of current.sources) {
      source.documentCount = current.documents.filter((item) => item.sourceId === source.id && item.status === "ready").length;
    }
  });
  if (error) return reply.code(error.code).send({ error: error.error });
  return reply.code(204).send();
});

app.get("/api/admin/knowledge-bases", async () => (await readStore()).knowledgeBases);

app.post<{ Body: SaveKnowledgeBaseRequest }>("/api/admin/knowledge-bases", async (request, reply) => {
  const input = request.body;
  if (!input?.name?.trim()) return reply.code(400).send({ error: "name is required" });
  if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 100 || !Number.isFinite(input.similarityThreshold) || input.similarityThreshold < 0 || input.similarityThreshold > 1 || !Number.isInteger(input.maxContextLength) || input.maxContextLength < 256) {
    return reply.code(400).send({ error: "knowledge base settings are invalid" });
  }
  const now = new Date().toISOString();
  const knowledgeBase = { ...input, name: input.name.trim(), id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  await updateStore((snapshot) => { snapshot.knowledgeBases.unshift(knowledgeBase); });
  return reply.code(201).send(knowledgeBase);
});

app.patch<{ Params: { id: string }; Body: SaveKnowledgeBaseRequest }>("/api/admin/knowledge-bases/:id", async (request, reply) => {
  const input = request.body;
  if (!input?.name?.trim()) return reply.code(400).send({ error: "name is required" });
  if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 100 || !Number.isFinite(input.similarityThreshold) || input.similarityThreshold < 0 || input.similarityThreshold > 1 || !Number.isInteger(input.maxContextLength) || input.maxContextLength < 256) {
    return reply.code(400).send({ error: "knowledge base settings are invalid" });
  }
  let updated;
  await updateStore((snapshot) => {
    const index = snapshot.knowledgeBases.findIndex((item) => item.id === request.params.id);
    if (index < 0) return;
    updated = snapshot.knowledgeBases[index] = { ...snapshot.knowledgeBases[index], ...input, name: input.name.trim(), updatedAt: new Date().toISOString() };
  });
  if (!updated) return reply.code(404).send({ error: "knowledge base not found" });
  return updated;
});

app.get("/api/admin/model-providers", async () => (await readStore()).modelProviders);

app.post<{ Body: SaveModelProviderRequest }>("/api/admin/model-providers", async (request, reply) => {
  const input = request.body;
  if (!input?.name?.trim() || !input.provider?.trim() || !input.chatModel?.trim() || !input.credentialEnv?.trim() || !/^[A-Z][A-Z0-9_]*$/.test(input.credentialEnv)) {
    return reply.code(400).send({ error: "name, provider, chatModel and a valid credential environment variable are required" });
  }
  if (input.baseUrl) {
    try { if (!["http:", "https:"].includes(new URL(input.baseUrl).protocol)) throw new Error(); }
    catch { return reply.code(400).send({ error: "baseUrl must be a valid http(s) URL" }); }
  }
  const now = new Date().toISOString();
  const record = { ...input, name: input.name.trim(), id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  await updateStore((snapshot) => {
    if (record.isDefault) snapshot.modelProviders.forEach((provider) => { provider.isDefault = false; });
    snapshot.modelProviders.unshift(record);
  });
  return reply.code(201).send(record);
});

app.patch<{ Params: { id: string }; Body: SaveModelProviderRequest }>("/api/admin/model-providers/:id", async (request, reply) => {
  const input = request.body;
  if (!input?.name?.trim() || !input.provider?.trim() || !input.chatModel?.trim() || !input.credentialEnv?.trim() || !/^[A-Z][A-Z0-9_]*$/.test(input.credentialEnv)) {
    return reply.code(400).send({ error: "name, provider, chatModel and a valid credential environment variable are required" });
  }
  if (input.baseUrl) {
    try { if (!["http:", "https:"].includes(new URL(input.baseUrl).protocol)) throw new Error(); }
    catch { return reply.code(400).send({ error: "baseUrl must be a valid http(s) URL" }); }
  }
  let updated;
  await updateStore((snapshot) => {
    const index = snapshot.modelProviders.findIndex((provider) => provider.id === request.params.id);
    if (index < 0) return;
    if (input.isDefault) snapshot.modelProviders.forEach((provider) => { provider.isDefault = false; });
    updated = snapshot.modelProviders[index] = { ...snapshot.modelProviders[index], ...input, name: input.name.trim(), updatedAt: new Date().toISOString() };
  });
  if (!updated) return reply.code(404).send({ error: "model provider not found" });
  return updated;
});

app.delete<{ Params: { id: string } }>("/api/admin/model-providers/:id", async (request, reply) => {
  let removed = false;
  await updateStore((snapshot) => {
    const count = snapshot.modelProviders.length;
    snapshot.modelProviders = snapshot.modelProviders.filter((provider) => provider.id !== request.params.id);
    removed = count !== snapshot.modelProviders.length;
  });
  if (!removed) return reply.code(404).send({ error: "model provider not found" });
  return reply.code(204).send();
});

app.post<{ Body: CreateSourceRequest }>("/api/admin/sources", async (request, reply) => {
  const { name, url, kind, frequency } = request.body ?? {};
  if (!name?.trim() || !url?.trim()) return reply.code(400).send({ error: "name and url are required" });
  const source = { id: crypto.randomUUID(), name: name.trim(), url: url.trim(), kind, frequency, status: "已暂停" as const, documentCount: 0, updatedAt: null };
  await updateStore((snapshot) => { snapshot.sources.unshift(source); });
  return source;
});

app.post<{ Params: { id: string } }>("/api/admin/sources/:id/sync", async (request, reply) => {
  const snapshot = await readStore();
  const source = snapshot.sources.find((item) => item.id === request.params.id);
  if (!source) return reply.code(404).send({ error: "source not found" });
  if (source.status !== "运行中") return reply.code(409).send({ error: "source is paused" });
  const task = { id: `CR-${Date.now().toString().slice(-8)}`, sourceId: source.id, sourceName: source.name, status: "等待中" as const, progress: 0, createdAt: new Date().toISOString() };
  await updateStore((current) => { current.tasks.unshift(task); });
  await documentQueue.add("sync-source", { sourceId: source.id, taskId: task.id });
  return task;
});

app.patch<{ Params: { id: string }; Body: UpdateSourceStatusRequest }>("/api/admin/sources/:id", async (request, reply) => {
  const { status } = request.body ?? {};
  if (status !== "运行中" && status !== "已暂停") return reply.code(400).send({ error: "status must be 运行中 or 已暂停" });
  let updated;
  await updateStore((snapshot) => {
    const source = snapshot.sources.find((item) => item.id === request.params.id);
    if (source) updated = Object.assign(source, { status });
  });
  if (!updated) return reply.code(404).send({ error: "source not found" });
  return updated;
});

app.post<{ Body: { query?: string } }>("/api/search", async (request) => {
  const query = request.body?.query?.trim() ?? "";
  const terms = queryTerms(query);
  const results: SearchResult[] = (await readStore()).documents.map((document) => {
    const haystack = `${document.title} ${document.content}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    return { documentId: document.id, title: document.title, url: document.url, excerpt: document.content.slice(0, 160), score };
  }).filter((result) => result.score > 0).sort((a, b) => b.score - a.score);
  return { query, results, total: results.length };
});

app.addHook("onClose", async () => {
  await documentQueue.close();
  await queueConnection.quit();
  await closeVectorStore();
});
process.once("SIGINT", () => void app.close());
process.once("SIGTERM", () => void app.close());

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
