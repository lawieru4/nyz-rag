<script setup lang="ts">
import { inlineTokens } from "../markdown";

// 回答的行内格式；[n] 在本轮来源范围内时渲染为可点击的引用标记。
defineProps<{ text: string; sourceCount: number; activeCitation?: number | null }>();
const emit = defineEmits<{ cite: [citation: number] }>();
</script>

<template>
  <template v-for="(token, index) in inlineTokens(text, { citations: true })" :key="index"><a v-if="token.href" :href="token.href" target="_blank" rel="noopener noreferrer" class="text-link underline underline-offset-2">{{ token.text }}</a><strong v-else-if="token.strong" class="font-semibold text-[#29342e]">{{ token.text }}</strong><code v-else-if="token.code" class="rounded bg-muted px-1 py-0.5 font-mono text-[0.88em]">{{ token.text }}</code><button
    v-else-if="token.citation && token.citation <= sourceCount" type="button"
    :class="['citation', token.citation === activeCitation && 'citation-active']" :aria-label="`查看引用来源 ${token.citation}`"
    @click="emit('cite', token.citation)"
  >{{ token.citation }}</button><template v-else>{{ token.text }}</template></template>
</template>
