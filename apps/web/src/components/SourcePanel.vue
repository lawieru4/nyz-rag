<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { ArrowUpRight, BookOpen, X } from "@lucide/vue";
import type { ChatSource } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import IconButton from "./IconButton.vue";

const props = defineProps<{
  sources: ChatSource[];
  activeCitation: number | null;
  question: string;
  /** 在抽屉中显示时由抽屉提供关闭按钮。 */
  closable?: boolean;
}>();
const emit = defineEmits<{ close: []; select: [citation: number] }>();

const list = ref<HTMLElement | null>(null);

// 切换引用时把对应文章滚动到可见位置。
watch(() => [props.activeCitation, props.sources] as const, async () => {
  await nextTick();
  list.value?.querySelector(`[data-citation="${props.activeCitation}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}, { immediate: true });

const documentHref = (id: string) => `#/documents/${encodeURIComponent(id)}`;
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex items-start justify-between gap-3 px-4 py-3.5">
      <div class="min-w-0">
        <h2 class="text-[13px] font-semibold">引用来源 <span class="font-mono font-normal text-muted-foreground">· {{ sources.length }} 篇</span></h2>
        <p class="mt-1 truncate text-xs text-muted-foreground" :title="question">{{ question }}</p>
      </div>
      <IconButton v-if="closable" label="关闭引用来源" size="icon-sm" class="-mt-1 -mr-1.5" @click="emit('close')"><X /></IconButton>
    </div>

    <ol ref="list" class="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
      <li
        v-for="(source, index) in sources" :key="source.documentId" :data-citation="index + 1"
        :class="['scroll-my-3 rounded-lg bg-card transition-shadow', activeCitation === index + 1 ? 'shadow-[0_0_0_1px_var(--ring),0_0_0_4px_color-mix(in_oklab,var(--brand)_40%,transparent)]' : 'hover:shadow-[0_1px_3px_#202b1414]']"
      >
        <button type="button" class="flex w-full items-start gap-2.5 px-3.5 pt-3 text-left" :aria-pressed="activeCitation === index + 1" @click="emit('select', index + 1)">
          <span :class="['citation mt-0.5 flex-none', activeCitation === index + 1 && 'citation-active']">{{ index + 1 }}</span>
          <span class="min-w-0">
            <span class="block text-sm leading-snug font-semibold text-foreground">{{ source.title }}</span>
            <span v-if="source.repostSource" class="mt-1 block text-xs text-muted-foreground">转载自 {{ source.repostSource }}</span>
          </span>
        </button>

        <div v-if="source.excerpts?.length" class="mt-2.5 space-y-2 px-3.5">
          <blockquote v-for="(excerpt, excerptIndex) in source.excerpts" :key="excerptIndex" class="rounded-md bg-quote px-3 py-2.5">
            <p v-if="excerpt.sectionPath.length" class="mb-1 truncate text-xs font-medium text-olive">{{ excerpt.sectionPath.join(" › ") }}</p>
            <p :class="['text-[13px] leading-[1.75] text-pretty whitespace-pre-line text-body', activeCitation !== index + 1 && 'line-clamp-3']">{{ excerpt.text }}</p>
          </blockquote>
        </div>
        <p v-else class="mt-2 px-3.5 text-xs text-muted-foreground">暂无片段摘录</p>

        <div class="flex items-center gap-1 px-2 py-2">
          <Button as="a" :href="documentHref(source.documentId)" variant="ghost" size="xs" class="text-xs font-normal text-link"><BookOpen />阅读全文</Button>
          <Button v-if="source.url" as="a" :href="source.url" target="_blank" rel="noopener noreferrer" variant="ghost" size="xs" class="text-xs font-normal text-muted-foreground">原文链接<ArrowUpRight /></Button>
        </div>
      </li>
      <li v-if="!sources.length" class="px-1 py-2 text-xs text-muted-foreground">本轮回答没有引用文章。</li>
    </ol>
  </div>
</template>
