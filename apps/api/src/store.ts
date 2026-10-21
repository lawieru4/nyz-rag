import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DataSourceRecord, DocumentRecord, KnowledgeSnapshot, CrawlTaskRecord, KnowledgeBaseRecord } from "@nyz-rag/types";

const storePath = resolve(process.env.NYZ_STORE_PATH ?? "../../.nyz-data/knowledge.json");
type StoreSnapshot = KnowledgeSnapshot & { knowledgeBases: KnowledgeBaseRecord[] };
const seed: StoreSnapshot = { sources: [], documents: [], tasks: [], knowledgeBases: [], stats: { documents: 0, sources: 0, processingTasks: 0, lastUpdated: null } };

async function persist(snapshot: KnowledgeSnapshot) {
  snapshot.stats = {
    documents: snapshot.documents.filter((document) => document.status === "ready").length,
    sources: snapshot.sources.length,
    processingTasks: snapshot.tasks.filter((task) => task.status === "等待中" || task.status === "运行中").length,
    lastUpdated: snapshot.documents.reduce<string | null>((latest, document) => (!latest || document.updatedAt > latest ? document.updatedAt : latest), null),
  };
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(snapshot, null, 2));
}

export async function readStore(): Promise<StoreSnapshot> {
  try {
    const snapshot = JSON.parse(await readFile(storePath, "utf8")) as Partial<StoreSnapshot>;
    return { ...structuredClone(seed), ...snapshot, knowledgeBases: snapshot.knowledgeBases ?? [] };
  } catch {
    await persist(structuredClone(seed));
    return structuredClone(seed);
  }
}

export async function updateStore(mutator: (snapshot: StoreSnapshot) => void) {
  const snapshot = await readStore();
  mutator(snapshot);
  await persist(snapshot);
  return snapshot;
}

export type StoreEntities = { source: DataSourceRecord; document: DocumentRecord; task: CrawlTaskRecord };
