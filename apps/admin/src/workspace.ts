import { ref } from "vue";
import type { AdminPermission, KnowledgeOverview } from "@nyz-rag/types";
import { toast } from "@nyz-rag/ui/lib/toast";
import { AdminApiClient, ApiError } from "./adminClient";
import { createKnowledgeOverview } from "./knowledge-overview";

export { ApiError };
export type { Source, Task } from "./knowledge-overview";
export { errorMessage } from "@nyz-rag/api-client";

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
const overview = createKnowledgeOverview((signal) => client.request<KnowledgeOverview>("/api/admin/knowledge", { signal }));
export const { sources, tasks } = overview;
export const loadKnowledge = overview.load;
export const resetKnowledge = overview.reset;

/**
 * 订阅数据源与同步任务的实时推送（SSE），返回取消订阅函数。
 * 服务端定期断开连接，浏览器自动重连；连接被拒绝（如登录失效）时改用普通请求，由 401 处理切回登录页，稍后再重连。
 */
export function watchKnowledge(): () => void {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const generation = overview.generation();
  const connect = () => {
    source = new EventSource(`${client.baseUrl}/api/admin/knowledge/events`, { withCredentials: true });
    source.addEventListener("overview", (event) => { if (!stopped) overview.applySnapshot((event as MessageEvent<string>).data, generation); });
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

/** 写入成功后刷新列表；刷新失败单独提示，不当作写入失败，避免重复提交。 */
export async function refreshAfterWrite(refresh: () => Promise<unknown>) {
  try {
    await refresh();
  } catch {
    toast.error("操作已完成，但列表刷新失败，请稍后刷新页面");
  }
}

export function sourceName(id: string | undefined) {
  return sources.value.find((source) => source.id === id)?.name ?? "未知数据源";
}
