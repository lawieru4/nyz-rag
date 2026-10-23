<script setup lang="ts">
import { computed, ref, type Component } from "vue";
import { ArrowUpRight, Check, Clock, Database, Ellipsis, FileText, Info, LoaderCircle, Pause, Play, Plus, RefreshCw, TriangleAlert } from "@lucide/vue";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Progress } from "@nyz-rag/ui/components/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nyz-rag/ui/components/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nyz-rag/ui/components/table";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import PageHeading from "../components/PageHeading.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { client, errorMessage, loadKnowledge, sources, tasks, type Source, type Task } from "../workspace";

defineProps<{ title: string }>();
const emit = defineEmits<{ (e: "navigate", module: string): void }>();

const emptyForm = () => ({ name: "", url: "", kind: "文章 API", frequency: "每天" });
const dialogOpen = ref(false);
const form = ref(emptyForm());
const summary = computed<Array<{ label: string; value: number; unit?: string; hint: string; icon: Component }>>(() => [
  { label: "数据源", value: sources.value.length, hint: "已配置来源", icon: Database },
  { label: "收录文章", value: sources.value.reduce((total, source) => total + source.pages, 0), hint: "来自全部数据源", icon: FileText },
  { label: "执行中任务", value: tasks.value.filter((task) => task.status === "运行中").length, hint: "队列与抓取进度", icon: RefreshCw },
  { label: "最近同步", value: 10, unit: "分钟", hint: "NYZ 文章库", icon: Clock },
]);

const taskState = {
  已完成: { icon: Check, class: "bg-success-soft text-success", progress: "完成", result: "采集完成" },
  运行中: { icon: RefreshCw, class: "bg-secondary text-link", progress: "", result: "正在采集页面" },
  失败: { icon: TriangleAlert, class: "bg-destructive/10 text-destructive", progress: "失败", result: "采集失败" },
  等待中: { icon: LoaderCircle, class: "bg-muted text-muted-foreground", progress: "排队中", result: "等待 Worker" },
} satisfies Record<Task["status"], unknown>;

// 取消时保留已填写的内容，添加成功后才清空。
function openDialog() {
  dialogOpen.value = true;
}

async function addSource() {
  const name = form.value.name.trim();
  const url = form.value.url.trim();
  try {
    const parsed = new URL(url);
    if (!name || !["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    toast.error("请填写名称和有效的 http(s) 地址");
    return;
  }
  try {
    await client.request("/api/admin/sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form.value, name, url }) });
    await loadKnowledge();
    form.value = emptyForm();
    dialogOpen.value = false;
    toast.success("数据源已添加");
  } catch {
    toast.error("数据源添加失败");
  }
}

async function toggleSource(source: Source) {
  const status = source.status === "运行中" ? "已暂停" : "运行中";
  try {
    await client.request(`/api/admin/sources/${source.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
    source.status = status;
    toast.success(status === "运行中" ? "数据源已启用" : "数据源已暂停");
  } catch {
    toast.error("数据源状态更新失败，请检查 API 服务");
  }
}

async function startCrawl(source: Source) {
  try {
    await client.request(`/api/admin/sources/${source.id}/sync`, { method: "POST" });
    await loadKnowledge();
    toast.success(`${source.name} 的同步任务已加入处理队列`);
  } catch (err) {
    toast.error(`同步任务创建失败：${errorMessage(err, "请检查 API 服务")}`);
  }
}
</script>

<template>
  <PageHeading eyebrow="KNOWLEDGE OPERATIONS" :title="title" subtitle="管理内容来源与自动同步任务">
    <Button @click="openDialog"><Plus /> 添加数据源</Button>
  </PageHeading>

  <Card class="mb-8 grid grid-cols-2 gap-0 py-0 lg:grid-cols-4" aria-label="数据源概览">
    <article v-for="item in summary" :key="item.label" class="relative flex min-h-26 flex-col px-5 py-4 max-lg:odd:border-r max-lg:[&:nth-child(-n+2)]:border-b lg:border-r lg:last:border-r-0">
      <span class="text-xs text-muted-foreground">{{ item.label }}</span>
      <strong class="mt-2 text-2xl font-semibold text-primary">{{ item.value }}<span v-if="item.unit" class="ml-1 text-xs font-normal text-muted-foreground">{{ item.unit }}</span></strong>
      <small class="mt-0.5 text-[11px] text-muted-foreground/80">{{ item.hint }}</small>
      <component :is="item.icon" class="absolute top-4 right-4 size-4 text-link/70" aria-hidden="true" />
    </article>
  </Card>

  <section class="mb-7">
    <div class="mb-3 flex items-center justify-between">
      <div><h2 class="text-sm font-semibold">数据源</h2><p class="mt-1 text-xs text-muted-foreground">配置文章接口或站点，并管理同步计划</p></div>
      <Button variant="link" size="sm" class="text-link" @click="emit('navigate', '数据源')">查看全部 <ArrowUpRight /></Button>
    </div>
    <Card class="gap-0 overflow-hidden py-0">
      <Table class="min-w-[750px]">
        <TableHeader class="bg-muted/50"><TableRow><TableHead class="pl-4">名称</TableHead><TableHead>类型</TableHead><TableHead>同步频率</TableHead><TableHead>文章数</TableHead><TableHead>状态</TableHead><TableHead>最近同步</TableHead><TableHead /></TableRow></TableHeader>
        <TableBody>
          <TableRow v-for="source in sources" :key="source.id" class="text-xs text-muted-foreground">
            <TableCell class="py-3 pl-4">
              <div class="flex items-center gap-2.5">
                <span class="grid size-7 place-items-center rounded-md border bg-secondary font-mono text-xs text-link">{{ source.kind === '文章 API' ? 'A' : 'W' }}</span>
                <span class="grid gap-1"><b class="text-xs font-semibold text-foreground">{{ source.name }}</b><small class="max-w-80 truncate text-[11px]">{{ source.url }}</small></span>
              </div>
            </TableCell>
            <TableCell>{{ source.kind }}</TableCell>
            <TableCell>{{ source.frequency }}</TableCell>
            <TableCell class="tabular-nums">{{ source.pages }}</TableCell>
            <TableCell><StatusBadge :on="source.status === '运行中'">{{ source.status }}</StatusBadge></TableCell>
            <TableCell>{{ source.updated }}</TableCell>
            <TableCell>
              <div class="flex justify-end gap-0.5">
                <Button variant="ghost" size="icon-sm" title="立即同步" aria-label="立即同步" @click="startCrawl(source)"><RefreshCw /></Button>
                <Button variant="ghost" size="icon-sm" title="暂停或启用" aria-label="暂停或启用" @click="toggleSource(source)"><Pause v-if="source.status === '运行中'" /><Play v-else /></Button>
                <Button variant="ghost" size="icon-sm" title="更多操作" aria-label="更多操作"><Ellipsis /></Button>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <EmptyState v-if="sources.length === 0">尚未添加数据源 <Button variant="link" size="sm" class="text-link" @click="openDialog">添加第一个来源</Button></EmptyState>
    </Card>
  </section>

  <section class="mb-7">
    <div class="mb-3 flex items-center justify-between">
      <div><h2 class="text-sm font-semibold">抓取任务</h2><p class="mt-1 text-xs text-muted-foreground">查看近期同步状态与处理进度</p></div>
      <Button variant="link" size="sm" class="text-link" @click="emit('navigate', '抓取任务')">任务记录 <ArrowUpRight /></Button>
    </div>
    <Card class="gap-0 py-0">
      <div v-for="task in tasks" :key="task.id" class="flex min-h-14 items-center gap-3 border-b px-4 last:border-b-0">
        <span :class="['grid size-6 flex-none place-items-center rounded-full', taskState[task.status].class]"><component :is="taskState[task.status].icon" class="size-3.5" /></span>
        <div class="grid w-56 min-w-0 gap-1 max-lg:w-44">
          <b class="truncate text-xs font-semibold">{{ task.source }} <span class="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground/70">{{ task.id }}</span></b>
          <small class="truncate text-[11px] text-muted-foreground">{{ task.error || task.started }}</small>
        </div>
        <div class="flex max-w-68 flex-1 items-center gap-2.5">
          <Progress :model-value="task.progress" class="h-1" />
          <small class="min-w-10 text-[11px] text-muted-foreground">{{ task.status === '运行中' ? `${task.progress}%` : taskState[task.status].progress }}</small>
        </div>
        <span class="w-32 text-[11px] text-muted-foreground max-md:hidden">{{ taskState[task.status].result }}</span>
        <Button variant="ghost" size="icon-sm" class="ml-auto" aria-label="任务选项"><Ellipsis /></Button>
      </div>
      <EmptyState v-if="tasks.length === 0">暂无同步任务</EmptyState>
    </Card>
  </section>
  <footer class="flex items-center gap-2 px-0.5 py-3 text-[11px] text-muted-foreground"><Info class="size-3.5 flex-none" />网页站点按 robots.txt 与请求间隔限制采集；文章 API 来源按 updateTime 增量同步，token 由 Worker 环境变量提供。</footer>

  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-md" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[10px] font-medium tracking-wider text-link">NEW CONNECTION</p>
        <DialogTitle>添加数据源</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="addSource">
        <div class="grid gap-2"><Label for="source-name">数据源名称</Label><Input id="source-name" v-model="form.name" autofocus placeholder="例如：产品帮助中心" required /></div>
        <div class="grid gap-2"><Label for="source-url">来源地址</Label><Input id="source-url" v-model="form.url" type="url" :placeholder="form.kind === '文章 API' ? 'https://nyzdata.nenghe.com/nyzfoxx/article?tagKey=…' : 'https://example.com'" required /></div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-2">
            <Label for="source-kind">来源类型</Label>
            <Select v-model="form.kind"><SelectTrigger id="source-kind" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="kind in ['文章 API', '网页站点']" :key="kind" :value="kind">{{ kind }}</SelectItem></SelectContent></Select>
          </div>
          <div class="grid gap-2">
            <Label for="source-frequency">同步频率</Label>
            <Select v-model="form.frequency"><SelectTrigger id="source-frequency" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="frequency in ['每小时', '每 6 小时', '每天', '手动']" :key="frequency" :value="frequency">{{ frequency }}</SelectItem></SelectContent></Select>
          </div>
        </div>
        <p class="rounded-md bg-secondary p-2.5 text-[11px] leading-relaxed text-secondary-foreground">新增来源默认暂停，确认授权和抓取规则后再启动。文章 API 填写文章列表接口地址（不含 token），token 在 Worker 环境变量 NYZ_ARTICLE_TOKEN 中配置。</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="dialogOpen = false">取消</Button>
          <Button type="submit">添加来源</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
