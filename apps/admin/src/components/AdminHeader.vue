<script setup lang="ts">
defineProps<{ activeModule: string }>();

const isDev = import.meta.env.DEV;
</script>

<template>
  <header class="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-card px-9 max-lg:px-6 max-md:px-4">
    <div class="text-xs text-muted-foreground">管理后台 <span class="px-2 text-muted-foreground/50">/</span> {{ activeModule }}</div>
    <span v-if="isDev" class="flex items-center gap-1.5 text-[11px] text-muted-foreground"><i class="size-1.5 rounded-full bg-success" />开发环境</span>
  </header>
</template>
