<script setup lang="ts">
import { inlineTokens } from "../markdown";

defineProps<{ text: string }>();
</script>

<template>
  <template v-for="(token, index) in inlineTokens(text)" :key="index"><a v-if="token.href" :href="token.href" target="_blank" rel="noopener noreferrer">{{ token.text }}</a><strong v-else-if="token.strong">{{ token.text }}</strong><code v-else-if="token.code">{{ token.text }}</code><template v-else>{{ token.text }}</template></template>
</template>
