import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { lock } from "proper-lockfile";
import type { KnowledgeStoreSnapshot } from "@nyz-rag/types";

const storePath = () => resolve(process.env.NYZ_STORE_PATH ?? "../../.nyz-data/knowledge.json");

async function load(path: string): Promise<KnowledgeStoreSnapshot> {
  let snapshot: Partial<KnowledgeStoreSnapshot>;
  try {
    snapshot = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    snapshot = {};
  }
  return {
    ...snapshot,
    sources: snapshot.sources ?? [], tasks: snapshot.tasks ?? [],
    knowledgeBases: snapshot.knowledgeBases ?? [], chatLogs: snapshot.chatLogs ?? [], modelProviders: snapshot.modelProviders ?? [],
    documents: (snapshot.documents ?? []).map((document) => ({
      ...document,
      processingStatus: document.processingStatus ?? (document.status === "ready" ? "chunked" : "pending"),
      chunks: document.chunks ?? [],
      embedding: document.embedding ?? { status: "pending", chunkCount: 0 },
    })),
    stats: snapshot.stats ?? { documents: 0, sources: 0, processingTasks: 0, lastUpdated: null },
  };
}

export async function readSnapshot(): Promise<KnowledgeStoreSnapshot> {
  return load(storePath());
}

export async function updateSnapshot(mutator: (snapshot: KnowledgeStoreSnapshot) => void | Promise<void>): Promise<KnowledgeStoreSnapshot> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  // API and worker share a file. Lock read/modify/write and publish with an atomic rename.
  const release = await lock(path, { realpath: false, retries: { retries: 100, minTimeout: 50, maxTimeout: 100 }, stale: 30000 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const snapshot = await load(path);
    await mutator(snapshot);
    snapshot.stats = {
      documents: snapshot.documents.filter((document) => document.status === "ready").length,
      sources: snapshot.sources.length,
      processingTasks: snapshot.tasks.filter((task) => task.status === "等待中" || task.status === "运行中").length,
      lastUpdated: snapshot.documents.reduce<string | null>((latest, document) => !latest || document.updatedAt > latest ? document.updatedAt : latest, null),
    };
    await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2));
    await rename(temporaryPath, path);
    return snapshot;
  } finally {
    try {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    } finally {
      await release();
    }
  }
}
