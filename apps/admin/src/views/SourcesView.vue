<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component } from "vue";
import { Check, Clock, Database, FileText, Info, LoaderCircle, Pause, Play, Plus, RefreshCw, TriangleAlert } from "@lucide/vue";
import type { SourceFrequency, UpdateSourceRequest } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { Progress } from "@nyz-rag/ui/components/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nyz-rag/ui/components/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nyz-rag/ui/components/table";
import { toast } from "@nyz-rag/ui/lib/toast";
import ArticleTokenSettings from "../components/ArticleTokenSettings.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeading from "../components/PageHeading.vue";
import SourceCreateDialog from "../components/SourceCreateDialog.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { usePending } from "../composables/usePending";
import { can, client, errorMessage, isSourceFrequency, loadKnowledge, refreshAfterWrite, sourceFrequencies, sources, tasks, watchKnowledge, type Source, type Task } from "../workspace";

defineProps<{ title: string }>();

const dialogOpen = ref(false);

// 进入页面时重新加载，避免显示登录时缓存的旧列表，之后由服务端推送同步进度；每分钟刷新一次相对时间。
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let unwatch: (() => void) | undefined;
onMounted(() => {
  loadKnowledge().catch(() => { toast.error("数据源加载失败，请检查 API 服务"); });
  unwatch = watchKnowledge();
  clock = setInterval(() => { now.value = Date.now(); }, 60_000);
});
onUnmounted(() => {
  unwatch?.();
  clearInterval(clock);
});

/** 最近一次同步完成的数据源，以及距今的时间（值 + 单位）。 */
const lastSync = computed(() => {
  const latest = sources.value.filter((source) => source.syncedAt).sort((a, b) => Date.parse(b.syncedAt!) - Date.parse(a.syncedAt!))[0];
  if (!latest) return { value: "—", hint: "尚未同步" };
  const minutes = Math.max(0, Math.floor((now.value - Date.parse(latest.syncedAt!)) / 60_000));
  const [value, unit] = minutes < 1 ? ["刚刚", undefined] : minutes < 60 ? [minutes, "分钟前"] : minutes < 1440 ? [Math.floor(minutes / 60), "小时前"] : [Math.floor(minutes / 1440), "天前"];
  return { value, unit, hint: latest.name };
});

const remoteTotal = computed(() => {
  const known = sources.value.filter((source) => source.remoteTotal !== null);
  return known.length ? known.reduce((total, source) => total + source.remoteTotal!, 0) : null;
});

const summary = computed<Array<{ label: string; value: number | string; unit?: string; hint: string; icon: Component }>>(() => [
  { label: "数据源", value: sources.value.length, hint: "已配置来源", icon: Database },
  {
    label: "已入库文章", value: sources.value.reduce((total, source) => total + source.pages, 0).toLocaleString(), icon: FileText,
    hint: remoteTotal.value === null ? "同步后显示接口文章总数" : `接口共 ${remoteTotal.value.toLocaleString()} 篇`,
  },
  { label: "执行中任务", value: tasks.value.filter((task) => task.status === "运行中").length, hint: "队列与抓取进度", icon: RefreshCw },
  { label: "最近同步", ...lastSync.value, icon: Clock },
]);

/** 入库进度：已入库 / 接口总数，以及首次全量同步是否完成。 */
function coverage(source: Source) {
  if (source.remoteTotal === null) return { percent: null, hint: source.syncedAt || source.pages ? "接口总数将在下次同步时获取" : "尚未同步" };
  return {
    percent: source.remoteTotal ? Math.min(100, Math.round(source.pages / source.remoteTotal * 100)) : 100,
    hint: source.backfillDone ? "已完成全量同步" : `全量同步未完成，约剩 ${Math.max(0, source.remoteTotal - source.pages).toLocaleString()} 篇`,
  };
}
const sourceRows = computed(() => sources.value.map((source) => ({ source, coverage: coverage(source) })));

const taskState = {
  已完成: { icon: Check, class: "bg-success-soft text-success", progress: "完成", result: "同步完成" },
  运行中: { icon: RefreshCw, class: "bg-secondary text-link", progress: "", result: "正在同步文章" },
  失败: { icon: TriangleAlert, class: "bg-destructive-soft text-destructive", progress: "失败", result: "同步失败" },
  等待中: { icon: LoaderCircle, class: "bg-muted text-muted-foreground", progress: "排队中", result: "等待 Worker" },
} satisfies Record<Task["status"], unknown>;

/** 运行中显示「已处理 / 单次上限」；进度条按已处理篇数计算，结束后为 100%。 */
function taskProgress(task: Task) {
  const handled = task.processedCount + task.failedCount;
  if (task.status === "运行中") {
    if (!task.articleLimit) return { value: 0, label: "准备中" };
    return { value: Math.min(100, Math.round(handled / task.articleLimit * 100)), label: `${handled} / ${task.articleLimit} 篇` };
  }
  // 升级前的任务没有计数（没有 articleLimit）。
  if (task.status === "已完成") return { value: 100, label: !task.articleLimit ? "完成" : handled ? `完成 · ${task.processedCount} 篇` : "完成 · 无更新" };
  return { value: task.progress, label: taskState[task.status].progress };
}

// 已有排队或运行中任务的数据源不能再次同步（服务端同样会拒绝）。
const syncingSources = computed(() => new Set(tasks.value.filter((task) => task.status === "等待中" || task.status === "运行中").map((task) => task.sourceId)));

// 同一数据源的启停与同步在完成前不再重复提交。
const { isPending, run } = usePending();

function toggleSource(source: Source) {
  return run(source.id, async () => {
    const status = source.status === "运行中" ? "已暂停" : "运行中";
    try {
      await client.request(`/api/admin/sources/${source.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status } satisfies UpdateSourceRequest) });
    } catch {
      toast.error("数据源状态更新失败，请检查 API 服务");
      return;
    }
    source.status = status;
    toast.success(status === "运行中" ? "数据源已启用" : "数据源已暂停");
  });
}

/** 空值和无法识别的频率不会自动同步，下拉框显示占位文字。 */
const frequencyValue = (source: Source) => isSourceFrequency(source.frequency) ? source.frequency : "";
const frequencyLabel = (source: Source) => frequencyValue(source) || "未设置（手动）";

function changeFrequency(source: Source, frequency: SourceFrequency) {
  if (frequency === source.frequency) return;
  return run(source.id, async () => {
    try {
      await client.request(`/api/admin/sources/${source.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ frequency } satisfies UpdateSourceRequest) });
    } catch (err) {
      toast.error(`同步频率更新失败：${errorMessage(err, "请检查 API 服务")}`);
      return;
    }
    source.frequency = frequency;
    toast.success(frequency === "手动" ? "已改为手动同步" : `同步频率已改为${frequency}`);
  });
}

function startCrawl(source: Source) {
  return run(source.id, async () => {
    try {
      await client.request(`/api/admin/sources/${source.id}/sync`, { method: "POST" });
    } catch (err) {
      toast.error(`同步任务创建失败：${errorMessage(err, "请检查 API 服务")}`);
      return;
    }
    toast.success(`${source.name} 的同步任务已加入处理队列`);
    await refreshAfterWrite(loadKnowledge);
  });
}
</script>

<template>
  <PageHeading eyebrow="KNOWLEDGE OPERATIONS" :title="title" subtitle="管理内容来源与自动同步任务">
    <Button v-if="can('sources:manage')" @click="dialogOpen = true"><Plus /> 添加数据源</Button>
  </PageHeading>

  <Card class="mb-8 grid grid-cols-2 gap-0 py-0 lg:grid-cols-4" aria-label="数据源概览">
    <article v-for="item in summary" :key="item.label" class="relative flex min-h-26 flex-col px-5 py-4 max-lg:odd:border-r max-lg:[&:nth-child(-n+2)]:border-b lg:border-r lg:last:border-r-0">
      <span class="text-xs text-muted-foreground">{{ item.label }}</span>
      <strong class="mt-2 text-[28px] leading-tight font-semibold text-foreground tabular-nums">{{ item.value }}<span v-if="item.unit" class="ml-1 text-xs font-normal text-muted-foreground">{{ item.unit }}</span></strong>
      <small class="mt-0.5 text-xs text-muted-foreground">{{ item.hint }}</small>
      <component :is="item.icon" class="absolute top-4 right-4 size-4 text-link/70" aria-hidden="true" />
    </article>
  </Card>

  <ArticleTokenSettings />

  <section class="mb-7">
    <div class="mb-3"><h2 class="text-sm font-semibold">数据源</h2><p class="mt-1 text-xs text-muted-foreground">配置 nyzdata 文章接口，并管理同步计划</p></div>
    <Card class="gap-0 overflow-hidden py-0">
      <!-- 手机端（<768px）用下方的摘要列表，与表格共用数据和操作 -->
      <Table class="min-w-[750px]" container-class="max-md:hidden">
        <TableHeader class="bg-muted/50"><TableRow><TableHead class="pl-4">名称</TableHead><TableHead>同步频率</TableHead><TableHead title="已入库文章数 / 最近一次同步时接口返回的文章总数">已入库 / 接口总数</TableHead><TableHead>状态</TableHead><TableHead>最近同步</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          <TableRow v-for="{ source, coverage } in sourceRows" :key="source.id" class="text-[13px] text-muted-foreground">
            <TableCell class="py-3 pl-4">
              <div class="flex items-center gap-2.5">
                <span class="grid size-7 place-items-center rounded-md border bg-secondary font-mono text-xs text-link">A</span>
                <span class="grid gap-1"><b class="text-sm font-semibold text-foreground">{{ source.name }}</b><small class="max-w-80 truncate text-xs">{{ source.url }}</small></span>
              </div>
            </TableCell>
            <TableCell>
              <Select v-if="can('sources:manage')" :model-value="frequencyValue(source)" :disabled="isPending(source.id)" @update:model-value="(value) => changeFrequency(source, value as SourceFrequency)">
                <SelectTrigger size="sm" class="w-36" aria-label="同步频率"><SelectValue placeholder="未设置（手动）" /></SelectTrigger>
                <SelectContent><SelectItem v-for="frequency in sourceFrequencies" :key="frequency" :value="frequency">{{ frequency }}</SelectItem></SelectContent>
              </Select>
              <template v-else>{{ frequencyLabel(source) }}</template>
            </TableCell>
            <TableCell>
              <div class="grid w-52 gap-1.5">
                <span class="tabular-nums"><b class="font-semibold text-foreground">{{ source.pages.toLocaleString() }}</b> / {{ source.remoteTotal?.toLocaleString() ?? "—" }}<span v-if="coverage.percent !== null" class="ml-1.5 text-xs">{{ coverage.percent }}%</span></span>
                <Progress v-if="coverage.percent !== null" :model-value="coverage.percent" class="h-1" />
                <small class="text-xs tabular-nums">{{ coverage.hint }}<span v-if="source.failedCount" class="text-destructive"> · {{ source.failedCount }} 篇失败待重试</span></small>
              </div>
            </TableCell>
            <TableCell><StatusBadge :on="source.status === '运行中'">{{ source.status }}</StatusBadge></TableCell>
            <TableCell>{{ source.updated }}</TableCell>
            <TableCell>
              <div v-if="can('sources:manage')" class="flex justify-end gap-0.5">
                <Button variant="ghost" size="icon-sm" :title="syncingSources.has(source.id) ? '同步进行中' : '立即同步'" aria-label="立即同步" :disabled="syncingSources.has(source.id) || isPending(source.id)" @click="startCrawl(source)"><RefreshCw :class="syncingSources.has(source.id) && 'animate-spin'" /></Button>
                <Button variant="ghost" size="icon-sm" title="暂停或启用" aria-label="暂停或启用" :disabled="isPending(source.id)" @click="toggleSource(source)"><Pause v-if="source.status === '运行中'" /><Play v-else /></Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <ul class="divide-y md:hidden" aria-label="数据源列表">
        <li v-for="{ source, coverage } in sourceRows" :key="source.id" class="grid gap-3 px-4 py-3.5 text-[13px] text-muted-foreground">
          <div class="flex items-start gap-2.5">
            <span class="grid size-7 flex-none place-items-center rounded-md border bg-secondary font-mono text-xs text-link">A</span>
            <span class="grid min-w-0 flex-1 gap-1"><b class="text-sm font-semibold break-words text-foreground">{{ source.name }}</b><small class="text-xs wrap-anywhere">{{ source.url }}</small></span>
            <StatusBadge :on="source.status === '运行中'">{{ source.status }}</StatusBadge>
          </div>
          <div class="grid gap-1.5">
            <span class="tabular-nums"><span class="text-xs">已入库 / 接口总数</span> <b class="font-semibold text-foreground">{{ source.pages.toLocaleString() }}</b> / {{ source.remoteTotal?.toLocaleString() ?? "—" }}<span v-if="coverage.percent !== null" class="ml-1.5 text-xs">{{ coverage.percent }}%</span></span>
            <Progress v-if="coverage.percent !== null" :model-value="coverage.percent" class="h-1" />
            <small class="text-xs tabular-nums">{{ coverage.hint }}<span v-if="source.failedCount" class="text-destructive"> · {{ source.failedCount }} 篇失败待重试</span></small>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span v-if="can('sources:manage')">最近同步 {{ source.updated }}</span>
            <span v-else>{{ frequencyLabel(source) }} · 最近同步 {{ source.updated }}</span>
            <div v-if="can('sources:manage')" class="flex gap-1.5">
              <Button variant="outline" size="sm" :disabled="syncingSources.has(source.id) || isPending(source.id)" @click="startCrawl(source)"><RefreshCw :class="syncingSources.has(source.id) && 'animate-spin'" />{{ syncingSources.has(source.id) ? '同步中' : '立即同步' }}</Button>
              <Button variant="outline" size="sm" :disabled="isPending(source.id)" @click="toggleSource(source)"><template v-if="source.status === '运行中'"><Pause />暂停</template><template v-else><Play />启用</template></Button>
            </div>
          </div>
          <div v-if="can('sources:manage')" class="flex items-center justify-between gap-2 text-xs">
            <span>同步频率</span>
            <Select :model-value="frequencyValue(source)" :disabled="isPending(source.id)" @update:model-value="(value) => changeFrequency(source, value as SourceFrequency)">
              <SelectTrigger size="sm" class="w-36" aria-label="同步频率"><SelectValue placeholder="未设置（手动）" /></SelectTrigger>
              <SelectContent><SelectItem v-for="frequency in sourceFrequencies" :key="frequency" :value="frequency">{{ frequency }}</SelectItem></SelectContent>
            </Select>
          </div>
        </li>
      </ul>
      <EmptyState v-if="sources.length === 0">尚未添加数据源 <Button v-if="can('sources:manage')" variant="link" size="sm" class="text-link" @click="dialogOpen = true">添加第一个来源</Button></EmptyState>
    </Card>
  </section>

  <section class="mb-7">
    <div class="mb-3"><h2 class="text-sm font-semibold">抓取任务</h2><p class="mt-1 text-xs text-muted-foreground">查看近期同步状态与处理进度</p></div>
    <Card class="gap-0 py-0">
      <!-- 小于 768px 时进度与结果各占一行，与任务名称左对齐 -->
      <div v-for="task in tasks" :key="task.id" class="flex min-h-14 items-center gap-3 border-b px-4 last:border-b-0 max-md:flex-wrap max-md:gap-y-1.5 max-md:py-3">
        <span :class="['grid size-6 flex-none place-items-center rounded-full', taskState[task.status].class]"><component :is="taskState[task.status].icon" class="size-3.5" /></span>
        <div class="grid w-56 min-w-0 gap-1 max-lg:w-44 max-md:w-auto max-md:flex-1">
          <b class="truncate text-xs font-semibold">{{ task.source }} <span class="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground" :title="task.id">{{ task.id.startsWith('CR-') ? task.id : task.id.slice(0, 8) }}</span></b>
          <small class="truncate text-xs text-muted-foreground max-md:whitespace-normal max-md:wrap-anywhere">{{ task.error || task.started }}</small>
        </div>
        <div class="flex max-w-80 flex-1 items-center gap-2.5 max-md:max-w-none max-md:basis-full max-md:pl-9">
          <Progress :model-value="taskProgress(task).value" class="h-1" />
          <small class="min-w-24 text-xs whitespace-nowrap text-muted-foreground tabular-nums">{{ taskProgress(task).label }}</small>
        </div>
        <span class="ml-auto w-32 text-xs text-muted-foreground tabular-nums max-md:ml-0 max-md:w-auto max-md:basis-full max-md:pl-9">{{ taskState[task.status].result }}<span v-if="task.failedCount" class="text-destructive"> · {{ task.failedCount }} 篇失败</span></span>
      </div>
      <EmptyState v-if="tasks.length === 0">暂无同步任务</EmptyState>
    </Card>
  </section>
  <footer class="flex items-center gap-2 px-0.5 py-3 text-xs text-muted-foreground"><Info class="size-3.5 flex-none" />数据源按 updateTime 增量同步 nyzdata 文章，启用后按同步频率自动执行（手动或未设置时只在点击「立即同步」时执行），单次同步有篇数上限，首次全量同步需多次执行；接口总数取自最近一次同步，无正文（如 VIP）的文章会计入失败。</footer>

  <SourceCreateDialog v-model:open="dialogOpen" :refresh-sources="loadKnowledge" />
</template>
