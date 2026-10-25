<script setup lang="ts">
import { inlineTokens } from "../markdown";

// Providing sourceCount enables answer formatting and source-scoped citations.
defineProps<{ text: string; sourceCount?: number; activeCitation?: number | null }>();
const emit = defineEmits<{ cite: [citation: number] }>();
</script>

<template>
  <template v-for="(token, index) in inlineTokens(text, { citations: sourceCount !== undefined })" :key="index"><a v-if="token.href" :href="token.href" target="_blank" rel="noopener noreferrer" :class="sourceCount !== undefined ? 'text-link underline underline-offset-2' : undefined">{{ token.text }}</a><strong v-else-if="token.strong" :class="sourceCount !== undefined ? 'font-semibold text-foreground' : undefined">{{ token.text }}</strong><code v-else-if="token.code" :class="sourceCount !== undefined ? 'rounded bg-muted px-1 py-0.5 font-mono text-[0.88em]' : undefined">{{ token.text }}</code><button
    v-else-if="token.citation && sourceCount !== undefined && token.citation <= sourceCount" type="button"
    :class="['citation', token.citation === activeCitation && 'citation-active']" :aria-label="`查看引用来源 ${token.citation}`"
    @click="emit('cite', token.citation)"
  >{{ token.citation }}</button><template v-else>{{ token.text }}</template></template>
</template>
