<script setup lang="ts">
import { CircleAlert } from "@lucide/vue";
import { Badge } from "@nyz-rag/ui/components/badge";
import { computed } from "vue";

/** `tone` 优先；只有开/关两态时用 `on`。失败用错误色并换成警示图标，不只靠颜色区分。 */
const props = defineProps<{ on?: boolean; tone?: "success" | "muted" | "warning" | "danger" }>();
const variant = computed(() => props.tone ?? (props.on ? "success" : "muted"));
</script>

<template>
  <Badge :variant="variant"><CircleAlert v-if="variant === 'danger'" aria-hidden="true" /><span v-else class="size-1.5 rounded-full bg-current" aria-hidden="true" /><slot /></Badge>
</template>
