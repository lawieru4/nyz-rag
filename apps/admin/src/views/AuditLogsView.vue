<script setup lang="ts">
import { ref } from "vue";
import { Search } from "@lucide/vue";
import type { AdminAuditLogListResponse, AdminAuditLogRecord } from "@nyz-rag/types";
import { Badge } from "@nyz-rag/ui/components/badge";
import { Card } from "@nyz-rag/ui/components/card";
import { Input } from "@nyz-rag/ui/components/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nyz-rag/ui/components/table";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import FilterSelect from "../components/FilterSelect.vue";
import ListPager from "../components/ListPager.vue";
import PageHeading from "../components/PageHeading.vue";
import { usePaginatedList } from "../composables/usePaginatedList";
import { client, pageSize } from "../workspace";
import { AUDIT_RESULTS, auditActionLabel, auditOperator, auditResultLabel, auditResultVariant } from "./audit-logs";

const result = ref("");
const { items: logs, total, query, page, loading, load: loadAuditLogs, search, filter } = usePaginatedList<AdminAuditLogRecord>({
  pageSize,
  async fetch(params, signal) {
    if (result.value) params.set("result", result.value);
    const data = await client.request<AdminAuditLogListResponse>(`/api/admin/audit-logs?${params}`, { signal });
    return { items: data.logs, total: data.total };
  },
  onError: () => toast.error("操作日志加载失败，请检查 API 服务"),
});
</script>

<template>
  <PageHeading eyebrow="OPERATION AUDIT" title="操作日志" subtitle="管理端的写操作、登录尝试与被拒绝的访问；不记录请求内容与密钥">
    <span class="font-mono text-xs text-muted-foreground">{{ total }} 条记录</span>
  </PageHeading>
  <Card class="min-h-96 gap-0 overflow-hidden py-0">
    <div class="flex flex-wrap gap-2.5 border-b px-4 py-3.5">
      <label class="relative min-w-0 basis-full sm:basis-auto sm:flex-1">
        <Search class="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input v-model="query" class="pl-8" placeholder="搜索操作者、接口、资源 ID 或 IP" aria-label="搜索操作日志" @input="search" />
      </label>
      <FilterSelect v-model="result" label="筛选结果" all-label="全部结果" :options="AUDIT_RESULTS" @update:model-value="filter" />
    </div>
    <Table class="min-w-[820px]">
      <TableHeader class="bg-muted/50"><TableRow><TableHead class="pl-4">时间</TableHead><TableHead>操作者</TableHead><TableHead>操作</TableHead><TableHead>资源 ID</TableHead><TableHead>结果</TableHead><TableHead>IP</TableHead></TableRow></TableHeader>
      <TableBody>
        <TableRow v-for="log in logs" :key="log.id" class="text-xs text-muted-foreground">
          <TableCell class="py-3 pl-4 whitespace-nowrap">{{ new Date(log.createdAt).toLocaleString() }}</TableCell>
          <TableCell>
            <div class="grid gap-0.5"><b class="text-foreground">{{ auditOperator(log) }}</b><small v-if="log.adminEmail" class="text-[11px]">{{ log.adminEmail }}</small></div>
          </TableCell>
          <TableCell>
            <div class="grid gap-0.5" :title="`请求 ID：${log.requestId}`"><span class="text-foreground">{{ auditActionLabel(log) }}</span><small class="font-mono text-[10px]">{{ log.method }} {{ log.route }}</small></div>
          </TableCell>
          <TableCell class="max-w-40 truncate font-mono text-[11px]" :title="log.resourceId ?? undefined">{{ log.resourceId ?? '—' }}</TableCell>
          <TableCell><Badge :variant="auditResultVariant(log.result)">{{ auditResultLabel(log.result) }} · {{ log.statusCode }}</Badge></TableCell>
          <TableCell class="font-mono text-[11px]">{{ log.ip }}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
    <EmptyState v-if="loading && !logs.length">正在加载操作日志…</EmptyState>
    <EmptyState v-else-if="!logs.length">没有符合条件的操作日志</EmptyState>
    <ListPager v-model:page="page" :total="total" unit="条" :disabled="loading" class="mt-auto" @update:page="loadAuditLogs" />
  </Card>
</template>
