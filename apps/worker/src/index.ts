import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CrawlTaskRecord, DataSourceRecord, DocumentChunkRecord, DocumentRecord, KnowledgeSnapshot } from "@nyz-rag/types";

const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const storePath = resolve(process.env.NYZ_STORE_PATH ?? "../../.nyz-data/knowledge.json");
const maxPages = Math.max(1, Math.min(100, Number.parseInt(process.env.CRAWL_MAX_PAGES ?? "20", 10) || 20));
const requestDelayMs = Math.max(1000, Number.parseInt(process.env.CRAWL_REQUEST_DELAY_MS ?? "1000", 10) || 1000);
const requestTimeoutMs = Math.max(1000, Number.parseInt(process.env.CRAWL_REQUEST_TIMEOUT_MS ?? "15000", 10) || 15000);

async function loadSnapshot() {
  return JSON.parse(await readFile(storePath, "utf8")) as KnowledgeSnapshot;
}

async function saveSnapshot(snapshot: KnowledgeSnapshot) {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(snapshot, null, 2));
}

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

async function processDocument(document: DocumentRecord) {
  document.processingStatus = "cleaning";
  delete document.processingError;
  document.content = document.content.replace(/\s+/g, " ").trim();
  document.processingStatus = "chunked";
  document.chunks = splitIntoChunks(document.content, document.id);
  document.updatedAt = new Date().toISOString();
}

async function fetchHtml(url: string, userAgent: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs), headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" }, redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`);
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) throw new Error(`Non-HTML response at ${url}`);
  return { html: await response.text(), url: response.url || url };
}

async function crawl(source: DataSourceRecord, task: CrawlTaskRecord, snapshot: KnowledgeSnapshot) {
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
      const now = new Date().toISOString();
      const existing = snapshot.documents.find((document) => document.sourceId === source.id && document.url === finalUrl);
       const document: DocumentRecord = existing ?? { id: crypto.randomUUID(), sourceId: source.id, title: page.title, url: finalUrl, content: page.content, rawHtml: page.rawHtml, processingStatus: "pending", chunks: [], status: "ready", createdAt: now, updatedAt: now };
       Object.assign(document, { title: page.title, content: page.content, rawHtml: page.rawHtml, status: "ready" as const, processingStatus: "pending" as const, updatedAt: now });
       await processDocument(document);
      if (!existing) snapshot.documents.unshift(document);
      processed += 1;
    }
    for (const link of page.links) if (!visited.has(link) && !pending.includes(link) && new URL(link).pathname === baseUrl.pathname) pending.push(link);
    task.progress = Math.min(95, Math.round(processed / maxPages * 100));
    await saveSnapshot(snapshot);
    if (pending.length && processed < maxPages) await new Promise((resolveDelay) => setTimeout(resolveDelay, requestDelayMs));
  }
  if (!processed) throw new Error("No article content found; expected a page with a title and readable text");
  return processed;
}

const worker = new Worker("document-processing", async (job) => {
  const snapshot = await loadSnapshot();
  if (job.name === "reprocess-document") {
    const document = snapshot.documents.find((item) => item.id === job.data.documentId);
    if (!document) throw new Error("document not found");
    try {
      await processDocument(document);
      await saveSnapshot(snapshot);
      return { status: "chunked", documentId: document.id, chunks: document.chunks?.length ?? 0 };
    } catch (error) {
      document.processingStatus = "failed";
      document.processingError = error instanceof Error ? error.message.slice(0, 500) : "Document processing failed";
      await saveSnapshot(snapshot);
      throw error;
    }
  }
  const task = snapshot.tasks.find((item) => item.id === job.data.taskId);
  const source = snapshot.sources.find((item) => item.id === job.data.sourceId);
  if (!task || !source) throw new Error("source or task not found");
  task.status = "运行中";
  task.progress = 0;
  delete task.error;
  await saveSnapshot(snapshot);
  try {
    const count = await crawl(source, task, snapshot);
    const now = new Date().toISOString();
    source.documentCount = snapshot.documents.filter((document) => document.sourceId === source.id && document.status === "ready").length;
    source.updatedAt = now;
    task.status = "已完成";
    task.progress = 100;
    await saveSnapshot(snapshot);
    return { status: "ready", documentsProcessed: count };
  } catch (error) {
    task.status = "失败";
    task.error = error instanceof Error ? error.message.slice(0, 500) : "Unknown crawl error";
    await saveSnapshot(snapshot);
    throw error;
  }
}, { connection, concurrency: 1 });

worker.on("completed", (job) => console.info(`Job ${job.id} completed`));
worker.on("failed", (job, error) => console.error(`Job ${job?.id} failed`, error.message));

const shutdown = async () => { await worker.close(); await connection.quit(); };
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
console.info("NYZ RAG worker listening on document-processing queue");
