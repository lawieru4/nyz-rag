import { createRouter, createWebHistory, type RouteMeta } from "vue-router";
import type { AdminPermission, AdminSession } from "@nyz-rag/types";
import AdminLayout from "./components/AdminLayout.vue";
import AdminsView from "./views/AdminsView.vue";
import AuditLogsView from "./views/AuditLogsView.vue";
import ChatLogsView from "./views/ChatLogsView.vue";
import ChatStatsView from "./views/ChatStatsView.vue";
import DocumentsView from "./views/DocumentsView.vue";
import KnowledgeBasesView from "./views/KnowledgeBasesView.vue";
import ModelProvidersView from "./views/ModelProvidersView.vue";
import ProfileView from "./views/ProfileView.vue";
import RolesView from "./views/RolesView.vue";
import SourcesView from "./views/SourcesView.vue";
import UsersView from "./views/UsersView.vue";

declare module "vue-router" {
  interface RouteMeta {
    /** 仅超级管理员可见。 */
    superOnly?: boolean;
    /** 具备其中任一权限才可见；未设置则所有已登录管理员可见。 */
    permission?: AdminPermission[];
  }
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: "/",
      component: AdminLayout,
      children: [
        { path: "", redirect: "/sources" },
        { path: "sources", name: "数据源", component: SourcesView, meta: { permission: ["sources:view"] } },
        { path: "documents", name: "文档管理", component: DocumentsView, meta: { permission: ["documents:view"] } },
        { path: "knowledge-bases", name: "知识库", component: KnowledgeBasesView, meta: { permission: ["knowledge-bases:view"] } },
        { path: "chat-logs", name: "问答记录", component: ChatLogsView, meta: { permission: ["chat-logs:view"] } },
        { path: "chat-stats", name: "问答统计", component: ChatStatsView, meta: { permission: ["chat-logs:view"] } },
        { path: "users", name: "用户管理", component: UsersView, meta: { permission: ["users:view"] } },
        { path: "model-providers", name: "模型配置", component: ModelProvidersView, meta: { permission: ["models:view"] } },
        { path: "admins", name: "管理员管理", component: AdminsView, meta: { superOnly: true } },
        { path: "roles", name: "角色管理", component: RolesView, meta: { superOnly: true } },
        { path: "audit-logs", name: "操作日志", component: AuditLogsView, meta: { permission: ["audit-logs:view"] } },
        { path: "profile", name: "个人资料", component: ProfileView },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/sources" },
  ],
});

/** 当前管理员能否进入该页面。 */
export function routeVisible(meta: RouteMeta, session: AdminSession): boolean {
  if (meta.superOnly) return session.admin.isSuper;
  return !meta.permission || meta.permission.some((permission) => session.permissions.includes(permission));
}

/** 当前管理员可进入的第一个模块（没有任何模块权限时为个人资料）。 */
export function homePath(session: AdminSession): string {
  const layout = router.options.routes[0]!;
  const first = layout.children!.find((child) => child.name && routeVisible(child.meta ?? {}, session));
  return `/${first?.path ?? "profile"}`;
}
