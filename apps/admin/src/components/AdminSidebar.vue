<script setup lang="ts">
import { computed, type Component } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { ChartColumn, Database, FileText, KeyRound, Library, LogOut, MessagesSquare, ScrollText, Settings2, Shield, User, Users } from "@lucide/vue";
import type { AdminSession } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { homePath, routeVisible } from "../router";

// drawer：手机端在抽屉中显示（由抽屉负责定位与背景），否则为平板及桌面的常驻侧栏。
const props = defineProps<{ session: AdminSession; activeModule: string; sourceCount: number; drawer?: boolean }>();
const emit = defineEmits<{
  (e: "select", event: MouseEvent, name: string): void;
  (e: "logout"): void;
}>();

const router = useRouter();
const allModules: Array<{ name: string; icon: Component }> = [
  { name: "数据源", icon: Database },
  { name: "文档管理", icon: FileText },
  { name: "知识库", icon: Library },
  { name: "问答记录", icon: MessagesSquare },
  { name: "问答统计", icon: ChartColumn },
  { name: "用户管理", icon: Users },
  { name: "模型配置", icon: Settings2 },
  { name: "管理员管理", icon: Shield },
  { name: "角色管理", icon: KeyRound },
  { name: "操作日志", icon: ScrollText },
];
const PROFILE_MODULE = "个人资料";
// 可见性由路由的 meta（权限或仅超级管理员）决定，与 App.vue 的路由守卫一致。
const modules = computed(() => allModules.filter((m) => routeVisible(router.resolve({ name: m.name }).meta, props.session)));
const roleLabel = computed(() => props.session.admin.isSuper ? "超级管理员" : props.session.admin.roleName ?? "未分配角色");
</script>

<template>
  <aside :class="['flex min-h-0 flex-col gap-6 px-3 pt-6 pb-3', drawer ? 'h-full' : 'fixed inset-y-0 left-0 z-10 w-58 bg-sidebar text-sidebar-foreground max-lg:w-48 max-md:hidden']">
    <RouterLink class="flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-bold text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring" :to="homePath(session)" aria-label="能知管理后台" @click="emit('select', $event, '')">
      <img src="/logo_t.png" alt="能知" class="h-10 w-30 flex-none object-contain max-lg:w-22" />
      <span class="shrink-0 text-xs leading-5 font-medium text-sidebar-foreground">管理后台</span>
    </RouterLink>
    <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div class="shrink-0 px-3 text-xs leading-5 font-medium tracking-wider text-sidebar-foreground">工作空间</div>
    <nav class="grid min-h-0 content-start gap-1 overflow-y-auto" aria-label="管理模块">
      <RouterLink
        v-for="item in modules"
        :key="item.name"
        :class="['flex min-h-11 flex-none items-center gap-2 rounded-md px-3 py-3 text-left text-sm leading-5 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring', activeModule === item.name && 'bg-sidebar-accent text-sidebar-accent-foreground']"
        :title="item.name"
        :aria-current="activeModule === item.name ? 'page' : undefined"
        :to="{ name: item.name }"
        @click="emit('select', $event, item.name)"
      >
        <component :is="item.icon" :class="['size-3 flex-none', activeModule === item.name ? 'text-sidebar-primary' : 'text-sidebar-foreground/80']" />
        <span class="min-w-0 break-words">{{ item.name }}</span>
        <span v-if="item.name === '数据源'" class="ml-auto shrink-0 font-mono text-xs leading-5 tabular-nums">{{ sourceCount }}</span>
      </RouterLink>
    </nav>
    </div>
    <div class="flex shrink-0 items-center gap-2 border-t border-sidebar-border pt-3">
      <RouterLink
        class="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring"
        title="个人资料"
        :aria-current="activeModule === PROFILE_MODULE ? 'page' : undefined"
        :to="{ name: PROFILE_MODULE }"
        @click="emit('select', $event, PROFILE_MODULE)"
      >
        <span class="grid size-7 flex-none place-items-center rounded-full bg-sidebar-accent text-sidebar-accent-foreground"><User class="size-3" /></span>
        <span class="grid min-w-0 text-sm leading-5">
          <b class="truncate text-sidebar-accent-foreground" :title="session.admin.nickname">{{ session.admin.nickname }}</b>
          <small class="truncate text-xs leading-5 text-sidebar-foreground" :title="roleLabel">{{ roleLabel }}</small>
        </span>
      </RouterLink>
      <Button variant="ghost" size="icon" class="size-11 flex-none rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" title="退出登录" aria-label="退出登录" @click="emit('logout')"><LogOut class="size-3" /></Button>
    </div>
  </aside>
</template>
