<script setup lang="ts">
import { ArrowUpRight } from "@lucide/vue";
import { Button } from "@nyz-rag/ui/components/button";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@nyz-rag/ui/components/sheet";
import DetailSection from "../components/DetailSection.vue";
import MetaRow from "../components/MetaRow.vue";
import { chatLogOwner, ratingLabel, type ChatLog } from "./chat-logs";

defineProps<{ log: ChatLog | null }>();
const emit = defineEmits<{ (e: "close"): void }>();
</script>

<template>
  <Sheet :open="!!log" @update:open="(open) => { if (!open) emit('close'); }">
    <SheetContent v-if="log" class="w-full gap-0 sm:max-w-2xl" :aria-describedby="undefined">
      <SheetHeader class="border-b">
        <p class="font-mono text-[11px] font-medium tracking-wider text-link">CONVERSATION DETAIL</p>
        <SheetTitle class="text-lg">问答详情</SheetTitle>
      </SheetHeader>
      <div class="min-h-0 flex-1 overflow-y-auto px-4">
        <MetaRow>
          <span>{{ new Date(log.createdAt).toLocaleString() }}</span>
          <span>{{ ratingLabel(log.rating) }}</span>
          <span>{{ log.answerMode === 'generated' ? `模型生成 · ${log.model}` : '原文摘录' }}</span>
          <span>{{ chatLogOwner(log) }}</span>
          <span :title="log.sessionId">{{ log.sessionId ? `会话 ${log.sessionId.slice(0, 8)}` : '单次问答' }}</span>
          <span v-if="log.supersededAt">已被重新生成替换（{{ new Date(log.supersededAt).toLocaleString() }}）</span>
        </MetaRow>
        <MetaRow v-if="log.totalMs !== undefined">
          <span>检索 {{ log.retrievalMs }} ms</span>
          <span v-if="log.firstTokenMs !== undefined">首 Token {{ log.firstTokenMs }} ms</span>
          <span>总耗时 {{ log.totalMs }} ms</span>
          <span v-if="log.promptTokens !== undefined">Token {{ log.promptTokens }} + {{ log.completionTokens }}</span>
        </MetaRow>
        <h3 class="mt-4 text-xs font-semibold text-muted-foreground">用户提问</h3>
        <p class="document-text py-2">{{ log.question }}</p>
        <h3 class="mt-2 text-xs font-semibold text-muted-foreground">回答</h3>
        <p class="document-text py-2">{{ log.answer }}</p>
        <h3 class="mt-2 text-xs font-semibold text-muted-foreground">引用来源</h3>
        <div class="grid gap-2 border-b py-2.5 text-xs">
          <a v-for="(source, index) in log.sources" :key="source.documentId" :href="source.url" target="_blank" rel="noreferrer" class="inline-flex items-start gap-0.5 break-words text-link hover:underline">[{{ index + 1 }}] {{ source.title }}{{ source.repostSource ? `（转载自 ${source.repostSource}）` : '' }} <ArrowUpRight class="mt-0.5 size-3.5 flex-none" /></a>
          <span v-if="!log.sources.length" class="text-muted-foreground">无引用来源</span>
        </div>
        <DetailSection v-if="log.chunks.length" :title="`召回片段（${log.chunks.length}）`">
          <div class="grid gap-2">
            <article v-for="chunk in log.chunks" :key="chunk.chunkId" class="rounded-md border bg-muted/40 p-3">
              <small class="text-xs text-muted-foreground">[{{ chunk.citation }}] {{ chunk.title }}{{ chunk.sectionPath.length ? ` · ${chunk.sectionPath.join(' > ')}` : '' }} · 合并 {{ chunk.score.toFixed(4) }}<template v-if="chunk.vectorScore !== undefined"> · 向量 {{ chunk.vectorScore.toFixed(3) }}</template><template v-if="chunk.keywordScore !== undefined"> · 关键词 {{ chunk.keywordScore.toFixed(2) }}</template><template v-if="chunk.summaryScore !== undefined"> · 摘要 {{ chunk.summaryScore.toFixed(3) }}</template><template v-if="chunk.rerankScore !== undefined"> · 重排 {{ chunk.rerankScore.toFixed(3) }}</template></small>
              <p class="mt-1.5 text-xs leading-relaxed whitespace-pre-wrap break-words">{{ chunk.excerpt }}</p>
            </article>
          </div>
        </DetailSection>
      </div>
      <SheetFooter class="flex-row justify-end border-t">
        <Button variant="outline" @click="emit('close')">关闭</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
</template>
