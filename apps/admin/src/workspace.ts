import { ref } from "vue";
import { AdminApiClient, ApiError } from "./adminClient";

export { ApiError };

export type Source = { id: string; name: string; url: string; kind: string; frequency: string; status: "运行中" | "已暂停"; pages: number; updated: string };
export type Task = { id: string; source: string; status: "已完成" | "运行中" | "等待中" | "失败"; progress: number; started: string; error?: string };

export const client = new AdminApiClient(import.meta.env.VITE_API_URL ?? "http://localhost:3000");
export const pageSize = 10;

/** 数据源与任务由多个模块共用（文档筛选、来源名称），退出登录时清空。 */
export const sources = ref<Source[]>([]);
export const tasks = ref<Task[]>([]);

export async function loadKnowledge() {
  const data = await client.request<{
    sources: Array<{ id: string; name: string; url: string; kind: string; frequency: string; status: Source["status"]; documentCount: number; updatedAt: string | null }>;
    tasks: Array<{ id: string; sourceName: string; status: Task["status"]; progress: number; createdAt: string; error?: string }>;
  }>("/api/admin/knowledge");
  sources.value = data.sources.map((source) => ({ ...source, pages: source.documentCount, updated: source.updatedAt ? new Date(source.updatedAt).toLocaleString() : "尚未同步" }));
  tasks.value = data.tasks.map((task) => ({ id: task.id, source: task.sourceName, status: task.status, progress: task.progress, started: new Date(task.createdAt).toLocaleString(), error: task.error }));
}

export function resetKnowledge() {
  sources.value = [];
  tasks.value = [];
}

export function sourceName(id: string | undefined) {
  return sources.value.find((source) => source.id === id)?.name ?? "未知数据源";
}

export function errorMessage(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}
