<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { ArrowUpRight, ChevronRight, Copy, Info, LogOut, MessageSquareText, Plus, RefreshCw, Settings, Sparkles, Square, ThumbsDown, ThumbsUp, X, KeyRound } from "@lucide/vue";
import type {
  ChatAnswerMode, ChatFeedbackRating, ChatSessionListResponse, ChatSessionMessagesResponse, ChatSessionRecord, ChatSource, ChatStreamRequest, RetrievalFilters,
  UserAccount, UserSessionResponse,
} from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@nyz-rag/ui/components/collapsible";
import { confirm, ConfirmDialog } from "@nyz-rag/ui/confirm";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@nyz-rag/ui/components/dropdown-menu";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Separator } from "@nyz-rag/ui/components/separator";
import { Textarea } from "@nyz-rag/ui/components/textarea";
import { Toaster } from "@nyz-rag/ui/components/sonner";
import { TooltipProvider } from "@nyz-rag/ui/components/tooltip";
import { toast } from "@nyz-rag/ui/lib/toast";
import AccountDialog, { type AccountMode } from "./AccountDialog.vue";
import ArticleView from "./components/ArticleView.vue";
import IconButton from "./components/IconButton.vue";
import { client } from "./webClient";

interface Turn {
  id?: string;
  question: string;
  answer: string;
  answerMode?: ChatAnswerMode;
  sources: ChatSource[];
  rating: ChatFeedbackRating | null;
  streaming?: boolean;
  /** 本轮未完成（出错或已停止），不会保存到会话。 */
  notice?: string;
  copied?: boolean;
  feedbackBusy?: boolean;
}

const SESSION_KEY = "nyz-rag:session";
const user = ref<UserAccount | null>(null);
const accountMode = ref<AccountMode | null>(null);
const accountNotice = ref("");
const question = ref("");
const busy = ref(false);
const sourcesCount = ref(0);
const documentsCount = ref(0);
const lastUpdated = ref<string | null>(null);
const sessions = ref<ChatSessionRecord[]>([]);
const sessionId = ref<string | null>(null);
const turns = ref<Turn[]>([]);
const sessionError = ref("");
const thread = ref<HTMLElement | null>(null);
/** 当前打开的文章 ID（`#/documents/<id>`）；空字符串表示地址无效，null 表示在问答页。 */
const articleId = ref<string | null>(null);
const dateFrom = ref("");
const dateTo = ref("");
const categoriesText = ref("");
const tagsText = ref("");
const scenariosText = ref("");
let controller: AbortController | null = null;

const activeFilterCount = computed(() => [dateFrom.value, dateTo.value, categoriesText.value, tagsText.value, scenariosText.value].filter(Boolean).length);
const filterFields = [
  { id: "filter-from", label: "发布日期自", model: dateFrom, type: "date", aria: "发布日期起始日期" },
  { id: "filter-to", label: "至", model: dateTo, type: "date", aria: "发布日期结束日期" },
  { id: "filter-categories", label: "分类", model: categoriesText, type: "text", aria: "分类筛选" },
  { id: "filter-tags", label: "标签", model: tagsText, type: "text", aria: "标签筛选" },
  { id: "filter-scenarios", label: "场景", model: scenariosText, type: "text", aria: "场景筛选" },
];

function documentHref(id: string) { return `#/documents/${encodeURIComponent(id)}`; }
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

const lastTurn = computed(() => turns.value.at(-1));
const answerCaption = (turn: Turn) => turn.streaming
  ? (turn.answer ? "正在生成…" : "正在检索知识库…")
  : turn.answerMode === "generated" ? "由模型依据知识库生成，[n] 对应引用来源" : turn.answerMode === "extractive" ? "知识库原文摘录" : "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return client.request<T>(path, init);
}

onMounted(async () => {
  window.addEventListener("hashchange", syncArticleRoute);
  syncArticleRoute();
  // 会话按身份隔离：先确定身份（同时取得访客 Cookie），再加载历史会话，避免并发请求各自分配访客身份。
  try { user.value = (await api<UserSessionResponse>("/api/auth/session")).user; } catch { /* 按访客继续 */ }
  void loadSessions();
  const saved = localStorage.getItem(SESSION_KEY);
  if (saved) void openSession(saved);
  try {
    const data = await api<{ stats: { sources: number; documents: number; lastUpdated: string | null } }>("/api/knowledge");
    sourcesCount.value = data.stats.sources;
    documentsCount.value = data.stats.documents;
    lastUpdated.value = data.stats.lastUpdated;
  } catch { /* 状态面板保持默认值 */ }
});

onUnmounted(() => {
  window.removeEventListener("hashchange", syncArticleRoute);
});

async function loadSessions() {
  try {
    sessions.value = (await api<ChatSessionListResponse>("/api/chat/sessions?pageSize=30")).sessions;
  } catch {
    sessionError.value = "历史会话加载失败";
  }
}

async function openSession(id: string) {
  if (busy.value) return;
  try {
    const data = await api<ChatSessionMessagesResponse>(`/api/chat/sessions/${id}/messages`);
    sessionId.value = id;
    turns.value = data.messages.map((message) => ({ ...message }));
    localStorage.setItem(SESSION_KEY, id);
    await scrollToEnd();
  } catch {
    if (localStorage.getItem(SESSION_KEY) === id) localStorage.removeItem(SESSION_KEY);
    if (sessionId.value === id) newSession();
  }
}

function newSession() {
  if (busy.value) return;
  sessionId.value = null;
  turns.value = [];
  localStorage.removeItem(SESSION_KEY);
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

/** 返回本轮是否完成并保存。 */
async function stream(turn: Turn, request: ChatStreamRequest): Promise<boolean> {
  busy.value = true;
  let finished = false;
  turn.streaming = true;
  controller = new AbortController();
  try {
    if (!sessionId.value) {
      const session = await api<ChatSessionRecord>("/api/chat/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      sessionId.value = session.id;
      localStorage.setItem(SESSION_KEY, session.id);
    }
    await client.stream(
      `/api/chat/sessions/${sessionId.value}/stream`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, filters: currentFilters() }), signal: controller.signal },
      {
        onEvent(ev) {
          if (ev.event === "source") turn.sources.push({ documentId: ev.data.documentId, title: ev.data.title, url: ev.data.url, repostSource: ev.data.repostSource });
          else if (ev.event === "token") turn.answer += ev.data.content;
          else if (ev.event === "done") { Object.assign(turn, ev.data); finished = true; }
          else if (ev.event === "error") throw new Error(ev.data.error);
          if (ev.event !== "source") void scrollToEnd();
        },
        onIncomplete(reason) {
          turn.notice = reason;
        },
      },
    );
    // 读取过程中停止生成时，客户端静默返回而不是抛出 AbortError。
    if (!finished && controller.signal.aborted) turn.notice = "已停止生成，本轮回答未保存。";
  } catch (error) {
    turn.notice = controller.signal.aborted ? "已停止生成，本轮回答未保存。" : error instanceof Error ? error.message : "无法连接 API 服务";
  } finally {
    turn.streaming = false;
    busy.value = false;
    controller = null;
    void loadSessions();
  }
  return finished;
}

async function ask() {
  const value = question.value.trim();
  if (!value || busy.value) return;
  // 上一轮未完成的回答没有保存（没有 id），不保留在界面上。
  if (lastTurn.value && !lastTurn.value.id) turns.value.pop();
  question.value = "";
  turns.value.push({ question: value, answer: "", sources: [], rating: null });
  await scrollToEnd();
  await stream(turns.value.at(-1)!, { question: value, filters: currentFilters() });
}

async function regenerate() {
  const turn = lastTurn.value;
  if (!turn || busy.value) return;
  const previous = { ...turn, sources: [...turn.sources] };
  const request: ChatStreamRequest = turn.id ? { regenerate: turn.id, filters: currentFilters() } : { question: turn.question, filters: currentFilters() };
  Object.assign(turn, { answer: "", sources: [], rating: null, notice: undefined, copied: false, answerMode: undefined });
  // 重新生成失败时原回答仍在会话中，恢复显示。
  if (!await stream(turn, request) && previous.id) Object.assign(turn, previous, { notice: "重新生成未完成，已保留原回答。" });
}

function stop() {
  controller?.abort();
}

async function copy(turn: Turn) {
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
  setTimeout(() => { turn.copied = false; }, 1500);
}

async function sendFeedback(turn: Turn, rating: ChatFeedbackRating) {
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
    <main class="min-h-screen">
      <header class="flex h-16 items-center justify-between border-b bg-card px-8 max-sm:h-14 max-sm:px-4">
        <a class="flex items-center gap-2.5 text-sm font-bold max-sm:text-[13px]" href="#/" aria-label="NYZ RAG 首页"><span class="grid size-7 place-items-center rounded-md bg-brand text-[15px] text-brand-foreground">N</span><span>NYZ <b class="font-medium text-muted-foreground">知识问答</b></span></a>
        <div class="flex items-center gap-4.5 max-sm:gap-2.5">
          <div class="flex items-center gap-2 text-xs text-muted-foreground max-sm:hidden"><span class="size-1.75 rounded-full bg-[#82ad55]" />文章知识库</div>
          <DropdownMenu v-if="user">
            <DropdownMenuTrigger as-child>
              <Button variant="outline" class="h-8 max-w-55 gap-2 pr-2.5 pl-1 text-xs font-normal max-sm:pr-1">
                <span class="grid size-6 flex-none place-items-center rounded-[5px] bg-brand-soft text-[11px] font-semibold text-accent-foreground">{{ user.email.slice(0, 1).toUpperCase() }}</span>
                <span class="truncate max-sm:hidden">{{ user.email }}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-36">
              <DropdownMenuItem @select="openAccount('password')"><KeyRound />修改密码</DropdownMenuItem>
              <DropdownMenuItem :disabled="busy" @select="logout"><LogOut />退出登录</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button v-else variant="outline" size="sm" class="text-xs" @click="openAccount('login')">登录 / 注册</Button>
        </div>
      </header>
      <p v-if="accountNotice" class="flex items-center justify-center gap-2.5 bg-secondary px-4 py-2 text-xs text-secondary-foreground" role="status">
        {{ accountNotice }}<Button variant="ghost" size="icon-xs" aria-label="关闭提示" @click="accountNotice = ''"><X /></Button>
      </p>
      <AccountDialog v-if="accountMode" v-model:mode="accountMode" @close="accountMode = null" @authenticated="onAuthenticated" @password-changed="onPasswordChanged" />

      <ArticleView v-if="articleId !== null" :id="articleId" />

      <section v-show="articleId === null" class="grid min-h-[calc(100vh-4rem)] grid-cols-[64px_minmax(420px,1fr)_280px] max-lg:grid-cols-[54px_minmax(0,1fr)] max-sm:min-h-[calc(100vh-3.5rem)] max-sm:grid-cols-1">
        <aside class="flex flex-col items-center gap-2 border-r bg-card py-4.5 max-sm:hidden" aria-label="主导航">
          <IconButton label="问答" class="bg-brand-soft text-accent-foreground hover:bg-brand-soft"><MessageSquareText /></IconButton>
          <IconButton label="新会话" :disabled="busy" @click="newSession"><Plus /></IconButton>
          <IconButton label="设置" class="mt-auto"><Settings /></IconButton>
        </aside>

        <section class="mx-auto flex w-full max-w-225 flex-col px-[clamp(28px,7vw,108px)] pt-21 pb-7 max-lg:px-[clamp(22px,6vw,64px)] max-lg:pt-14 max-sm:px-4 max-sm:pt-8">
          <div v-if="!turns.length" class="mb-8">
            <p class="eyebrow mb-4">NYZ ARTICLE INTELLIGENCE</p>
            <h1 class="text-[34px] leading-[1.35] font-semibold max-sm:text-[28px]">从文章中，<span class="text-[#788648]">找到答案。</span></h1>
            <p class="mt-3 text-sm text-muted-foreground">向知识库提问，回答将基于已收录的文章内容。</p>
          </div>
          <div v-else class="mb-4.5 flex items-center justify-between gap-3">
            <strong class="truncate text-[15px] font-semibold">{{ sessions.find((session) => session.id === sessionId)?.title || turns[0].question }}</strong>
            <Button variant="outline" size="sm" class="flex-none text-xs" :disabled="busy" @click="newSession"><Plus /> 新会话</Button>
          </div>

          <div v-if="turns.length" ref="thread" class="mb-5.5 grid gap-5.5">
            <article v-for="(turn, index) in turns" :key="turn.id ?? `pending-${index}`" class="grid gap-2.5">
              <p class="max-w-[85%] justify-self-end rounded-lg rounded-br-sm bg-primary px-3.5 py-2.5 text-[13px] leading-[1.7] break-words whitespace-pre-wrap text-primary-foreground">{{ turn.question }}</p>
              <section class="rounded-lg border bg-card p-4.5" aria-live="polite">
                <div class="flex items-center gap-2.5">
                  <span class="grid size-7 place-items-center rounded-md bg-brand-soft text-[#566b2f]"><Sparkles class="size-4" /></span>
                  <div><strong class="block text-xs">回答</strong><small class="mt-0.5 block text-[11px] text-muted-foreground">{{ answerCaption(turn) }}</small></div>
                </div>
                <p v-if="turn.answer || turn.streaming" :class="['my-4 text-[13px] leading-[1.8] whitespace-pre-wrap text-[#4c5750]', turn.streaming && 'streaming-cursor']">{{ turn.answer }}</p>
                <p v-if="turn.notice" class="mt-3 rounded-md bg-warning-soft px-2.5 py-2 text-[11px] text-warning">{{ turn.notice }}</p>
                <div v-if="turn.sources.length || (!turn.streaming && turn.answerMode)" class="flex flex-wrap gap-x-3 gap-y-2 border-t pt-3 text-[11px] text-muted-foreground">
                  <span>引用来源</span>
                  <a v-for="(source, sourceIndex) in turn.sources" :key="source.documentId" :href="documentHref(source.documentId)" class="inline-flex items-center gap-0.5 hover:text-link hover:underline">[{{ sourceIndex + 1 }}] {{ source.title }}{{ source.repostSource ? `（转载自 ${source.repostSource}）` : '' }} <ArrowUpRight class="size-3" /></a>
                  <span v-if="!turn.sources.length" class="text-muted-foreground/70">暂无匹配文章</span>
                </div>
                <div v-if="!turn.streaming" class="mt-3.5 flex flex-wrap items-center gap-2 border-t pt-3 text-[11px] text-muted-foreground">
                  <Button v-if="turn.answer" variant="outline" size="xs" @click="copy(turn)"><Copy />{{ turn.copied ? '已复制' : '复制' }}</Button>
                  <Button v-if="index === turns.length - 1" variant="outline" size="xs" :disabled="busy" @click="regenerate"><RefreshCw />重新生成</Button>
                  <template v-if="turn.id">
                    <span class="ml-auto">{{ turn.rating ? '感谢反馈' : '这个回答有帮助吗？' }}</span>
                    <IconButton label="有帮助" size="icon-sm" variant="outline" :disabled="turn.feedbackBusy || !!turn.rating" :class="turn.rating === 'positive' && 'border-ring bg-secondary disabled:opacity-100'" @click="sendFeedback(turn, 'positive')"><ThumbsUp /></IconButton>
                    <IconButton label="需要改进" size="icon-sm" variant="outline" :disabled="turn.feedbackBusy || !!turn.rating" :class="turn.rating === 'negative' && 'border-ring bg-secondary disabled:opacity-100'" @click="sendFeedback(turn, 'negative')"><ThumbsDown /></IconButton>
                  </template>
                </div>
              </section>
            </article>
          </div>

          <form class="rounded-lg border bg-card px-4.5 pt-4 pb-3 shadow-[0_3px_12px_#202b1410] max-sm:p-3.5" @submit.prevent="ask">
            <Label for="question" class="text-xs font-semibold">{{ turns.length ? '继续提问' : '你的问题' }}</Label>
            <Textarea id="question" v-model="question" rows="3" class="mt-2 min-h-18 resize-y rounded-none border-0 px-0 shadow-none focus-visible:ring-0 md:text-sm" placeholder="例如：文章中提到的核心观点是什么？" @keydown.meta.enter.prevent="ask" @keydown.ctrl.enter.prevent="ask" />
            <div class="flex items-center justify-between border-t pt-2.5">
              <span class="font-mono text-[10px] text-muted-foreground/80">Enter 换行 <i class="mx-1 not-italic">·</i> ⌘ Enter 提交</span>
              <Button v-if="busy" type="button" size="sm" @click="stop">停止生成 <Square class="fill-current" /></Button>
              <Button v-else type="submit" size="sm" :disabled="!question.trim()">提问 <ArrowUpRight /></Button>
            </div>
          </form>

          <Collapsible v-slot="{ open }" class="mt-3.5 border-y py-3 text-xs text-[#47524b]">
            <CollapsibleTrigger class="flex items-center gap-1.5 font-semibold">
              <ChevronRight :class="['size-3.5 text-[#788648] transition-transform', open && 'rotate-90']" />检索范围
              <span v-if="activeFilterCount" class="ml-1 text-[11px] font-normal text-[#788648]">{{ activeFilterCount }} 项已设置</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div class="mt-3.5 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
                <div v-for="field in filterFields" :key="field.id" class="grid gap-1.5">
                  <Label :for="field.id" class="text-[11px] font-normal text-muted-foreground">{{ field.label }}</Label>
                  <Input :id="field.id" v-model="field.model.value" :type="field.type" class="h-8.5 bg-card text-xs md:text-xs" :placeholder="field.type === 'text' ? '逗号分隔的精确值' : undefined" :aria-label="field.aria" />
                </div>
              </div>
              <Button v-if="activeFilterCount" type="button" variant="link" size="xs" class="mt-2.5 px-0 text-link" @click="clearFilters">清除筛选</Button>
            </CollapsibleContent>
          </Collapsible>
          <p v-if="activeFilterCount" class="mt-2 text-[11px] text-muted-foreground">本次提问及重新生成将按当前检索范围筛选。</p>

          <div v-if="!turns.length" class="mt-8 grid gap-2">
            <p class="mb-0.5 text-[11px] text-muted-foreground">试试这样提问</p>
            <Button v-for="text in ['最近收录的文章有哪些主要主题？', '帮我总结一篇文章的核心观点']" :key="text" variant="outline" class="h-auto min-h-10 justify-between bg-transparent py-2 text-left text-xs font-normal whitespace-normal text-[#505a54]" @click="useSuggestion(text)">{{ text }} <ArrowUpRight class="text-[#87934d]" /></Button>
          </div>
          <footer class="mt-auto pt-9 text-[10px] leading-normal text-muted-foreground/80">回答由知识库内容生成，请结合原文核实重要信息。</footer>
        </section>

        <aside class="border-l bg-[#fbfcfa] px-5 py-7 max-lg:hidden">
          <div class="flex items-center justify-between text-xs font-semibold"><span>历史会话</span><Button variant="outline" size="xs" :disabled="busy" @click="newSession">新会话</Button></div>
          <p v-if="!user" class="mt-2.5 text-[10px] leading-relaxed text-muted-foreground">未登录：会话仅保存在当前浏览器。<Button variant="link" class="h-auto p-0 text-[10px] text-link" @click="openAccount('login')">登录</Button>后可跨设备查看。</p>
          <nav class="mt-3.5 mb-5 grid max-h-[42vh] gap-1 overflow-auto" aria-label="历史会话">
            <div v-for="session in sessions" :key="session.id" :class="['group flex items-stretch rounded-md hover:bg-accent', session.id === sessionId && 'bg-accent']">
              <button class="min-w-0 flex-1 px-2 py-1.5 text-left text-[#3e4842] disabled:cursor-default disabled:opacity-60" :disabled="busy" :title="session.title" @click="openSession(session.id)">
                <span class="block truncate text-xs">{{ session.title || '新会话' }}</span>
                <small class="mt-0.5 block font-mono text-[10px] text-muted-foreground/80">{{ session.messageCount }} 轮 · {{ new Date(session.updatedAt).toLocaleDateString() }}</small>
              </button>
              <IconButton label="删除会话" size="icon-sm" class="self-center text-muted-foreground/70 hover:bg-transparent hover:text-destructive" :disabled="busy" @click="removeSession(session.id)"><X /></IconButton>
            </div>
            <p v-if="!sessions.length" class="mx-2 my-1.5 text-[11px] text-muted-foreground/80">{{ sessionError || '暂无会话' }}</p>
          </nav>
          <Separator class="mb-4" />
          <div class="flex items-center justify-between text-xs font-semibold"><span>知识库状态</span><span class="size-1.75 rounded-full bg-[#82ad55]" /></div>
          <div class="my-3.5 flex justify-between text-[11px] text-muted-foreground"><span>收录文章</span><b class="font-mono text-xs text-foreground">{{ documentsCount }}</b></div>
          <div class="my-3.5 flex justify-between text-[11px] text-muted-foreground"><span>数据源</span><b class="font-mono text-xs text-foreground">{{ sourcesCount }}</b></div>
          <div class="mt-8 flex items-start gap-2 rounded-md border bg-[#f5f7ee] p-3">
            <Info class="mt-px size-3.5 flex-none text-[#7a8951]" />
            <p class="text-[10px] leading-relaxed text-[#7f8876]">{{ lastUpdated ? `最近更新于 ${new Date(lastUpdated).toLocaleString()}` : "等待管理端完成首次同步。" }}</p>
          </div>
        </aside>
      </section>
    </main>
    <Toaster position="top-center" rich-colors />
    <ConfirmDialog />
  </TooltipProvider>
</template>
