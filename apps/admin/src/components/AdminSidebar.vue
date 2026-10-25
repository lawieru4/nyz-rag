<script setup lang="ts">
import { computed, type Component } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { Database, FileText, KeyRound, Library, LogOut, MessagesSquare, ScrollText, Settings2, Shield, User, Users } from "@lucide/vue";
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
  <aside :class="['flex flex-col px-3.5 pt-6 pb-3.5', drawer ? 'h-full' : 'fixed inset-y-0 left-0 z-10 w-58 bg-sidebar text-sidebar-foreground max-lg:w-48 max-md:hidden']">
    <RouterLink class="flex items-center gap-1 px-2 text-sm font-bold text-sidebar-accent-foreground" :to="homePath(session)" aria-label="能知管理后台" @click="emit('select', $event, '')">
      <img src="/logo_t.png" alt="能知" class="h-10 w-30 flex-none object-contain max-lg:w-24" />
      <span class="text-[11px] font-medium text-sidebar-foreground">管理后台</span>
    </RouterLink>
    <div :class="['mx-2.5 mb-3 text-[11px] font-medium tracking-wider text-sidebar-foreground', drawer ? 'mt-8' : 'mt-11']">工作空间</div>
    <nav class="-mx-1 grid min-h-0 content-start gap-1 overflow-y-auto px-1" aria-label="管理模块">
      <RouterLink
        v-for="item in modules"
        :key="item.name"
        :class="['flex flex-none items-center gap-3 rounded-md px-3 text-left text-[13px] transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground', drawer ? 'h-11' : 'h-10', activeModule === item.name && 'bg-sidebar-accent text-sidebar-accent-foreground']"
        :title="item.name"
        :aria-current="activeModule === item.name ? 'page' : undefined"
        :to="{ name: item.name }"
        @click="emit('select', $event, item.name)"
      >
        <component :is="item.icon" :class="['size-4 flex-none', activeModule === item.name ? 'text-sidebar-primary' : 'text-sidebar-foreground/80']" />
        <span>{{ item.name }}</span>
        <span v-if="item.name === '数据源'" class="ml-auto font-mono text-[11px]">{{ sourceCount }}</span>
      </RouterLink>
    </nav>
    <div class="mt-auto flex items-center gap-2.5 border-t border-sidebar-border px-1.5 pt-4 pb-1">
      <RouterLink
        class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-sidebar-accent/60"
        title="个人资料"
        :aria-current="activeModule === PROFILE_MODULE ? 'page' : undefined"
        :to="{ name: PROFILE_MODULE }"
        @click="emit('select', $event, PROFILE_MODULE)"
      >
        <span class="grid size-7.5 flex-none place-items-center rounded-full bg-sidebar-accent font-mono text-[11px] text-sidebar-accent-foreground"><User class="size-3.5" /></span>
        <span class="grid min-w-0 gap-0.5 text-xs">
          <b class="truncate text-sidebar-accent-foreground">{{ session.admin.nickname }}</b>
          <small class="text-xs text-sidebar-foreground">{{ roleLabel }}</small>
        </span>
      </RouterLink>
      <Button variant="ghost" size="icon-sm" class="ml-auto flex-none text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" title="退出登录" aria-label="退出登录" @click="emit('logout')"><LogOut /></Button>
    </div>
  </aside>
</template>
