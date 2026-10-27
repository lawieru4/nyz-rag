<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, type Component } from "vue";
import { Coins, Gauge, MessagesSquare, Timer, TriangleAlert } from "@lucide/vue";
import type { ChatStatsResponse } from "@nyz-rag/types";
import { Card } from "@nyz-rag/ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nyz-rag/ui/components/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nyz-rag/ui/components/table";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import PageHeading from "../components/PageHeading.vue";
import { client } from "../workspace";
import { answerTokens, duration, fallbackBreakdown, percent, rewriteTokens, STATS_RANGES } from "./chat-stats";

const range = ref("14");
const stats = shallowRef<ChatStatsResponse | null>(null);
const loading = ref(false);
// 按浏览器所在时区划分日期。
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let controller: AbortController | undefined;

// 只采用最近一次请求的结果（切换范围或离开页面时中止旧请求）。
async function load() {
  controller?.abort();
  const request = new AbortController();
  controller = request;
  loading.value = true;
  try {
    const params = new URLSearchParams({ days: range.value, timeZone });
    const data = await client.request<ChatStatsResponse>(`/api/admin/chat-stats?${params}`, { signal: request.signal });
    if (controller === request && !request.signal.aborted) stats.value = data;
  } catch {
    if (controller === request && !request.signal.aborted) toast.error("问答统计加载失败，请检查 API 服务");
  } finally {
    if (controller === request) {
      controller = undefined;
      loading.value = false;
    }
  }
}
onMounted(load);
onUnmounted(() => controller?.abort());

function selectRange(value: unknown) {
  range.value = String(value);
  void load();
}

const summary = computed<Array<{ label: string; value: string; hint: string; icon: Component; danger?: boolean }>>(() => {
  const total = stats.value?.total;
  if (!total) return [];
  const fallbackRate = total.questions ? total.extractive / total.questions : 0;
  return [
    { label: "问答数", value: total.questions.toLocaleString(), hint: `差评 ${total.negative}（${percent(total.negative, total.questions)}）`, icon: MessagesSquare },
    { label: "降级率", value: percent(total.extractive, total.questions), hint: `${total.extractive} 次改为原文摘录`, icon: TriangleAlert, danger: fallbackRate >= 0.2 },
    { label: "总耗时 P50 / P95", value: `${duration(total.totalMsP50)} / ${duration(total.totalMsP95)}`, hint: `首 Token ${duration(total.firstTokenMsP50)} / ${duration(total.firstTokenMsP95)}`, icon: Timer },
    { label: "Token 用量", value: (answerTokens(total) + rewriteTokens(total)).toLocaleString(), hint: `输入 ${total.promptTokens.toLocaleString()} · 输出 ${total.completionTokens.toLocaleString()} · 改写 ${rewriteTokens(total).toLocaleString()}`, icon: Coins },
  ];
});
const breakdown = computed(() => stats.value ? fallbackBreakdown(stats.value.total) : []);
// 最近的日期在前；条形按区间内单日最多问答数缩放。
const days = computed(() => [...stats.value?.days ?? []].reverse());
const busiest = computed(() => Math.max(1, ...days.value.map((day) => day.questions)));
</script>

<template>
  <PageHeading eyebrow="CONVERSATION METRICS" title="问答统计" :subtitle="`按天统计问答量、降级为原文摘录的比例、耗时分位数与 Token 用量（${timeZone}）`">
    <Select :model-value="range" @update:model-value="selectRange">
      <SelectTrigger aria-label="统计范围" class="w-32 bg-card"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="days in STATS_RANGES" :key="days" :value="String(days)">最近 {{ days }} 天</SelectItem>
      </SelectContent>
    </Select>
  </PageHeading>
  <EmptyState v-if="!stats">{{ loading ? "正在加载问答统计…" : "暂无统计数据" }}</EmptyState>
  <template v-else>
    <Card class="mb-3 grid grid-cols-2 gap-0 py-0 lg:grid-cols-4" aria-label="统计汇总">
      <article v-for="item in summary" :key="item.label" class="relative flex min-h-26 flex-col px-5 py-4 max-lg:odd:border-r max-lg:[&:nth-child(-n+2)]:border-b lg:border-r lg:last:border-r-0">
        <span class="text-xs text-muted-foreground">{{ item.label }}</span>
        <strong :class="['mt-2 text-[22px] leading-tight font-semibold tabular-nums', item.danger ? 'text-destructive' : 'text-foreground']">{{ item.value }}</strong>
        <small class="mt-0.5 text-xs text-muted-foreground">{{ item.hint }}</small>
        <component :is="item.icon" class="absolute top-4 right-4 size-4 text-link/70" aria-hidden="true" />
      </article>
    </Card>
    <Card class="mb-8 flex-row flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3 text-xs text-muted-foreground" aria-label="降级原因">
      <b class="flex items-center gap-1.5 font-semibold text-foreground"><Gauge class="size-3.5" />降级原因<span class="font-normal text-muted-foreground">（占降级次数）</span></b>
      <span v-for="item in breakdown" :key="item.label">{{ item.label }} <b class="font-semibold text-foreground tabular-nums">{{ item.count }}</b> <span class="tabular-nums">（{{ item.share }}）</span></span>
      <span v-if="!breakdown.length">所选范围内没有降级为原文摘录的问答</span>
    </Card>
    <section>
      <div class="mb-3"><h2 class="text-sm font-semibold">逐日明细</h2><p class="mt-1 text-xs text-muted-foreground">耗时只统计有记录的问答；包含被重新生成替换的回答，不含被限流拒绝或中途断开的请求</p></div>
      <Card class="gap-0 overflow-hidden py-0">
        <Table class="min-w-[820px]">
          <TableHeader class="bg-muted/50"><TableRow><TableHead class="pl-4">日期</TableHead><TableHead>问答数</TableHead><TableHead>降级率</TableHead><TableHead>总耗时 P50 / P95</TableHead><TableHead>首 Token P50 / P95</TableHead><TableHead title="回答的输入 + 输出 Token，以及问题改写的 Token">Token（回答 / 改写）</TableHead><TableHead>差评</TableHead></TableRow></TableHeader>
          <TableBody>
            <TableRow v-for="day in days" :key="day.date" class="text-[13px] text-muted-foreground tabular-nums">
              <TableCell class="py-3 pl-4 font-mono text-xs text-foreground">{{ day.date }}</TableCell>
              <TableCell>
                <div class="flex items-center gap-2"><b class="w-10 font-semibold text-foreground">{{ day.questions }}</b><span class="h-1.5 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span class="block h-full rounded-full bg-link/70" :style="{ width: `${day.questions / busiest * 100}%` }" /></span></div>
              </TableCell>
              <TableCell :class="day.questions > 0 && day.extractive / day.questions >= 0.2 && 'text-destructive'">{{ percent(day.extractive, day.questions) }}<span v-if="day.extractive" class="ml-1 text-xs">（{{ day.extractive }}）</span></TableCell>
              <TableCell>{{ duration(day.totalMsP50) }} / {{ duration(day.totalMsP95) }}</TableCell>
              <TableCell>{{ duration(day.firstTokenMsP50) }} / {{ duration(day.firstTokenMsP95) }}</TableCell>
              <TableCell>{{ answerTokens(day).toLocaleString() }} / {{ rewriteTokens(day).toLocaleString() }}</TableCell>
              <TableCell :class="day.negative > 0 && 'text-destructive'">{{ day.negative }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </section>
  </template>
</template>
