import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { KnowledgeSnapshot } from "@nyz-rag/types";

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
const storePath = resolve(process.env.NYZ_STORE_PATH ?? "../../.nyz-data/knowledge.json");

const worker = new Worker(
  "document-processing",
  async (job) => {
    const snapshot = JSON.parse(await readFile(storePath, "utf8")) as KnowledgeSnapshot;
    const task = snapshot.tasks.find((item) => item.id === job.data.taskId);
    const source = snapshot.sources.find((item) => item.id === job.data.sourceId);
    if (!task || !source) throw new Error("source or task not found");
    task.status = "运行中";
    task.progress = 35;
    await writeFile(storePath, JSON.stringify(snapshot, null, 2));
    const now = new Date().toISOString();
    const existing = snapshot.documents.find((document) => document.sourceId === source.id);
    const document = existing ?? { id: crypto.randomUUID(), sourceId: source.id, title: `${source.name}知识库导读`, url: source.url, content: `这是来自${source.name}的知识库文章。你可以在这里沉淀产品能力、业务流程、操作规范和常见问题，用户端会基于这些内容进行关键词检索和问答。`, status: "pending" as const, createdAt: now, updatedAt: now };
    document.status = "ready";
    document.updatedAt = now;
    if (!existing) snapshot.documents.unshift(document);
    source.documentCount = snapshot.documents.filter((item) => item.sourceId === source.id && item.status === "ready").length;
    source.updatedAt = now;
    task.status = "已完成";
    task.progress = 100;
    snapshot.stats = {
      documents: snapshot.documents.filter((item) => item.status === "ready").length,
      sources: snapshot.sources.length,
      processingTasks: snapshot.tasks.filter((item) => item.status === "等待中" || item.status === "运行中").length,
      lastUpdated: now,
    };
    for (const item of snapshot.sources) {
      item.documentCount = snapshot.documents.filter((entry) => entry.sourceId === item.id && entry.status === "ready").length;
    }
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify(snapshot, null, 2));
    return { status: "ready", documentId: document.id };
  },
  { connection },
);

worker.on("completed", (job) => console.info(`Job ${job.id} completed`));
worker.on("failed", (job, error) => console.error(`Job ${job?.id} failed`, error));

const shutdown = async () => {
  await worker.close();
  await connection.quit();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
console.info("NYZ RAG worker listening on document-processing queue");
