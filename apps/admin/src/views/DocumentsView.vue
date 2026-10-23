<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { ArrowUpRight, RefreshCw, Search, Trash2 } from "@lucide/vue";
import type { DocumentRecord, DocumentSummary } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { confirm } from "@nyz-rag/ui/confirm";
import { Input } from "@nyz-rag/ui/components/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nyz-rag/ui/components/table";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import FilterSelect from "../components/FilterSelect.vue";
import ListPager from "../components/ListPager.vue";
import PageHeading from "../components/PageHeading.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { client, errorMessage, loadKnowledge, pageSize, sourceName, sources } from "../workspace";
import DocumentDetailSheet from "./DocumentDetailSheet.vue";
import { documentBusy, documentStatuses, embeddingStatuses, processingLabel } from "./documents";

const documents = ref<DocumentSummary[]>([]);
const total = ref(0);
const query = ref("");
const sourceId = ref("");
const status = ref("");
const page = ref(1);
const loading = ref(false);
const selected = ref<DocumentRecord | null>(null);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

async function loadDocuments() {
  loading.value = true;
  const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize) });
  if (query.value.trim()) params.set("query", query.value.trim());
  if (sourceId.value) params.set("sourceId", sourceId.value);
  if (status.value) params.set("status", status.value);
  try {
    const data = await client.request<{ documents: DocumentSummary[]; total: number }>(`/api/admin/documents?${params}`);
    documents.value = data.documents;
    total.value = data.total;
    if (selected.value) {
      const updated = documents.value.find((document) => document.id === selected.value?.id);
      // 列表只含摘要字段：正文变化时重新拉取详情，否则只合并状态。
      if (updated && updated.updatedAt !== selected.value.updatedAt) void openDocument(updated.id);
      else if (updated) selected.value = { ...selected.value, ...updated };
    }
  } catch {
    toast.error("文档列表加载失败，请检查 API 服务");
  } finally {
    loading.value = false;
  }
}

// 文档处理在 Worker 中异步进行，停留在本页时定时刷新状态。
onMounted(() => {
  void loadDocuments();
  refreshTimer = setInterval(() => { if (!loading.value) void loadDocuments(); }, 3000);
});
onUnmounted(() => { clearInterval(refreshTimer); clearTimeout(searchTimer); });

function search() {
  page.value = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadDocuments(), 250);
}

function filter() {
  page.value = 1;
  void loadDocuments();
}

async function openDocument(id: string) {
  try {
    selected.value = await client.request<DocumentRecord>(`/api/admin/documents/${id}`);
  } catch {
    toast.error("文档详情加载失败");
  }
}

async function reprocessDocument(document: DocumentSummary) {
  try {
    await client.request(`/api/admin/documents/${document.id}/reprocess`, { method: "POST" });
    toast.success(`《${document.title}》已加入清洗与切片队列`);
    await loadDocuments();
  } catch {
    toast.error("文档重处理任务创建失败");
  }
}

async function embedDocument(document: DocumentSummary) {
  try {
    await client.request(`/api/admin/documents/${document.id}/embed`, { method: "POST" });
    toast.success(`《${document.title}》已加入向量化队列`);
    await loadDocuments();
  } catch (err) {
    toast.error(errorMessage(err, "向量化任务创建失败，请检查 API 服务"));
  }
}

async function deleteDocument(document: DocumentSummary) {
  if (!await confirm({ title: "删除文档", description: `确定删除《${document.title}》？此操作不可撤销。`, confirmText: "删除", destructive: true })) return;
  try {
    await client.request(`/api/admin/documents/${document.id}`, { method: "DELETE" });
    if (documents.value.length === 1 && page.value > 1) page.value -= 1;
    selected.value = null;
    await Promise.all([loadDocuments(), loadKnowledge()]);
    toast.success("文档已删除");
  } catch {
    toast.error("文档删除失败");
  }
}
</script>

<template>
  <PageHeading eyebrow="KNOWLEDGE OPERATIONS" title="文档管理" subtitle="检索已收录内容并查看处理状态">
    <span class="font-mono text-xs text-muted-foreground">{{ total }} 篇文档</span>
  </PageHeading>
  <Card class="min-h-96 gap-0 overflow-hidden py-0">
    <div class="flex flex-wrap gap-2.5 border-b px-4 py-3.5">
      <label class="relative min-w-0 basis-full sm:basis-auto sm:flex-1">
        <Search class="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input v-model="query" class="pl-8" placeholder="搜索标题、网址或正文" aria-label="搜索文档" @input="search" />
      </label>
      <FilterSelect v-model="sourceId" label="筛选数据源" all-label="全部数据源" :options="sources.map((source) => ({ value: source.id, label: source.name }))" @update:model-value="filter" />
      <FilterSelect v-model="status" label="筛选文档状态" all-label="全部状态" :options="Object.entries(documentStatuses).map(([value, label]) => ({ value, label }))" @update:model-value="filter" />
    </div>
    <Table class="min-w-[750px]">
      <TableHeader class="bg-muted/50"><TableRow><TableHead class="pl-4">文档</TableHead><TableHead>数据源</TableHead><TableHead>状态</TableHead><TableHead>向量化</TableHead><TableHead>最后更新</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>
        <TableRow v-for="document in documents" :key="document.id" class="text-xs text-muted-foreground">
          <TableCell class="py-3 pl-4">
            <button class="grid max-w-96 gap-1 text-left" @click="openDocument(document.id)"><b class="truncate text-xs text-foreground hover:underline">{{ document.title }}</b><small class="truncate text-[11px]">{{ document.url }}</small></button>
          </TableCell>
          <TableCell>{{ sourceName(document.sourceId) }}</TableCell>
          <TableCell><StatusBadge :on="document.processingStatus === 'chunked'">{{ processingLabel(document) }}</StatusBadge></TableCell>
          <TableCell><StatusBadge :on="document.embedding?.status === 'ready'" :title="document.embedding?.error">{{ embeddingStatuses[document.embedding?.status ?? 'pending'] }}</StatusBadge></TableCell>
          <TableCell>{{ new Date(document.updatedAt).toLocaleString() }}</TableCell>
          <TableCell>
            <div class="flex justify-end gap-0.5">
              <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" :disabled="documentBusy(document) || !document.chunkCount" title="向量化或重试" @click="embedDocument(document)">向量化</Button>
              <Button variant="ghost" size="icon-sm" :disabled="documentBusy(document)" title="重新清洗与切片" aria-label="重新清洗与切片" @click="reprocessDocument(document)"><RefreshCw /></Button>
              <Button variant="ghost" size="icon-sm" title="查看详情" aria-label="查看详情" @click="openDocument(document.id)"><ArrowUpRight /></Button>
              <Button variant="ghost" size="icon-sm" class="hover:text-destructive" :disabled="documentBusy(document)" title="删除文档" aria-label="删除文档" @click="deleteDocument(document)"><Trash2 /></Button>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
    <EmptyState v-if="loading && !documents.length">正在加载文档…</EmptyState>
    <EmptyState v-else-if="!documents.length">{{ query || sourceId || status ? '没有符合条件的文档' : '知识库中还没有文档' }}</EmptyState>
    <ListPager v-model:page="page" :total="total" unit="篇" :disabled="loading" class="mt-auto" @update:page="loadDocuments" />
  </Card>
  <DocumentDetailSheet :document="selected" @close="selected = null" @open="openDocument" @embed="embedDocument" @reprocess="reprocessDocument" @delete="deleteDocument" />
</template>
