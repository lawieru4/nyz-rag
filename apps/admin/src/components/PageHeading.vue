<script setup lang="ts">
defineProps<{ eyebrow: string; title: string; subtitle: string }>();
</script>

<template>
  <div class="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div>
      <p class="mb-1.5 font-mono text-[10px] font-medium tracking-wider text-link">{{ eyebrow }}</p>
      <h1 class="text-2xl font-semibold">{{ title }}</h1>
      <p class="mt-1.5 text-xs text-muted-foreground">{{ subtitle }}</p>
    </div>
    <slot />
  </div>
</template>
