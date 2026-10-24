import { ref } from "vue";
import type { AdminPermission, KnowledgeOverview } from "@nyz-rag/types";
import { AdminApiClient, ApiError } from "./adminClient";

export { ApiError };
export { errorMessage } from "@nyz-rag/api-client";

export type Source = { id: string; name: string; url: string; kind: string; frequency: string; status: "运行中" | "已暂停"; pages: number; remoteTotal: number | null; backfillDone: boolean; failedCount: number; updated: string; syncedAt: string | null };
export type Task = {
  id: string; sourceId: string; source: string; status: "已完成" | "运行中" | "等待中" | "失败"; progress: number;
  processedCount: number; failedCount: number; articleLimit?: number; started: string; error?: string;
};

export const client = new AdminApiClient(import.meta.env.VITE_API_URL ?? "http://localhost:3000");
export const pageSize = 10;

/**
 * 当前管理员生效的权限（超级管理员为全部），随会话设置与清空。
 * 界面据此隐藏无权执行的操作；服务端仍对每个请求单独校验。
 */
export const permissions = ref<readonly AdminPermission[]>([]);
/** 是否具备其中任一权限。 */
export const can = (...required: AdminPermission[]) => required.some((permission) => permissions.value.includes(permission));

/** 数据源与任务由多个模块共用（文档筛选、来源名称），退出登录时清空。 */
export const sources = ref<Source[]>([]);
export const tasks = ref<Task[]>([]);

function applyKnowledge(data: KnowledgeOverview) {
  sources.value = data.sources.map((source) => ({ ...source, pages: source.documentCount, syncedAt: source.updatedAt, updated: source.updatedAt ? new Date(source.updatedAt).toLocaleString() : "尚未同步" }));
  tasks.value = data.tasks.map(({ sourceName, createdAt, ...task }) => ({ ...task, source: sourceName, started: new Date(createdAt).toLocaleString() }));
}

export async function loadKnowledge() {
  applyKnowledge(await client.request<KnowledgeOverview>("/api/admin/knowledge"));
}

/**
 * 订阅数据源与同步任务的实时推送（SSE），返回取消订阅函数。
 * 服务端定期断开连接，浏览器自动重连；连接被拒绝（如登录失效）时改用普通请求，由 401 处理切回登录页，稍后再重连。
 */
export function watchKnowledge(): () => void {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const connect = () => {
    source = new EventSource(`${client.baseUrl}/api/admin/knowledge/events`, { withCredentials: true });
    source.addEventListener("overview", (event) => applyKnowledge(JSON.parse((event as MessageEvent<string>).data)));
    source.onerror = () => {
      if (source?.readyState !== EventSource.CLOSED || stopped) return;
      loadKnowledge().catch(() => {});
      retry = setTimeout(connect, 10_000);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    source?.close();
  };
}

export function resetKnowledge() {
  sources.value = [];
  tasks.value = [];
}

export function sourceName(id: string | undefined) {
  return sources.value.find((source) => source.id === id)?.name ?? "未知数据源";
}
