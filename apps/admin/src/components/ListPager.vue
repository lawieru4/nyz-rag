<script setup lang="ts">
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { Pagination, PaginationContent, PaginationNext, PaginationPrevious } from "@nyz-rag/ui/components/pagination";
import { pageSize } from "../workspace";

defineProps<{ total: number; unit: string; disabled?: boolean }>();
const page = defineModel<number>("page", { required: true });
</script>

<template>
  <div class="flex items-center justify-end gap-3 border-t px-4 py-2.5 font-mono text-xs text-muted-foreground">
    <span>共 {{ total }} {{ unit }}</span>
    <Pagination v-slot="{ pageCount }" v-model:page="page" :total="total" :items-per-page="pageSize" :disabled="disabled" class="mx-0 w-auto">
      <PaginationContent>
        <PaginationPrevious size="icon-sm" class="px-0 sm:px-0" aria-label="上一页"><ChevronLeft /></PaginationPrevious>
        <span class="px-1">{{ page }} / {{ pageCount }}</span>
        <PaginationNext size="icon-sm" class="px-0 sm:px-0" aria-label="下一页"><ChevronRight /></PaginationNext>
      </PaginationContent>
    </Pagination>
  </div>
</template>
