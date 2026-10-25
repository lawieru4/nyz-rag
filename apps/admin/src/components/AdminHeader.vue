<script setup lang="ts">
import { Menu } from "@lucide/vue";
import { Button } from "@nyz-rag/ui/components/button";

defineProps<{ activeModule: string; menuOpen: boolean }>();
const emit = defineEmits<{ (e: "menu"): void }>();

const isDev = import.meta.env.DEV;
</script>

<template>
  <header class="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b bg-card px-9 max-lg:px-6 max-md:px-4">
    <div class="flex min-w-0 items-center gap-1">
      <Button variant="ghost" size="icon" class="-ml-2 md:hidden" aria-label="打开导航菜单" aria-haspopup="dialog" :aria-expanded="menuOpen" @click="emit('menu')"><Menu /></Button>
      <div class="truncate text-xs text-muted-foreground"><span class="max-[359px]:hidden">管理后台 <span class="px-2 text-muted-foreground/50">/</span> </span>{{ activeModule }}</div>
    </div>
    <span v-if="isDev" class="flex flex-none items-center gap-1.5 text-xs text-muted-foreground"><i class="size-1.5 rounded-full bg-success" />开发环境</span>
  </header>
</template>
