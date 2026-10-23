<script setup lang="ts">
import { ChevronRight } from "@lucide/vue";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@nyz-rag/ui/components/collapsible";

defineProps<{ title: string }>();
</script>

<template>
  <Collapsible v-slot="{ open }" class="border-b py-2.5">
    <CollapsibleTrigger class="flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
      <ChevronRight :class="['size-3.5 transition-transform', open && 'rotate-90']" />{{ title }}
    </CollapsibleTrigger>
    <CollapsibleContent class="pt-2"><slot /></CollapsibleContent>
  </Collapsible>
</template>
