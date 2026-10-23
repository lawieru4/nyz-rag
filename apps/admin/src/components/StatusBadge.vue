<script setup lang="ts">
import { Badge } from "@nyz-rag/ui/components/badge";

defineProps<{ on: boolean }>();
</script>

<template>
  <Badge :variant="on ? 'success' : 'muted'"><span class="size-1.5 rounded-full bg-current" aria-hidden="true" /><slot /></Badge>
</template>
