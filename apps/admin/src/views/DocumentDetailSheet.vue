<script setup lang="ts">
import { ArrowUpRight } from "@lucide/vue";
import type { DocumentRecord } from "@nyz-rag/types";
import { Alert, AlertDescription } from "@nyz-rag/ui/components/alert";
import { Button } from "@nyz-rag/ui/components/button";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@nyz-rag/ui/components/sheet";
import DetailSection from "../components/DetailSection.vue";
import MetaRow from "../components/MetaRow.vue";
import { can, sourceName } from "../workspace";
import { documentBusy, documentStatuses, embeddingStatuses } from "./documents";

defineProps<{ document: DocumentRecord | null }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "open", id: string): void;
  (e: "embed" | "reprocess" | "delete", document: DocumentRecord): void;
}>();
</script>

<template>
  <Sheet :open="!!document" @update:open="(open) => { if (!open) emit('close'); }">
    <SheetContent v-if="document" class="w-full gap-0 sm:max-w-2xl" :aria-describedby="undefined">
      <SheetHeader class="border-b">
        <p class="font-mono text-[10px] font-medium tracking-wider text-link">DOCUMENT DETAIL</p>
        <SheetTitle class="pr-6 text-lg break-words">{{ document.title }}</SheetTitle>
      </SheetHeader>
      <div class="min-h-0 flex-1 overflow-y-auto px-4">
        <MetaRow>
          <span>{{ sourceName(document.sourceId) }}</span>
          <span>{{ documentStatuses[document.status] }}</span>
          <span>{{ document.chunkCount }} 个切片</span>
          <a :href="document.url" target="_blank" rel="noreferrer" class="ml-auto inline-flex items-center gap-0.5 text-link hover:underline">打开原文 <ArrowUpRight class="size-3.5" /></a>
        </MetaRow>
        <MetaRow>
          <span>{{ embeddingStatuses[document.embedding?.status ?? 'pending'] }}</span>
          <span v-if="document.embedding?.model">{{ document.embedding.model }}</span>
          <span v-if="document.embedding?.dimensions">{{ document.embedding.dimensions }} 维 / {{ document.embedding.chunkCount }} 个向量</span>
        </MetaRow>
        <MetaRow v-if="document.processingStatus === 'duplicate'">
          <span>与已有文档内容相同，不切片、不参与检索</span>
          <Button v-if="document.primary" variant="link" size="sm" class="h-auto p-0 text-xs text-link" @click="emit('open', document.primary.id)">主文档：{{ sourceName(document.primary.sourceId) }} · {{ document.primary.title }}</Button>
          <span v-else>主文档已删除，请重新处理</span>
        </MetaRow>
        <MetaRow v-if="document.duplicates?.length">
          <span>同内容的其他来源 {{ document.duplicates.length }}</span>
          <Button v-for="duplicate in document.duplicates" :key="duplicate.id" variant="link" size="sm" class="h-auto p-0 text-xs text-link" @click="emit('open', duplicate.id)">{{ sourceName(duplicate.sourceId) }} · {{ duplicate.title }}</Button>
        </MetaRow>
        <MetaRow v-if="document.externalId">
          <span v-if="document.author">作者 {{ document.author }}</span>
          <span v-if="document.category">{{ document.category }}</span>
          <span v-if="document.publishedAt">发布于 {{ new Date(document.publishedAt).toLocaleDateString() }}</span>
          <span v-if="document.metadata?.sourceMeta?.repostSource">转载源 {{ document.metadata.sourceMeta.repostSource }}</span>
          <span v-if="document.metadata?.doi">DOI {{ document.metadata.doi }}</span>
          <span v-if="document.metadata?.titleMeta">期刊 {{ document.metadata.titleMeta.journal }}</span>
          <span v-if="document.metadata?.titleMeta?.institutions.length">机构 {{ document.metadata.titleMeta.institutions.join('、') }}</span>
          <span v-if="document.tags.length">标签 {{ document.tags.join('、') }}</span>
          <span v-if="document.metadata?.sourceMeta?.keywords.length">关键词 {{ document.metadata.sourceMeta.keywords.join('、') }}</span>
          <span v-if="document.metadata?.sourceMeta?.scenarios.length">场景 {{ document.metadata.sourceMeta.scenarios.join('、') }}</span>
          <span v-if="document.parserVersion">解析器 v{{ document.parserVersion }}</span>
        </MetaRow>
        <Alert v-if="document.embedding?.error" variant="destructive" class="mt-3"><AlertDescription>{{ document.embedding.error }}</AlertDescription></Alert>
        <Alert v-if="document.processingError" variant="destructive" class="mt-3"><AlertDescription>{{ document.processingError }}</AlertDescription></Alert>
        <p class="document-text border-b py-4">{{ document.content || '暂无正文内容' }}</p>
        <DetailSection v-if="document.chunks.length" :title="`查看切片（${document.chunks.length}）`">
          <div class="grid gap-2">
            <article v-for="chunk in document.chunks" :key="chunk.id" class="rounded-md border bg-muted/40 p-3">
              <small class="text-[11px] text-muted-foreground">#{{ chunk.index + 1 }} · {{ chunk.sectionPath?.length ? chunk.sectionPath.join(' > ') : '无章节' }} · 约 {{ chunk.tokenEstimate }} tokens{{ chunk.contentType === 'table' ? ' · 表格' : '' }}</small>
              <p class="mt-1.5 text-xs leading-relaxed whitespace-pre-wrap break-words">{{ chunk.content }}</p>
            </article>
          </div>
        </DetailSection>
        <DetailSection v-if="document.metadata?.followUpQuestions.length" :title="`推荐追问（${document.metadata.followUpQuestions.length}）`">
          <ul class="list-disc space-y-1 pl-5 text-xs">
            <li v-for="question in document.metadata.followUpQuestions" :key="question">{{ question }}</li>
          </ul>
        </DetailSection>
        <DetailSection v-if="document.markdown" title="查看完整 Markdown"><pre class="document-text">{{ document.markdown }}</pre></DetailSection>
      </div>
      <SheetFooter class="flex-row flex-wrap justify-end border-t">
        <Button variant="outline" @click="emit('close')">关闭</Button>
        <template v-if="can('documents:manage')">
          <Button variant="outline" :disabled="documentBusy(document) || !document.chunkCount" @click="emit('embed', document)">向量化 / 重试</Button>
          <Button variant="outline" :disabled="documentBusy(document)" @click="emit('reprocess', document)">重新处理</Button>
          <Button variant="destructive" :disabled="documentBusy(document)" @click="emit('delete', document)">删除文档</Button>
        </template>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
