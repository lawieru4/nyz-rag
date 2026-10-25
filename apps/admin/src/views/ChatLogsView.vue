<script setup lang="ts">
import { ref } from "vue";
import { ArrowUpRight, Search } from "@lucide/vue";
import type { ChatLogListResponse, ChatLogRecord } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { Input } from "@nyz-rag/ui/components/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nyz-rag/ui/components/table";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import FilterSelect from "../components/FilterSelect.vue";
import ListPager from "../components/ListPager.vue";
import PageHeading from "../components/PageHeading.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { usePaginatedList } from "../composables/usePaginatedList";
import { client, pageSize } from "../workspace";
import ChatLogSheet from "./ChatLogSheet.vue";
import { chatLogOwner, ratingLabel } from "./chat-logs";

const rating = ref("");
const selected = ref<ChatLogRecord | null>(null);
const { items: logs, total, query, page, loading, load: loadChatLogs, search, filter } = usePaginatedList<ChatLogRecord>({
  pageSize,
  async fetch(params, signal) {
    if (rating.value) params.set("rating", rating.value);
    const data = await client.request<ChatLogListResponse>(`/api/admin/chat-logs?${params}`, { signal });
    return { items: data.logs, total: data.total };
  },
  onError: () => toast.error("问答记录加载失败，请检查 API 服务"),
});
</script>

<template>
  <PageHeading eyebrow="CONVERSATION AUDIT" title="问答记录" subtitle="查看用户提问、模型回答、引用来源与评价">
    <span class="font-mono text-xs text-muted-foreground">{{ total }} 条记录</span>
  </PageHeading>
  <Card class="min-h-96 gap-0 overflow-hidden py-0">
    <div class="flex flex-wrap gap-2.5 border-b px-4 py-3.5">
      <label class="relative min-w-0 basis-full sm:basis-auto sm:flex-1">
        <Search class="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input v-model="query" class="pl-8" placeholder="搜索问题、回答、来源或用户邮箱" aria-label="搜索问答记录" @input="search" />
      </label>
      <FilterSelect v-model="rating" label="筛选评价" all-label="全部评价" :options="[{ value: 'rated', label: '已评价' }, { value: 'unrated', label: '未评价' }]" @update:model-value="filter" />
    </div>
    <!-- 手机端（<768px）用下方的摘要列表，完整问答与引用在详情抽屉 -->
    <Table class="min-w-[750px]" container-class="max-md:hidden">
      <TableHeader class="bg-muted/50"><TableRow><TableHead class="pl-4">用户提问</TableHead><TableHead>提问人</TableHead><TableHead>引用来源</TableHead><TableHead>评价</TableHead><TableHead>时间</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>
        <TableRow v-for="log in logs" :key="log.id" class="text-[13px] text-muted-foreground">
          <TableCell class="py-3 pl-4">
            <button class="grid max-w-96 gap-1 text-left" @click="selected = log"><b class="truncate text-sm text-foreground hover:underline">{{ log.question }}</b><small class="truncate text-xs">{{ log.supersededAt ? '[已重新生成] ' : '' }}{{ log.answer }}</small></button>
          </TableCell>
          <TableCell>{{ chatLogOwner(log) }}</TableCell>
          <TableCell class="max-w-64 truncate">{{ log.sources.length ? log.sources.map((source) => source.title).join('、') : '无引用' }}</TableCell>
          <TableCell><StatusBadge :on="log.rating === 'positive'">{{ ratingLabel(log.rating) }}</StatusBadge></TableCell>
          <TableCell>{{ new Date(log.createdAt).toLocaleString() }}</TableCell>
          <TableCell><div class="flex justify-end"><Button variant="ghost" size="icon-sm" title="查看详情" aria-label="查看详情" @click="selected = log"><ArrowUpRight /></Button></div></TableCell>
        </TableRow>
      </TableBody>
    </Table>
    <ul class="divide-y md:hidden" aria-label="问答记录列表">
      <li v-for="log in logs" :key="log.id">
        <button class="grid w-full min-w-0 gap-1.5 px-4 py-3 text-left text-[13px] text-muted-foreground" @click="selected = log">
          <b class="line-clamp-2 text-sm break-words text-foreground">{{ log.question }}</b>
          <small class="line-clamp-2 text-xs break-words">{{ log.supersededAt ? '[已重新生成] ' : '' }}{{ log.answer }}</small>
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <StatusBadge :on="log.rating === 'positive'">{{ ratingLabel(log.rating) }}</StatusBadge>
            <span>{{ new Date(log.createdAt).toLocaleString() }}</span>
            <span class="truncate">{{ chatLogOwner(log) }}</span>
            <span>{{ log.sources.length ? `${log.sources.length} 篇引用` : '无引用' }}</span>
          </span>
        </button>
      </li>
    </ul>
    <EmptyState v-if="loading && !logs.length">正在加载问答记录…</EmptyState>
    <EmptyState v-else-if="!logs.length">没有符合条件的问答记录</EmptyState>
    <ListPager v-model:page="page" :total="total" unit="条" :disabled="loading" class="mt-auto" @update:page="loadChatLogs" />
  </Card>
  <ChatLogSheet :log="selected" @close="selected = null" />
</template>
