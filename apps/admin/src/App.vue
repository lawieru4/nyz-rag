<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import type { AdminLoginRequest, AdminSession } from "@nyz-rag/types";
import { ConfirmDialog } from "@nyz-rag/ui/confirm";
import { Toaster } from "@nyz-rag/ui/components/sonner";
import { toast } from "@nyz-rag/ui/lib/toast";
import AdminLogin from "./AdminLogin.vue";
import { homePath, routeVisible } from "./router";
import { ApiError, can, client, errorMessage, loadKnowledge, permissions, resetKnowledge } from "./workspace";

const session = ref<AdminSession | null>(null);
const route = useRoute();
const router = useRouter();
const authChecking = ref(true);
const loginBusy = ref(false);
const loginError = ref("");

const routeAllowed = computed(() => !session.value || routeVisible(route.meta, session.value));
watch([session, routeAllowed], () => {
  if (session.value && !routeAllowed.value) void router.replace(homePath(session.value));
});

function setSession(value: AdminSession | null) {
  session.value = value;
  permissions.value = value?.permissions ?? [];
}

// 退出或会话失效时卸载工作区（各模块的数据与弹窗随之清空），并清空共用的数据源列表。
function resetWorkspace() {
  setSession(null);
  void router.replace("/sources");
  resetKnowledge();
}

client.onUnauthorized = () => {
  if (!session.value) return;
  resetWorkspace();
  loginError.value = "登录已失效，请重新登录";
};

function enterWorkspace(value: AdminSession) {
  setSession(value);
  loginError.value = "";
  // 数据源列表供数据源页与文档筛选使用。
  if (can("sources:view", "documents:view")) loadKnowledge().catch(() => { toast.error("数据源加载失败，请检查 API 服务"); });
}

async function restoreSession() {
  try {
    enterWorkspace(await client.request<AdminSession>("/api/admin/auth/session"));
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) loginError.value = errorMessage(err, "无法连接 API 服务");
  } finally {
    authChecking.value = false;
  }
}

async function login(username: string, password: string) {
  if (!username || !password) {
    loginError.value = "请输入邮箱/账号和密码";
    return;
  }
  loginBusy.value = true;
  loginError.value = "";
  try {
    enterWorkspace(await client.request<AdminSession>("/api/admin/auth/login", { method: "POST", body: JSON.stringify({ username, password } satisfies AdminLoginRequest) }));
  } catch (err) {
    loginError.value = errorMessage(err, "无法连接 API 服务");
  } finally {
    loginBusy.value = false;
  }
}

async function logout() {
  try {
    await client.request("/api/admin/auth/logout", { method: "POST" });
  } catch (err) {
    // 401 表示会话已失效，onUnauthorized 已切回登录页。
    if (!(err instanceof ApiError && err.status === 401)) toast.error(errorMessage(err, "退出失败，请检查 API 服务"));
    return;
  }
  resetWorkspace();
}

// ProfileView 事件：profile 更新后同步 session；密码修改后强制重新登录
function handleSessionUpdated(updated: AdminSession) {
  setSession(updated);
}

function handleLogoutRequired() {
  resetWorkspace();
  loginError.value = "密码已修改，请重新登录";
}

onMounted(restoreSession);
</script>

<template>
  <AdminLogin v-if="!session" :error="loginError" :busy="authChecking || loginBusy" @submit="login" />
  <RouterView v-else v-slot="{ Component }">
    <component
      :is="Component"
      :session="session"
      :route-allowed="routeAllowed"
      @logout="logout"
      @session-updated="handleSessionUpdated"
      @logout-required="handleLogoutRequired"
    />
  </RouterView>
  <Toaster rich-colors close-button />
  <ConfirmDialog />
</template>
