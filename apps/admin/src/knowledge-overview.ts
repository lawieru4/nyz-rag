import { ref } from "vue";
import type { KnowledgeOverview, OperationBacklog } from "@nyz-rag/types";

export type Source = { id: string; name: string; url: string; kind: string; frequency: string; status: "运行中" | "已暂停"; pages: number; remoteTotal: number | null; backfillDone: boolean; failedCount: number; updated: string; syncedAt: string | null };
export type Task = {
  id: string; sourceId: string; source: string; status: "已完成" | "运行中" | "等待中" | "失败"; progress: number;
  processedCount: number; failedCount: number; articleLimit?: number; started: string; error?: string;
};

/**
 * 数据源与同步任务概览，由普通请求和 SSE 推送共同写入。
 * - 每次推送都是完整快照：请求发出后若收到过推送，请求结果已过时，丢弃。
 * - 只采用最近一次请求的结果；退出登录（reset）后旧请求与旧推送都不再写入。
 */
export function createKnowledgeOverview(fetchOverview: (signal: AbortSignal) => Promise<KnowledgeOverview>) {
  const sources = ref<Source[]>([]);
  const tasks = ref<Task[]>([]);
  const operations = ref<OperationBacklog | null>(null);
  let generation = 0;
  let snapshots = 0;
  let request: AbortController | undefined;

  function apply(data: KnowledgeOverview) {
    sources.value = data.sources.map((source) => ({ ...source, pages: source.documentCount, syncedAt: source.updatedAt, updated: source.updatedAt ? new Date(source.updatedAt).toLocaleString() : "尚未同步" }));
    tasks.value = data.tasks.map(({ sourceName, createdAt, ...task }) => ({ ...task, source: sourceName, started: new Date(createdAt).toLocaleString() }));
    // 升级前的 API 不返回积压。
    operations.value = data.operations ?? null;
  }

  /** 读取概览；被更新的请求、推送或退出取代时静默结束，只有当前请求失败才抛出。 */
  async function load() {
    request?.abort();
    const current = new AbortController();
    request = current;
    const started = { generation, snapshots };
    try {
      const data = await fetchOverview(current.signal);
      if (request === current && started.generation === generation && started.snapshots === snapshots) apply(data);
    } catch (error) {
      if (request === current && started.generation === generation) throw error;
    } finally {
      if (request === current) request = undefined;
    }
  }

  /** 推送的快照（JSON 文本）；格式错误时忽略，等待下一次推送。返回是否已应用。 */
  function applySnapshot(raw: string, watchGeneration: number) {
    if (watchGeneration !== generation) return false;
    let data: KnowledgeOverview;
    try {
      data = JSON.parse(raw) as KnowledgeOverview;
      if (!Array.isArray(data?.sources) || !Array.isArray(data?.tasks)) return false;
    } catch {
      return false;
    }
    snapshots++;
    apply(data);
    return true;
  }

  function reset() {
    generation++;
    request?.abort();
    request = undefined;
    sources.value = [];
    tasks.value = [];
    operations.value = null;
  }

  return { sources, tasks, operations, load, applySnapshot, reset, generation: () => generation };
}
