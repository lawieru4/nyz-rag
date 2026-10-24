<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterView, useRoute } from "vue-router";
import type { AdminSession } from "@nyz-rag/types";
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

function select(event: MouseEvent, name: string) {
  if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0 && name === activeModule.value) viewKey.value++;
}
</script>

<template>
  <div class="min-h-screen">
    <AdminSidebar :session="session" :active-module="activeModule" :source-count="sources.length" @select="select" @logout="emit('logout')" />
    <main class="ml-58 min-h-screen max-lg:ml-48 max-md:ml-14">
      <AdminHeader :active-module="activeModule" />
      <div class="mx-auto max-w-330 px-10 pt-9 pb-7 max-lg:px-6 max-md:px-4">
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
