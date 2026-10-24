<script setup lang="ts">
import { computed, type Component } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { Database, FileText, KeyRound, Library, LogOut, MessagesSquare, Settings2, Shield, User, Users } from "@lucide/vue";
import type { AdminSession } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { homePath, routeVisible } from "../router";

const props = defineProps<{ session: AdminSession; activeModule: string; sourceCount: number }>();
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
];
const PROFILE_MODULE = "个人资料";
// 可见性由路由的 meta（权限或仅超级管理员）决定，与 App.vue 的路由守卫一致。
const modules = computed(() => allModules.filter((m) => routeVisible(router.resolve({ name: m.name }).meta, props.session)));
const roleLabel = computed(() => props.session.admin.isSuper ? "超级管理员" : props.session.admin.roleName ?? "未分配角色");
</script>

<template>
  <aside class="fixed inset-y-0 left-0 z-10 flex w-58 flex-col bg-sidebar px-3.5 pt-6 pb-3.5 text-sidebar-foreground max-lg:w-48 max-md:w-14 max-md:px-2">
    <RouterLink class="flex items-center gap-1 px-2 text-sm font-bold text-sidebar-accent-foreground max-md:px-1" :to="homePath(session)" aria-label="能知管理后台">
      <img src="/logo_t.png" alt="能知" class="h-10 w-30 flex-none object-contain max-lg:w-24 max-md:hidden" />
      <img src="/favicon_t.png" alt="" class="hidden size-7 flex-none object-contain max-md:block" />
      <span class="font-mono text-[9px] font-medium text-sidebar-foreground/70 max-md:hidden">管理后台</span>
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
        @click="emit('select', $event, item.name)"
      >
        <component :is="item.icon" :class="['size-4 flex-none', activeModule === item.name ? 'text-sidebar-primary' : 'text-sidebar-foreground/80']" />
        <span class="max-md:sr-only">{{ item.name }}</span>
        <span v-if="item.name === '数据源'" class="ml-auto font-mono text-[11px] max-md:hidden">{{ sourceCount }}</span>
      </RouterLink>
    </nav>
    <div class="mt-auto flex items-center gap-2.5 border-t border-sidebar-border px-1.5 pt-4 pb-1 max-md:flex-col max-md:justify-center max-md:px-0">
      <RouterLink
        class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-sidebar-accent/60 max-md:justify-center"
        title="个人资料"
        :aria-current="activeModule === PROFILE_MODULE ? 'page' : undefined"
        :to="{ name: PROFILE_MODULE }"
        @click="emit('select', $event, PROFILE_MODULE)"
      >
        <span class="grid size-7.5 flex-none place-items-center rounded-full bg-[#53634f] font-mono text-[11px] text-[#e5edda]"><User class="size-3.5" /></span>
        <span class="grid min-w-0 gap-0.5 text-[11px] max-md:hidden">
          <b class="truncate text-sidebar-accent-foreground">{{ session.admin.nickname }}</b>
          <small class="text-[10px] text-sidebar-foreground/70">{{ roleLabel }}</small>
        </span>
      </RouterLink>
      <Button variant="ghost" size="icon-sm" class="ml-auto flex-none text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground max-md:ml-0" title="退出登录" aria-label="退出登录" @click="emit('logout')"><LogOut /></Button>
    </div>
  </aside>
</template>
