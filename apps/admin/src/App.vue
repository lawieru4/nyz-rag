<script setup lang="ts">
import { computed, onMounted, ref, watch, type Component } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { Database, FileText, Library, LogOut, MessagesSquare, Settings2, Shield, User, Users } from "@lucide/vue";
import type { AdminSession } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { ConfirmDialog } from "@nyz-rag/ui/confirm";
import { Toaster } from "@nyz-rag/ui/components/sonner";
import { toast } from "@nyz-rag/ui/lib/toast";
import AdminLogin from "./AdminLogin.vue";
import { ApiError, client, errorMessage, loadKnowledge, resetKnowledge, sources } from "./workspace";

const allModules: Array<{ name: string; icon: Component; superOnly?: boolean }> = [
  { name: "数据源", icon: Database },
  { name: "文档管理", icon: FileText },
  { name: "知识库", icon: Library },
  { name: "问答记录", icon: MessagesSquare },
  { name: "用户管理", icon: Users },
  { name: "模型配置", icon: Settings2 },
  { name: "管理员管理", icon: Shield, superOnly: true },
];

const PROFILE_MODULE = "个人资料";
const isDev = import.meta.env.DEV;

const session = ref<AdminSession | null>(null);
const route = useRoute();
const router = useRouter();
const activeModule = computed(() => String(route.name ?? "数据源"));
// 再次点击当前模块时重新挂载视图，即重新加载数据。
const viewKey = ref(0);
const authChecking = ref(true);
const loginBusy = ref(false);
const loginError = ref("");

const isSuper = computed(() => session.value?.admin.isSuper ?? false);
const modules = computed(() => allModules.filter((m) => !m.superOnly || isSuper.value));

const routeAllowed = computed(() => !route.meta.superOnly || isSuper.value);
watch([session, routeAllowed], () => {
  if (session.value && !routeAllowed.value) void router.replace("/sources");
});

function select(event: MouseEvent, name: string) {
  if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0 && name === activeModule.value) viewKey.value++;
}

// 退出或会话失效时卸载工作区（各模块的数据与弹窗随之清空），并清空共用的数据源列表。
function resetWorkspace() {
  session.value = null;
  void router.replace("/sources");
  resetKnowledge();
}

client.onUnauthorized = () => {
  if (!session.value) return;
  resetWorkspace();
  loginError.value = "登录已失效，请重新登录";
};

function enterWorkspace(value: AdminSession) {
  session.value = value;
  loginError.value = "";
  loadKnowledge().catch(() => { toast.error("数据源加载失败，请检查 API 服务"); });
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
    enterWorkspace(await client.request<AdminSession>("/api/admin/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }));
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
  session.value = updated;
}

function handleLogoutRequired() {
  resetWorkspace();
  loginError.value = "密码已修改，请重新登录";
}

onMounted(restoreSession);
</script>

<template>
  <AdminLogin v-if="!session" :error="loginError" :busy="authChecking || loginBusy" @submit="login" />
  <div v-else class="min-h-screen">
    <aside class="fixed inset-y-0 left-0 z-10 flex w-58 flex-col bg-sidebar px-3.5 pt-6 pb-3.5 text-sidebar-foreground max-lg:w-48 max-md:w-14 max-md:px-2">
      <RouterLink class="flex items-center gap-2.5 px-2 text-sm font-bold text-sidebar-accent-foreground max-md:px-1" to="/sources">
        <span class="grid size-7 flex-none place-items-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">N</span>
        <span class="max-md:hidden">NYZ <b class="mt-0.5 block font-mono text-[9px] font-medium text-sidebar-foreground/70">KNOWLEDGE OPS</b></span>
      </RouterLink>
      <div class="mx-2.5 mt-11 mb-3 font-mono text-[10px] font-medium text-sidebar-foreground/70 uppercase max-md:hidden">工作空间</div>
      <nav class="grid gap-1 max-md:mt-9" aria-label="管理模块">
        <RouterLink
          v-for="item in modules"
          :key="item.name"
          :class="['flex h-10 items-center gap-3 rounded-md px-3 text-left text-[13px] transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground max-md:justify-center max-md:px-0', activeModule === item.name && 'bg-sidebar-accent text-sidebar-accent-foreground']"
          :title="item.name"
          :aria-current="activeModule === item.name ? 'page' : undefined"
          :to="{ name: item.name }"
          @click="select($event, item.name)"
        >
          <component :is="item.icon" :class="['size-4 flex-none', activeModule === item.name ? 'text-sidebar-primary' : 'text-sidebar-foreground/80']" />
          <span class="max-md:sr-only">{{ item.name }}</span>
          <span v-if="item.name === '数据源'" class="ml-auto font-mono text-[11px] max-md:hidden">{{ sources.length }}</span>
        </RouterLink>
      </nav>
      <div class="mt-auto flex items-center gap-2.5 border-t border-sidebar-border px-1.5 pt-4 pb-1 max-md:flex-col max-md:justify-center max-md:px-0">
        <RouterLink
          class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-sidebar-accent/60 max-md:justify-center"
          title="个人资料"
          :aria-current="activeModule === PROFILE_MODULE ? 'page' : undefined"
          :to="{ name: PROFILE_MODULE }"
          @click="select($event, PROFILE_MODULE)"
        >
          <span class="grid size-7.5 flex-none place-items-center rounded-full bg-[#53634f] font-mono text-[11px] text-[#e5edda]"><User class="size-3.5" /></span>
          <span class="grid min-w-0 gap-0.5 text-[11px] max-md:hidden">
            <b class="truncate text-sidebar-accent-foreground">{{ session.admin.nickname }}</b>
            <small class="text-[10px] text-sidebar-foreground/70">{{ session.admin.isSuper ? '超级管理员' : '管理员' }}</small>
          </span>
        </RouterLink>
        <Button variant="ghost" size="icon-sm" class="ml-auto flex-none text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground max-md:ml-0" title="退出登录" aria-label="退出登录" @click="logout"><LogOut /></Button>
      </div>
    </aside>

    <main class="ml-58 min-h-screen max-lg:ml-48 max-md:ml-14">
      <header class="flex h-14 items-center justify-between border-b bg-card px-9 max-lg:px-6 max-md:px-4">
        <div class="text-xs text-muted-foreground">管理后台 <span class="px-2 text-muted-foreground/50">/</span> {{ activeModule }}</div>
        <span v-if="isDev" class="flex items-center gap-1.5 text-[11px] text-muted-foreground"><i class="size-1.5 rounded-full bg-success" />开发环境</span>
      </header>
      <div class="mx-auto max-w-330 px-10 pt-9 pb-7 max-lg:px-6 max-md:px-4">
        <RouterView v-if="routeAllowed" v-slot="{ Component }">
          <component
            :is="Component"
            :key="`${route.path}-${viewKey}`"
            v-bind="activeModule === PROFILE_MODULE ? { session } : activeModule === '数据源' ? { title: activeModule } : {}"
            @session-updated="handleSessionUpdated"
            @logout-required="handleLogoutRequired"
          />
        </RouterView>
      </div>
    </main>
  </div>
  <Toaster rich-colors close-button />
  <ConfirmDialog />
</template>
