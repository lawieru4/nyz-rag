<script setup lang="ts">
import MarkdownInline from "./MarkdownInline.vue";

// 回答的行内格式；[n] 在本轮来源范围内时渲染为可点击的引用标记。
const props = defineProps<{ text: string; sourceCount: number; activeCitation?: number | null }>();
const emit = defineEmits<{ cite: [citation: number] }>();
</script>

<template>
  <MarkdownInline v-bind="props" @cite="emit('cite', $event)" />
</template>
