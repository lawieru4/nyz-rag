import { Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  closeDatabase, embedChunks, getSource, getTask, listDocumentChunks, listModelProviders, lockDocument, markSourceSynced, migrate, replaceDocumentChunks,
  saveDocumentEmbeddings, selectEmbeddingProvider, setEmbeddingState, setProcessingState, updateTask, upsertDocument, withTransaction, type Executor,
} from "@nyz-rag/processing";
import type { DataSourceRecord, DocumentChunkRecord } from "@nyz-rag/types";

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const maxPages = Math.max(1, Math.min(100, Number.parseInt(process.env.CRAWL_MAX_PAGES ?? "20", 10) || 20));
const requestDelayMs = Math.max(1000, Number.parseInt(process.env.CRAWL_REQUEST_DELAY_MS ?? "1000", 10) || 1000);
const requestTimeoutMs = Math.max(1000, Number.parseInt(process.env.CRAWL_REQUEST_TIMEOUT_MS ?? "15000", 10) || 15000);
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message.slice(0, 500) : fallback;

function extractPage(html: string, url: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const main = html.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i)?.[1] ?? html;
  const content = main
    .replace(/<(script|style|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[\t\r ]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const links = [...html.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>/gi)]
    .map((match) => { try { return new URL(match[2], url); } catch { return null; } })
    .filter((link): link is URL => Boolean(link && link.origin === new URL(url).origin && ["http:", "https:"].includes(link.protocol)))
    .map((link) => { link.hash = ""; return link.toString(); });
  return { title: title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), content, links, rawHtml: html };
}

function splitIntoChunks(content: string, documentId: string): DocumentChunkRecord[] {
  const size = 800;
  const overlap = 120;
  const chunks: DocumentChunkRecord[] = [];
  for (let start = 0; start < content.length; start += size - overlap) {
    const value = content.slice(start, start + size).trim();
    if (!value) continue;
    chunks.push({ id: `${documentId}-${chunks.length + 1}`, index: chunks.length, content: value, tokenEstimate: Math.ceil(value.length / 2) });
  }
  return chunks;
}

/** 在调用方事务内清洗并重新切片；旧切片与向量一并替换。 */
async function processDocument(tx: Executor, documentId: string) {
  const document = await lockDocument(tx, documentId);
  if (!document) throw new Error("document not found");
  const content = document.content.replace(/\s+/g, " ").trim();
  await replaceDocumentChunks(tx, documentId, content, splitIntoChunks(content, documentId));
}

async function embedDocument(documentId: string) {
  try {
    // 模型调用放在事务外；回写时用 processing_version 确认切片没有被重新生成。
    const { version, chunks } = await withTransaction(async (tx) => {
      const target = await lockDocument(tx, documentId);
      if (!target) throw new Error("Document no longer exists");
      const chunks = await listDocumentChunks(documentId, tx);
      if (target.processingStatus !== "chunked" || !chunks.length) throw new Error("Document must have chunks before embedding");
      await setEmbeddingState(documentId, "processing", null, tx);
      return { version: target.processingVersion, chunks };
    });
    const provider = selectEmbeddingProvider(await listModelProviders());
    const vectors = await embedChunks(provider, chunks.map((chunk) => chunk.content));
    await withTransaction(async (tx) => {
      const target = await lockDocument(tx, documentId);
      if (!target || target.processingStatus !== "chunked" || target.processingVersion !== version) {
        throw new Error("Document changed during embedding; retry after processing finishes");
      }
      await saveDocumentEmbeddings(tx, documentId, chunks, vectors, provider);
    });
  } catch (error) {
    await setEmbeddingState(documentId, "failed", errorMessage(error, "Embedding failed"));
    throw error;
  }
}

async function autoEmbedDocument(documentId: string) {
  const providers = await listModelProviders();
  if (!providers.some((provider) => provider.enabled && provider.isDefault && provider.embeddingModel.trim())) return;
  // An embedding failure remains retryable without discarding successfully crawled content.
  await embedDocument(documentId).catch(() => console.error(`Embedding failed for document ${documentId}`));
}

async function fetchHtml(url: string, userAgent: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs), headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" }, redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) throw new Error(`Non-HTML response at ${url}`);
  return { html: await response.text(), url: response.url || url };
}

async function crawl(source: DataSourceRecord, taskId: string) {
  if (source.kind !== "网页站点") throw new Error("文章 API 来源尚未配置 API 认证与文章标识，暂不支持采集");
  const baseUrl = new URL(source.url);
  if (!["http:", "https:"].includes(baseUrl.protocol)) throw new Error("Only HTTP and HTTPS sources are supported");
  const userAgent = "NYZ-RAG-Bot/1.0 (+contact site administrator)";
  const robotsUrl = new URL("/robots.txt", baseUrl);
  const robotsResponse = await fetch(robotsUrl, { signal: AbortSignal.timeout(requestTimeoutMs), headers: { "user-agent": userAgent } });
  if (robotsResponse.ok) {
    const robots = await robotsResponse.text();
    const blocked = robots.split(/\r?\n/).some((line) => /^\s*Disallow:\s*\/\s*$/i.test(line));
    if (blocked) throw new Error("robots.txt disallows crawling this site");
  } else if (robotsResponse.status !== 404 && robotsResponse.status !== 410) {
    throw new Error(`Unable to check robots.txt (HTTP ${robotsResponse.status})`);
  }

  const pending = [baseUrl.toString()];
  const visited = new Set<string>();
  let processed = 0;
  while (pending.length && processed < maxPages) {
    const url = pending.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    const { html, url: finalUrl } = await fetchHtml(url, userAgent);
    const page = extractPage(html, finalUrl);
    if (page.title && page.content) {
      const documentId = await withTransaction(async (tx) => {
        const id = await upsertDocument(tx, { sourceId: source.id, url: finalUrl, title: page.title, content: page.content, rawHtml: page.rawHtml, status: "ready" });
        await processDocument(tx, id);
        return id;
      });
      await autoEmbedDocument(documentId);
      processed += 1;
    }
    for (const link of page.links) if (!visited.has(link) && !pending.includes(link) && new URL(link).pathname === baseUrl.pathname) pending.push(link);
    await updateTask(taskId, { progress: Math.min(95, Math.round(processed / maxPages * 100)) });
    if (pending.length && processed < maxPages) await new Promise((resolveDelay) => setTimeout(resolveDelay, requestDelayMs));
  }
  if (!processed) throw new Error("No article content found; expected a page with a title and readable text");
  return processed;
}

async function reprocessDocument(documentId: string) {
  try {
    const chunks = await withTransaction(async (tx) => {
      await processDocument(tx, documentId);
      return (await listDocumentChunks(documentId, tx)).length;
    });
    await autoEmbedDocument(documentId);
    return chunks;
  } catch (error) {
    await setProcessingState(documentId, "failed", errorMessage(error, "Document processing failed"));
    throw error;
  }
}

async function syncSource(sourceId: string, taskId: string) {
  const [task, source] = await Promise.all([getTask(taskId), getSource(sourceId)]);
  if (!task || !source) throw new Error("source or task not found");
  await updateTask(taskId, { status: "运行中", progress: 0, error: null });
  try {
    const count = await crawl(source, taskId);
    await withTransaction(async (tx) => {
      await markSourceSynced(sourceId, tx);
      await updateTask(taskId, { status: "已完成", progress: 100 }, tx);
    });
    return count;
  } catch (error) {
    await updateTask(taskId, { status: "失败", error: errorMessage(error, "Unknown crawl error") });
    throw error;
  }
}

const queueName = process.env.DOCUMENT_QUEUE_NAME ?? "document-processing";
await migrate();
const worker = new Worker(queueName, async (job) => {
  if (job.name === "embed-document") {
    await embedDocument(job.data.documentId);
    return { status: "embedded", documentId: job.data.documentId };
  }
  if (job.name === "reprocess-document") {
    const chunks = await reprocessDocument(job.data.documentId);
    return { status: "chunked", documentId: job.data.documentId, chunks };
  }
  const count = await syncSource(job.data.sourceId, job.data.taskId);
  return { status: "ready", documentsProcessed: count };
}, { connection, concurrency: 1 });

worker.on("completed", (job) => console.info(`Job ${job.id} completed`));
worker.on("failed", (job, error) => console.error(`Job ${job?.id} failed`, error.message));

const shutdown = async () => { await worker.close(); await connection.quit(); await closeDatabase(); };
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
console.info(`NYZ RAG worker listening on ${queueName} queue`);
