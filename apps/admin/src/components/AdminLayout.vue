<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import type { AdminSession } from "@nyz-rag/types";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@nyz-rag/ui/components/sheet";
import AdminHeader from "./AdminHeader.vue";
import AdminSidebar from "./AdminSidebar.vue";
import { sources } from "../workspace";

defineProps<{ session: AdminSession; routeAllowed: boolean }>();
const emit = defineEmits<{
  (e: "logout"): void;
  (e: "session-updated", session: AdminSession): void;
  (e: "logout-required"): void;
}>();

const PROFILE_MODULE = "个人资料";
const route = useRoute();
const activeModule = computed(() => String(route.name ?? "数据源"));
// 再次点击当前模块时重新挂载视图，即重新加载数据。
const viewKey = ref(0);

// 小于 768px（md）时侧栏收进抽屉；进入平板/桌面宽度或路由变化时关闭抽屉，避免遗留遮罩与滚动锁。
const navOpen = ref(false);
const tabletQuery = window.matchMedia("(min-width: 768px)");
function onTabletChange(event: MediaQueryListEvent) { if (event.matches) navOpen.value = false; }
onMounted(() => tabletQuery.addEventListener("change", onTabletChange));
onUnmounted(() => tabletQuery.removeEventListener("change", onTabletChange));
watch(() => route.fullPath, () => { navOpen.value = false; });

function select(event: MouseEvent, name: string) {
  navOpen.value = false;
  if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0 && name === activeModule.value) viewKey.value++;
}

function logout() {
  navOpen.value = false;
  emit("logout");
}
</script>

<template>
  <div class="min-h-dvh">
    <AdminSidebar :session="session" :active-module="activeModule" :source-count="sources.length" @select="select" @logout="logout" />
    <Sheet v-model:open="navOpen">
      <SheetContent side="left" class="w-64 gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground">
        <SheetTitle class="sr-only">管理模块</SheetTitle>
        <SheetDescription class="sr-only">切换管理模块、进入个人资料或退出登录</SheetDescription>
        <AdminSidebar drawer :session="session" :active-module="activeModule" :source-count="sources.length" @select="select" @logout="logout" />
      </SheetContent>
    </Sheet>
    <main class="ml-58 min-h-dvh max-lg:ml-48 max-md:ml-0">
      <AdminHeader :active-module="activeModule" :menu-open="navOpen" @menu="navOpen = true" />
      <div class="mx-auto max-w-330 px-10 pt-9 pb-7 max-lg:px-6 max-md:px-4 max-md:pt-6">
        <RouterView v-if="routeAllowed" v-slot="{ Component }">
          <component
            :is="Component"
            :key="`${route.path}-${viewKey}`"
            v-bind="activeModule === PROFILE_MODULE ? { session } : activeModule === '数据源' ? { title: activeModule } : {}"
            @session-updated="emit('session-updated', $event)"
            @logout-required="emit('logout-required')"
          />
        </RouterView>
      </div>
    </main>
  </div>
</template>
