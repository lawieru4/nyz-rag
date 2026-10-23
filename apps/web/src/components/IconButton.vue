<script setup lang="ts">
import { Button, type ButtonVariants } from "@nyz-rag/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@nyz-rag/ui/components/tooltip";

// 只有图标的按钮：label 同时作为无障碍名称和悬停提示。
defineOptions({ inheritAttrs: false });
withDefaults(defineProps<{ label: string; size?: ButtonVariants["size"]; variant?: ButtonVariants["variant"] }>(), { size: "icon", variant: "ghost" });
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Button class="text-muted-foreground" v-bind="$attrs" :size="size" :variant="variant" :aria-label="label"><slot /></Button>
    </TooltipTrigger>
    <TooltipContent>{{ label }}</TooltipContent>
  </Tooltip>
</template>
