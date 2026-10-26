<script setup lang="ts">
import { computed } from "vue";
import { SquarePen, X } from "@lucide/vue";
import type { ChatSessionRecord, KnowledgeStats, UserAccount } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import IconButton from "./IconButton.vue";

const props = defineProps<{
  sessions: ChatSessionRecord[];
  sessionId: string | null;
  sessionError: string;
  busy: boolean;
  user: UserAccount | null;
  stats: KnowledgeStats | null;
  statsError: boolean;
}>();
const emit = defineEmits<{ new: []; open: [id: string]; remove: [id: string]; login: [] }>();

const DAY_MS = 86_400_000;

/** 按最近更新时间分组：今天、昨天、近 7 天、更早（会话列表已按更新时间倒序）。 */
const groups = computed(() => {
  const today = new Date().setHours(0, 0, 0, 0);
  const labelOf = (updatedAt: string) => {
    const time = new Date(updatedAt).getTime();
    if (time >= today) return "今天";
    if (time >= today - DAY_MS) return "昨天";
    if (time >= today - 6 * DAY_MS) return "近 7 天";
    return "更早";
  };
  const result: { label: string; sessions: ChatSessionRecord[] }[] = [];
  for (const session of props.sessions) {
    const label = labelOf(session.updatedAt);
    const group = result.at(-1);
    if (group?.label === label) group.sessions.push(session);
    else result.push({ label, sessions: [session] });
  }
  return result;
});

const statsNote = computed(() => {
  if (props.statsError) return "状态加载失败，稍后自动重试";
  if (!props.stats) return "正在加载…";
  return props.stats.lastUpdated ? `更新于 ${new Date(props.stats.lastUpdated).toLocaleString()}` : "等待管理端完成首次同步";
});
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="p-3">
      <Button variant="ghost" class="w-full justify-start gap-2 text-[13px] hover:bg-card" :disabled="busy" @click="emit('new')"><SquarePen />新对话</Button>
    </div>

    <nav class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3" aria-label="历史会话">
      <section v-for="group in groups" :key="group.label" class="mt-2 first:mt-0">
        <h2 class="px-2 py-1.5 text-xs font-medium text-muted-foreground">{{ group.label }}</h2>
        <div v-for="session in group.sessions" :key="session.id" :class="['group flex items-center rounded-md transition-colors hover:bg-card/60', session.id === sessionId && 'bg-card hover:bg-card']">
          <Button
            variant="ghost" class="block h-auto min-w-0 flex-1 shrink px-2 py-2 text-left pointer-coarse:py-3 text-[13px] font-normal text-body hover:bg-transparent hover:text-body disabled:cursor-default disabled:opacity-60"
            :disabled="busy" :title="session.title" :aria-current="session.id === sessionId ? 'page' : undefined"
            @click="emit('open', session.id)"
          >
            <span class="block truncate">{{ session.title || '新会话' }}</span>
          </Button>
          <IconButton
            label="删除会话" size="icon-sm"
            class="mr-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-transparent hover:text-destructive focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
            :disabled="busy" @click="emit('remove', session.id)"
          ><X /></IconButton>
        </div>
      </section>
      <p v-if="!sessions.length" class="px-2 py-1.5 text-xs text-muted-foreground">{{ sessionError || '暂无会话' }}</p>
    </nav>

    <p v-if="!user" class="mx-3 mb-3 rounded-md bg-secondary px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      未登录：会话仅保存在当前浏览器。<Button variant="link" class="h-auto p-0 text-xs text-link" @click="emit('login')">登录</Button>后可跨设备查看。
    </p>

    <div class="px-4 py-3.5" aria-label="知识库状态">
      <div class="flex items-center gap-2 text-xs font-semibold">
        <span :class="['size-1.75 rounded-full', statsError ? 'bg-destructive' : stats ? 'bg-success' : 'bg-muted-foreground/40']" />文章知识库
      </div>
      <p class="mt-1.5 text-xs text-muted-foreground">
        <b class="font-mono font-medium text-foreground">{{ stats?.documents ?? '—' }}</b> 篇文章
        <i class="mx-1 not-italic">·</i>
        <b class="font-mono font-medium text-foreground">{{ stats?.sources ?? '—' }}</b> 个数据源
      </p>
      <p class="mt-1 text-xs text-muted-foreground">{{ statsNote }}</p>
    </div>
  </div>
</template>
