import cors from "@fastify/cors";
import Fastify from "fastify";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { ApiHealth, ChatRequest, ChatResponse, CreateSourceRequest, SearchResult } from "@nyz-rag/types";
import { readStore, updateStore } from "./store.js";

const app = Fastify({ logger: true });
const port = Number(process.env.API_PORT ?? 3000);
const queueConnection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const documentQueue = new Queue("document-processing", { connection: queueConnection });
const queryTerms = (value: string) => value.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]{2}/gi) ?? [];

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
  return { answer, sources: matches.map(({ document }) => ({ documentId: document.id, title: document.title, url: document.url })) };
});

app.get("/api/knowledge", async () => readStore());

app.post<{ Body: CreateSourceRequest }>("/api/admin/sources", async (request, reply) => {
  const { name, url, kind, frequency } = request.body ?? {};
  if (!name?.trim() || !url?.trim()) return reply.code(400).send({ error: "name and url are required" });
  const source = { id: crypto.randomUUID(), name: name.trim(), url: url.trim(), kind, frequency, status: "已暂停" as const, documentCount: 0, updatedAt: null };
  await updateStore((snapshot) => snapshot.sources.unshift(source));
  return source;
});

app.post<{ Params: { id: string } }>("/api/admin/sources/:id/sync", async (request, reply) => {
  const snapshot = await readStore();
  const source = snapshot.sources.find((item) => item.id === request.params.id);
  if (!source) return reply.code(404).send({ error: "source not found" });
  const task = { id: `CR-${Date.now().toString().slice(-8)}`, sourceId: source.id, sourceName: source.name, status: "等待中" as const, progress: 0, createdAt: new Date().toISOString() };
  await updateStore((current) => current.tasks.unshift(task));
  await documentQueue.add("sync-source", { sourceId: source.id, taskId: task.id });
  return task;
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

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
