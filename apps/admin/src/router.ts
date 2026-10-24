import { createRouter, createWebHistory } from "vue-router";
import AdminLayout from "./components/AdminLayout.vue";
import AdminsView from "./views/AdminsView.vue";
import ChatLogsView from "./views/ChatLogsView.vue";
import DocumentsView from "./views/DocumentsView.vue";
import KnowledgeBasesView from "./views/KnowledgeBasesView.vue";
import ModelProvidersView from "./views/ModelProvidersView.vue";
import ProfileView from "./views/ProfileView.vue";
import SourcesView from "./views/SourcesView.vue";
import UsersView from "./views/UsersView.vue";

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: "/",
      component: AdminLayout,
      children: [
        { path: "", redirect: "/sources" },
        { path: "sources", name: "数据源", component: SourcesView },
        { path: "documents", name: "文档管理", component: DocumentsView },
        { path: "knowledge-bases", name: "知识库", component: KnowledgeBasesView },
        { path: "chat-logs", name: "问答记录", component: ChatLogsView },
        { path: "users", name: "用户管理", component: UsersView },
        { path: "model-providers", name: "模型配置", component: ModelProvidersView },
        { path: "admins", name: "管理员管理", component: AdminsView, meta: { superOnly: true } },
        { path: "profile", name: "个人资料", component: ProfileView },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/sources" },
  ],
});
