<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { ArrowUpRight, KeyRound, LogOut, Menu, SlidersHorizontal, Square, SquarePen, X } from "@lucide/vue";
import type {
  ChatFeedbackRating, KnowledgeStats,
  RetrievalFilters, UserAccount, UserSessionResponse,
} from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@nyz-rag/ui/components/collapsible";
import { confirm, ConfirmDialog } from "@nyz-rag/ui/confirm";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@nyz-rag/ui/components/dropdown-menu";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@nyz-rag/ui/components/sheet";
import { Textarea } from "@nyz-rag/ui/components/textarea";
import { Toaster } from "@nyz-rag/ui/components/sonner";
import { TooltipProvider } from "@nyz-rag/ui/components/tooltip";
import { toast } from "@nyz-rag/ui/lib/toast";
import AccountDialog, { type AccountMode } from "./AccountDialog.vue";
import ArticleView from "./components/ArticleView.vue";
import IconButton from "./components/IconButton.vue";
import ChatTurn from "./components/ChatTurn.vue";
import SessionSidebar from "./components/SessionSidebar.vue";
import SourcePanel from "./components/SourcePanel.vue";
import { client } from "./webClient";
import { useChatSession, type ChatTurnState } from "./composables/useChatSession";

const user = ref<UserAccount | null>(null);
const accountMode = ref<AccountMode | null>(null);
const accountNotice = ref("");
/** 知识库统计；null 表示尚未加载成功。 */
const stats = ref<KnowledgeStats | null>(null);
const statsError = ref(false);
const STATS_REFRESH_MS = 60_000;
let statsTimer: ReturnType<typeof setInterval> | undefined;
const thread = ref<HTMLElement | null>(null);
/** 当前打开的文章 ID（`#/documents/<id>`）；空字符串表示地址无效，null 表示在问答页。 */
const articleId = ref<string | null>(null);
const dateFrom = ref("");
const dateTo = ref("");
const categoriesText = ref("");
const tagsText = ref("");
const scenariosText = ref("");
const copyTimers = new WeakMap<ChatTurnState, ReturnType<typeof setTimeout>>();
/** 窄屏下的会话抽屉。 */
const sidebarOpen = ref(false);
const filtersOpen = ref(false);
/** 正在查看引用来源的问答轮次与引用编号；宽屏时作为第三栏，否则以抽屉显示。 */
const citing = ref<{ turn: number; citation: number | null } | null>(null);
const wideQuery = window.matchMedia("(min-width: 1280px)");
const wide = ref(wideQuery.matches);
function onWideChange(event: MediaQueryListEvent) { wide.value = event.matches; }

const { question, busy, sessions, sessionId, turns, sessionError, loadSessions, openSession, newSession, restoreSession, ask, regenerate, stop } = useChatSession({
  client,
  storage: localStorage,
  currentFilters,
  onSessionChange: () => { citing.value = null; },
  onContentChange: scrollToEnd,
});

const activeFilterCount = computed(() => [dateFrom.value, dateTo.value, categoriesText.value, tagsText.value, scenariosText.value].filter(Boolean).length);
const filterFields = [
  { id: "filter-from", label: "发布日期自", model: dateFrom, type: "date", aria: "发布日期起始日期" },
  { id: "filter-to", label: "至", model: dateTo, type: "date", aria: "发布日期结束日期" },
  { id: "filter-categories", label: "分类", model: categoriesText, type: "text", aria: "分类筛选" },
  { id: "filter-tags", label: "标签", model: tagsText, type: "text", aria: "标签筛选" },
  { id: "filter-scenarios", label: "场景", model: scenariosText, type: "text", aria: "场景筛选" },
];

function listValues(text: string) { return [...new Set(text.split(",").map((value) => value.trim()).filter(Boolean))]; }
function currentFilters(): RetrievalFilters | undefined {
  const filters: RetrievalFilters = {};
  if (dateFrom.value) filters.publishedFrom = dateFrom.value;
  if (dateTo.value) filters.publishedTo = dateTo.value;
  const categories = listValues(categoriesText.value); if (categories.length) filters.categories = categories;
  const tags = listValues(tagsText.value); if (tags.length) filters.tags = tags;
  const scenarios = listValues(scenariosText.value); if (scenarios.length) filters.scenarios = scenarios;
  return Object.keys(filters).length ? filters : undefined;
}

function syncArticleRoute() {
  const match = location.hash.match(/^#\/documents\/(.*)$/);
  if (!match) { articleId.value = null; return; }
  try { articleId.value = decodeURIComponent(match[1]); } catch { articleId.value = ""; }
}

function clearFilters() { dateFrom.value = ""; dateTo.value = ""; categoriesText.value = ""; tagsText.value = ""; scenariosText.value = ""; }

const citedTurn = computed(() => citing.value ? turns.value[citing.value.turn] : undefined);
const sourceSheetOpen = computed({
  get: () => !!citedTurn.value && !wide.value,
  set: (open) => { if (!open) citing.value = null; },
});
function openSources(turn: number, citation: number | null) { citing.value = { turn, citation }; }
const sessionTitle = computed(() => sessions.value.find((session) => session.id === sessionId.value)?.title || turns.value[0]?.question || "");
const sidebarProps = computed(() => ({
  sessions: sessions.value, sessionId: sessionId.value, sessionError: sessionError.value, busy: busy.value,
  user: user.value, stats: stats.value, statsError: statsError.value,
}));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return client.request<T>(path, init);
}

onMounted(async () => {
  window.addEventListener("hashchange", syncArticleRoute);
  syncArticleRoute();
  // 会话按身份隔离：先确定身份（同时取得访客 Cookie），再加载历史会话，避免并发请求各自分配访客身份。
  try { user.value = (await api<UserSessionResponse>("/api/auth/session")).user; } catch { /* 按访客继续 */ }
  void loadSessions();
  restoreSession();
  // 统计会随管理端同步变化：页面可见时定时刷新，切回页面时立即刷新。
  document.addEventListener("visibilitychange", onVisibilityChange);
  wideQuery.addEventListener("change", onWideChange);
  statsTimer = setInterval(() => { if (!document.hidden) void loadStats(); }, STATS_REFRESH_MS);
  void loadStats();
});

onUnmounted(() => {
  window.removeEventListener("hashchange", syncArticleRoute);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  wideQuery.removeEventListener("change", onWideChange);
  clearInterval(statsTimer);
});

async function loadStats() {
  try {
    stats.value = (await api<{ stats: KnowledgeStats }>("/api/knowledge")).stats;
    statsError.value = false;
  } catch {
    statsError.value = true;
  }
}

function onVisibilityChange() {
  if (!document.hidden) void loadStats();
}

/** 抽屉中的操作：先关闭抽屉再执行。 */
function closeSidebar(action: () => unknown) {
  sidebarOpen.value = false;
  void action();
}

function openAccount(mode: AccountMode) {
  accountNotice.value = "";
  accountMode.value = mode;
}

/** 登录、注册或重置密码成功：本浏览器的访客会话已归入账号，当前会话保持打开。 */
function onAuthenticated(account: UserAccount) {
  user.value = account;
  accountMode.value = null;
  sessionError.value = "";
  void loadSessions();
}

function onPasswordChanged() {
  accountMode.value = null;
  accountNotice.value = "密码已修改，其他设备上的登录已失效。";
}

async function logout() {
  if (busy.value) return;
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "退出失败");
    return;
  }
  // 退出后浏览器成为新的访客，账号中的会话不再可见。
  user.value = null;
  newSession();
  sessions.value = [];
  void loadSessions();
}

async function removeSession(id: string) {
  if (busy.value || !await confirm({ title: "删除会话", description: "删除这个会话及其全部问答？", confirmText: "删除", destructive: true })) return;
  try {
    await api(`/api/chat/sessions/${id}`, { method: "DELETE" });
    sessions.value = sessions.value.filter((session) => session.id !== id);
    if (sessionId.value === id) newSession();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "删除失败");
  }
}

async function scrollToEnd() {
  await nextTick();
  thread.value?.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
}

async function copy(turn: ChatTurnState) {
  try {
    await navigator.clipboard.writeText(turn.answer);
  } catch {
    // 非 HTTPS 页面没有剪贴板 API。
    const textarea = document.createElement("textarea");
    textarea.value = turn.answer;
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  turn.copied = true;
  clearTimeout(copyTimers.get(turn));
  copyTimers.set(turn, setTimeout(() => { turn.copied = false; }, 2500));
}

async function sendFeedback(turn: ChatTurnState, rating: ChatFeedbackRating) {
  if (!turn.id || turn.feedbackBusy || turn.rating) return;
  turn.feedbackBusy = true;
  try {
    await api(`/api/messages/${turn.id}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rating }) });
    turn.rating = rating;
  } catch {
    toast.error("评价提交失败，请稍后重试。");
  } finally {
    turn.feedbackBusy = false;
  }
}

function useSuggestion(text: string) {
  question.value = text;
}
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <main class="min-h-dvh">
      <header class="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 bg-background/85 px-5 backdrop-blur max-sm:px-3">
        <div class="flex min-w-0 items-center gap-1.5">
          <IconButton v-if="articleId === null" label="历史会话" class="lg:hidden" @click="sidebarOpen = true"><Menu /></IconButton>
          <a class="flex items-center gap-2 text-sm max-sm:gap-1 max-sm:text-[13px]" href="#/" aria-label="能知首页"><img src="/logo.png" alt="能知" class="h-12 w-36 object-contain max-sm:h-10 max-sm:w-30" /><span class="font-medium text-muted-foreground">知识助手</span></a>
        </div>
        <div class="flex items-center gap-2">
          <IconButton v-if="articleId === null" label="新对话" class="lg:hidden" :disabled="busy" @click="newSession"><SquarePen /></IconButton>
          <DropdownMenu v-if="user">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" class="h-8 max-w-55 gap-2 pr-2.5 pl-1 text-xs font-normal max-sm:pr-1">
                <span class="grid size-6 flex-none place-items-center rounded-[5px] bg-brand-soft text-[11px] font-semibold text-accent-foreground">{{ user.email.slice(0, 1).toUpperCase() }}</span>
                <span class="truncate max-sm:hidden">{{ user.email }}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-36">
              <DropdownMenuItem @select="openAccount('password')"><KeyRound />修改密码</DropdownMenuItem>
              <DropdownMenuItem :disabled="busy" @select="logout"><LogOut />退出登录</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button v-else variant="secondary" size="sm" class="text-xs" @click="openAccount('login')">登录 / 注册</Button>
        </div>
      </header>
      <p v-if="accountNotice" class="flex items-center justify-center gap-2.5 bg-secondary px-4 py-2 text-xs text-secondary-foreground" role="status">
        {{ accountNotice }}<Button variant="ghost" size="icon-xs" aria-label="关闭提示" @click="accountNotice = ''"><X /></Button>
      </p>
      <AccountDialog v-if="accountMode" v-model:mode="accountMode" @close="accountMode = null" @authenticated="onAuthenticated" @password-changed="onPasswordChanged" />

      <ArticleView v-if="articleId !== null" :id="articleId" />

      <div v-show="articleId === null" :class="['lg:grid', citedTurn && wide ? 'lg:grid-cols-[264px_minmax(0,1fr)_380px]' : 'lg:grid-cols-[264px_minmax(0,1fr)]']">
        <aside class="sticky top-14 h-[calc(100dvh-3.5rem)] bg-panel max-lg:hidden">
          <SessionSidebar v-bind="sidebarProps" @new="newSession" @open="openSession" @remove="removeSession" @login="openAccount('login')" />
        </aside>
        <Sheet v-model:open="sidebarOpen">
          <SheetContent side="left" class="w-72 gap-0 bg-panel p-0 pt-10">
            <SheetTitle class="sr-only">历史会话</SheetTitle>
            <SheetDescription class="sr-only">切换或删除历史会话，查看知识库状态</SheetDescription>
            <SessionSidebar
              v-bind="sidebarProps"
              @new="closeSidebar(newSession)" @open="(id) => closeSidebar(() => openSession(id))"
              @remove="removeSession" @login="closeSidebar(() => openAccount('login'))"
            />
          </SheetContent>
        </Sheet>

        <section :class="['mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-200 flex-col px-8 max-sm:px-4', turns.length ? 'pt-8' : 'justify-center pt-12 pb-[12vh] max-sm:pt-8']">
          <div v-if="!turns.length" class="mb-7">
            <p class="eyebrow mb-4">能知 · 新能源知识助手</p>
            <h1 class="text-[34px] leading-[1.35] font-semibold max-sm:text-[28px]">从文章中，<span class="text-[#788648]">找到有据可查的答案。</span></h1>
            <p class="mt-3 text-sm text-muted-foreground">向知识库提问，回答将基于已收录的文章内容。</p>
          </div>
          <h1 v-else class="mb-5 truncate text-[15px] font-semibold">{{ sessionTitle }}</h1>

          <div v-if="turns.length" ref="thread" class="grid gap-6 pb-6">
            <ChatTurn
              v-for="(turn, index) in turns" :key="turn.id ?? `pending-${index}`"
              :turn="turn" :is-last="index === turns.length - 1" :busy="busy"
              :active-citation="citing?.turn === index ? citing.citation : null"
              @copy="copy(turn)" @retry="regenerate" @feedback="(rating) => sendFeedback(turn, rating)"
              @source="(citation) => openSources(index, citation)"
            />
          </div>

          <!-- 对话中输入框固定在底部；空会话时随引导内容居中。 -->
          <div :class="turns.length > 0 && 'sticky bottom-0 mt-auto bg-linear-to-t from-background from-75% to-transparent pt-5'">
            <!-- 输入框不画边框，聚焦时用双环阴影（细实环 + 浅色光晕）表示 -->
            <form
              class="overflow-hidden rounded-lg bg-card shadow-[0_3px_12px_#202b1410] transition-shadow duration-200 has-[textarea:focus-visible]:shadow-[0_0_0_1px_var(--ring),0_0_0_4px_color-mix(in_oklab,var(--ring)_22%,transparent),0_3px_12px_#202b1414]"
              @submit.prevent="ask"
            >
              <Collapsible v-slot="{ open }" v-model:open="filtersOpen">
                <!-- 常驻挂载，用 grid-rows 0fr → 1fr 过渡高度；收起后 invisible，筛选项不会被 Tab 选中 -->
                <CollapsibleContent force-mount class="grid transition-[grid-template-rows,visibility] duration-250 ease-out data-[state=closed]:invisible data-[state=closed]:grid-rows-[0fr] data-[state=open]:grid-rows-[1fr]">
                  <div class="min-h-0 overflow-hidden"><div class="bg-background/70 px-4 pt-3.5 pb-3">
                    <div class="grid grid-cols-5 gap-2.5 max-md:grid-cols-2 max-sm:grid-cols-1">
                      <div v-for="field in filterFields" :key="field.id" class="grid gap-1">
                        <Label :for="field.id" class="text-[11px] font-normal text-muted-foreground">{{ field.label }}</Label>
                        <Input :id="field.id" v-model="field.model.value" :type="field.type" class="h-8 border-transparent bg-card text-xs shadow-none md:text-xs" :placeholder="field.type === 'text' ? '逗号分隔' : undefined" :aria-label="field.aria" />
                      </div>
                    </div>
                    <p class="mt-2 text-[10px] text-muted-foreground">
                      本次提问及重新生成将按当前检索范围筛选，分类、标签、场景需与文章中的值完全一致。
                      <Button v-if="activeFilterCount" type="button" variant="link" class="h-auto p-0 text-[10px] text-link" @click="clearFilters">清除筛选</Button>
                    </p>
                  </div></div>
                </CollapsibleContent>
                <Label for="question" class="sr-only">{{ turns.length ? '继续提问' : '你的问题' }}</Label>
                <Textarea
                  id="question" v-model="question" :rows="turns.length ? 2 : 3"
                  class="max-h-60 min-h-0 resize-none rounded-none border-0 bg-transparent px-4 pt-3.5 shadow-none focus-visible:ring-0 md:text-sm"
                  :placeholder="turns.length ? '继续提问…' : '例如：文章中提到的核心观点是什么？'"
                  @keydown.meta.enter.prevent="ask" @keydown.ctrl.enter.prevent="ask"
                />
                <div class="flex items-center justify-between gap-2 px-3 pb-2.5">
                  <CollapsibleTrigger as-child>
                    <Button type="button" variant="ghost" size="xs" :class="['text-[11px] font-normal text-muted-foreground', (open || activeFilterCount > 0) && 'bg-secondary text-[#5d6b37]']">
                      <SlidersHorizontal />检索范围<span v-if="activeFilterCount" class="font-mono">· {{ activeFilterCount }}</span>
                    </Button>
                  </CollapsibleTrigger>
                  <div class="flex items-center gap-3">
                    <span class="font-mono text-[10px] text-muted-foreground/80 max-sm:hidden">⌘/Ctrl + Enter 提交</span>
                    <Button v-if="busy" type="button" size="sm" @click="stop">停止生成 <Square class="fill-current" /></Button>
                    <Button v-else type="submit" size="sm" :disabled="!question.trim()">提问 <ArrowUpRight /></Button>
                  </div>
                </div>
              </Collapsible>
            </form>
            <p class="py-2.5 text-center text-[10px] text-muted-foreground/80">回答由知识库内容生成，请结合原文核实重要信息。</p>
          </div>

          <div v-if="!turns.length" class="mt-5 grid gap-2">
            <p class="mb-0.5 text-[11px] text-muted-foreground">试试这样提问</p>
            <Button v-for="text in ['最近收录的文章有哪些主要主题？', '帮我总结一篇文章的核心观点']" :key="text" variant="ghost" class="h-auto min-h-10 justify-between bg-card py-2 text-left text-xs font-normal whitespace-normal text-[#505a54]" @click="useSuggestion(text)">{{ text }} <ArrowUpRight class="text-[#87934d]" /></Button>
          </div>
        </section>

        <aside v-if="citedTurn && wide" class="sticky top-14 h-[calc(100dvh-3.5rem)] bg-panel" aria-label="引用来源">
          <SourcePanel :sources="citedTurn.sources" :active-citation="citing!.citation" :question="citedTurn.question" closable @close="citing = null" @select="(citation) => openSources(citing!.turn, citation)" />
        </aside>
        <Sheet v-model:open="sourceSheetOpen">
          <SheetContent side="right" class="w-[min(92vw,400px)] gap-0 bg-panel p-0 pt-8 sm:max-w-none">
            <SheetTitle class="sr-only">引用来源</SheetTitle>
            <SheetDescription class="sr-only">本轮回答引用的文章与原文片段</SheetDescription>
            <SourcePanel v-if="citedTurn" :sources="citedTurn.sources" :active-citation="citing!.citation" :question="citedTurn.question" @select="(citation) => openSources(citing!.turn, citation)" />
          </SheetContent>
        </Sheet>
      </div>
    </main>
    <Toaster position="top-center" rich-colors />
    <ConfirmDialog />
  </TooltipProvider>
</template>

