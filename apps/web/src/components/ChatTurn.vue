<script setup lang="ts">
import { computed } from "vue";
import { Check, Copy, RefreshCw, Sparkles, ThumbsDown, ThumbsUp } from "@lucide/vue";
import type { ChatFeedbackRating } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import type { ChatTurnState } from "../composables/useChatSession";
import AnswerMarkdown from "./AnswerMarkdown.vue";
import IconButton from "./IconButton.vue";

const props = defineProps<{
  turn: ChatTurnState;
  isLast: boolean;
  busy: boolean;
  activeCitation: number | null;
}>();
const emit = defineEmits<{
  copy: [];
  retry: [];
  feedback: [rating: ChatFeedbackRating];
  source: [citation: number | null];
}>();

const answerCaption = computed(() => props.turn.streaming
  ? (props.turn.answer ? "正在生成…" : "正在检索知识库…")
  : props.turn.answerMode === "generated" ? "由模型依据知识库生成，[n] 对应引用来源" : props.turn.answerMode === "extractive" ? "知识库原文摘录" : "");
</script>

<template>
  <!-- min-w-0：回答中的宽表格、代码块只在自身容器内滚动，不撑宽对话列 -->
  <article class="grid min-w-0 scroll-mb-48 grid-cols-[minmax(0,1fr)] gap-2.5">
    <p class="max-w-[85%] justify-self-end rounded-lg rounded-br-sm bg-primary px-4 py-2.5 text-[15px] leading-[1.7] max-sm:text-sm break-words whitespace-pre-wrap text-primary-foreground">{{ turn.question }}</p>
    <section class="rounded-lg bg-card p-4.5" aria-live="polite">
      <div class="flex items-center gap-2.5">
        <span class="grid size-7 place-items-center rounded-md bg-brand-soft text-olive"><Sparkles class="size-4" /></span>
        <div><strong class="block text-[13px]">回答</strong><small class="mt-0.5 block text-xs text-muted-foreground">{{ answerCaption }}</small></div>
      </div>
      <AnswerMarkdown
        v-if="turn.answer" :text="turn.answer" :source-count="turn.sources.length" :streaming="turn.streaming"
        :active-citation="activeCitation" @cite="(citation) => emit('source', citation)"
      />
      <p v-else-if="turn.streaming" class="streaming-cursor my-4 text-base max-sm:text-[15px]" />
      <p v-if="turn.notice" class="mt-3 rounded-md bg-warning-soft px-2.5 py-2 text-xs text-warning">{{ turn.notice }}</p>
      <div v-if="turn.sources.length || (!turn.streaming && turn.answerMode)" class="mt-4 text-xs text-muted-foreground">
        <div class="mb-2 flex items-center justify-between">
          <span>引用来源<span v-if="turn.sources.length" class="font-mono"> · {{ turn.sources.length }}</span></span>
          <Button v-if="turn.sources.length" variant="link" size="xs" class="h-auto p-0 text-xs font-normal text-link" @click="emit('source', null)">查看原文片段</Button>
        </div>
        <div v-if="turn.sources.length" class="flex flex-wrap gap-1.5">
          <button
            v-for="(source, sourceIndex) in turn.sources" :key="source.documentId" type="button"
            :class="['inline-flex max-w-full items-center gap-1.5 rounded-md bg-background py-1 pr-2.5 pl-1 text-left transition-colors hover:bg-accent hover:text-foreground', activeCitation === sourceIndex + 1 && 'bg-accent text-foreground']"
            :title="source.title" @click="emit('source', sourceIndex + 1)"
          ><span class="citation m-0 flex-none">{{ sourceIndex + 1 }}</span><span class="truncate">{{ source.title }}</span></button>
        </div>
        <span v-else>暂无匹配文章</span>
      </div>
      <div v-if="!turn.streaming" class="mt-4 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <Button v-if="turn.answer" variant="ghost" size="xs" class="px-1.5 text-muted-foreground" @click="emit('copy')">
          <!-- 复制成功时对勾弹出，2.5 秒后淡出恢复 -->
          <span class="grid *:col-start-1 *:row-start-1">
            <Copy :class="['transition-opacity duration-300', turn.copied && 'opacity-0']" />
            <Check :class="['text-success', turn.copied ? 'motion-safe:animate-pop' : 'opacity-0 transition-opacity duration-300']" />
          </span>{{ turn.copied ? '已复制' : '复制' }}
        </Button>
        <Button v-if="isLast" variant="ghost" size="xs" class="text-muted-foreground" :disabled="busy" @click="emit('retry')"><RefreshCw />重新生成</Button>
        <template v-if="turn.id">
          <span class="ml-auto">{{ turn.rating ? '感谢反馈' : '这个回答有帮助吗？' }}</span>
          <IconButton label="有帮助" size="icon-sm" :disabled="turn.feedbackBusy || !!turn.rating" :class="turn.rating === 'positive' && 'bg-secondary text-olive disabled:opacity-100 motion-safe:[&_svg]:animate-pop'" @click="emit('feedback', 'positive')"><ThumbsUp /></IconButton>
          <IconButton label="需要改进" size="icon-sm" :disabled="turn.feedbackBusy || !!turn.rating" :class="turn.rating === 'negative' && 'bg-secondary text-olive disabled:opacity-100 motion-safe:[&_svg]:animate-pop'" @click="emit('feedback', 'negative')"><ThumbsDown /></IconButton>
        </template>
      </div>
    </section>
  </article>
</template>
