<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft, ArrowUpRight } from "@lucide/vue";
import type { DocumentDetail } from "@nyz-rag/types";
import { Badge } from "@nyz-rag/ui/components/badge";
import { Button } from "@nyz-rag/ui/components/button";
import { Skeleton } from "@nyz-rag/ui/components/skeleton";
import { parseMarkdown, safeLink } from "../markdown";
import { client } from "../webClient";
import MarkdownInline from "./MarkdownInline.vue";

/** 文章 ID；空字符串表示地址无法解析。 */
const props = defineProps<{ id: string }>();

const article = ref<DocumentDetail | null>(null);
const error = ref("");
const loading = ref(false);
let request = 0;

const blocks = computed(() => article.value ? parseMarkdown(article.value.markdown || article.value.content) : []);
const originalUrl = computed(() => article.value ? safeLink(article.value.url) : undefined);

async function load() {
  const current = ++request;
  article.value = null;
  error.value = "";
  if (!props.id) { error.value = "文章地址无效"; return; }
  loading.value = true;
  try {
    const data = await client.request<DocumentDetail>(`/api/documents/${encodeURIComponent(props.id)}`);
    if (current === request) article.value = data;
  } catch (err) {
    if (current === request) error.value = err instanceof Error ? err.message : "文章加载失败";
  } finally {
    if (current === request) loading.value = false;
  }
}

watch(() => props.id, load, { immediate: true });
</script>

<template>
  <section class="mx-auto min-h-[calc(100dvh-3.5rem)] max-w-250 px-9 pt-8 pb-18 max-md:px-6 max-sm:px-4 max-sm:pt-5" aria-live="polite">
    <Button as="a" href="#/" variant="link" class="mb-8 h-auto px-0 text-xs text-link"><ArrowLeft /> 返回知识问答</Button>
    <div v-if="loading" class="mx-auto grid max-w-190 gap-4" role="status" aria-label="正在加载文章…">
      <Skeleton class="h-3 w-24" /><Skeleton class="h-9 w-4/5" /><Skeleton class="h-5 w-full" /><Skeleton class="h-5 w-2/3" />
      <Skeleton class="mt-6 h-40 w-full" />
    </div>
    <div v-else-if="error" class="mx-auto my-20 max-w-180 p-8 text-center text-destructive" role="alert">
      <p>{{ error }}</p>
      <Button v-if="id" variant="outline" class="mt-4" @click="load">重试</Button>
    </div>
    <article v-else-if="article" class="mx-auto max-w-190">
      <header class="border-b pb-6">
        <p class="eyebrow mb-3">知识库文章</p>
        <h1 class="text-[32px] leading-[1.45] font-semibold break-words max-sm:text-[26px]">{{ article.title }}</h1>
        <p v-if="article.summary" class="mt-3.5 text-base leading-[1.8] text-muted-foreground max-sm:text-sm">{{ article.summary }}</p>
        <div class="mt-4.5 flex flex-wrap gap-x-4.5 gap-y-2 text-xs text-muted-foreground">
          <span v-if="article.author">{{ article.author }}</span>
          <span v-if="article.category">{{ article.category }}</span>
          <time v-if="article.publishedAt" :datetime="article.publishedAt">{{ new Date(article.publishedAt).toLocaleDateString() }}</time>
          <span>更新于 {{ new Date(article.updatedAt).toLocaleDateString() }}</span>
        </div>
        <div v-if="article.tags.length || article.keywords.length || article.scenarios.length" class="mt-5 grid gap-2.5">
          <div v-for="[label, values] in ([['标签', article.tags], ['关键词', article.keywords], ['适用场景', article.scenarios]] as const)" v-show="values.length" :key="label" class="flex flex-wrap items-center gap-1.5">
            <strong class="min-w-16 text-xs font-medium text-muted-foreground">{{ label }}</strong>
            <Badge v-for="value in values" :key="value" variant="brand" class="rounded-sm font-normal">{{ value }}</Badge>
          </div>
        </div>
        <p v-if="article.repostSource" class="mt-3 text-xs text-muted-foreground">转载自 {{ article.repostSource }}</p>
      </header>
      <div class="article-body">
        <template v-for="(block, index) in blocks" :key="index">
          <component :is="`h${block.level}`" v-if="block.kind === 'heading'" class="markdown-heading"><MarkdownInline :text="block.text || ''" /></component>
          <p v-else-if="block.kind === 'paragraph'" class="markdown-paragraph"><MarkdownInline :text="block.text || ''" /></p>
          <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'" :start="block.start" :class="['markdown-list', block.ordered ? 'list-decimal' : 'list-disc']"><li v-for="(item, itemIndex) in block.items" :key="itemIndex"><MarkdownInline :text="item" /></li></component>
          <pre v-else-if="block.kind === 'code'" class="markdown-code"><code>{{ block.text }}</code></pre>
          <div v-else-if="block.kind === 'table'" class="markdown-table-wrap"><table><tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><template v-if="rowIndex === 0"><th v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</th></template><template v-else><td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td></template></tr></tbody></table></div>
        </template>
      </div>
      <Button v-if="originalUrl" as="a" :href="originalUrl" target="_blank" rel="noopener noreferrer" variant="link" class="mt-4 h-auto px-0 text-xs text-link">查看原文 <ArrowUpRight /></Button>
    </article>
  </section>
</template>
