<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import type {
  ChatAnswerMode, ChatFeedbackRating, ChatSessionListResponse, ChatSessionMessagesResponse, ChatSessionRecord, ChatSource, ChatStreamRequest, DocumentDetail, RetrievalFilters,
  UserAccount, UserSessionResponse,
} from "@nyz-rag/types";
import AccountDialog, { type AccountMode } from "./AccountDialog.vue";
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
const accountMenuOpen = ref(false);
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
const article = ref<DocumentDetail | null>(null);
const articleError = ref("");
const articleLoading = ref(false);
const articleId = ref<string | null>(null);
const dateFrom = ref("");
const dateTo = ref("");
const categoriesText = ref("");
const tagsText = ref("");
const scenariosText = ref("");
let controller: AbortController | null = null;
let articleRequest = 0;

const onArticlePage = computed(() => articleId.value !== null);
const activeFilterCount = computed(() => [dateFrom.value, dateTo.value, categoriesText.value, tagsText.value, scenariosText.value].filter(Boolean).length);

interface MarkdownBlock {
  kind: "heading" | "paragraph" | "list" | "code" | "table";
  level?: number;
  rows?: string[][];
  ordered?: boolean;
  text?: string;
  items?: string[];
}

function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] }); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const rows = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes("|")) rows.push(splitTableRow(lines[i++]));
      blocks.push({ kind: "table", rows });
      continue;
    }
    const listMatch = line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = !!listMatch[2];
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i].match(/^\s*(?:([-*+])|(\d+)\.)\s+(.+)$/);
        if (!item || !!item[2] !== ordered) break;
        items.push(item[3]); i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraph = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*(?:[-*+]\s|\d+\.\s))/.test(lines[i])) paragraph.push(lines[i++].trim());
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function splitTableRow(line: string) { return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()); }

function safeLink(value: string, allowMail = false): string | undefined {
  try {
    const url = new URL(value, location.href);
    if (["http:", "https:", ...(allowMail ? ["mailto:"] : [])].includes(url.protocol)) return url.href;
  } catch { /* Invalid links remain plain text. */ }
}

function inlineTokens(text: string) {
  const tokens: Array<{ text: string; href?: string; strong?: boolean; code?: boolean }> = [];
  const pattern = /\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\*\*(.+?)\*\*|`([^`]+)`/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    if (index > cursor) tokens.push({ text: text.slice(cursor, index) });
    if (match[1] !== undefined) {
      const href = safeLink(match[2], true);
      tokens.push(href ? { text: match[1], href } : { text: match[0] });
    } else if (match[3] !== undefined) tokens.push({ text: match[3], strong: true });
    else tokens.push({ text: match[4], code: true });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor) });
  return tokens;
}

const articleBlocks = computed(() => article.value ? parseMarkdown(article.value.markdown || article.value.content) : []);
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
  let id: string | null = null;
  let invalid = false;
  if (match) {
    try { id = decodeURIComponent(match[1]); invalid = !id; } catch { id = ""; invalid = true; }
  }
  if (id === articleId.value) return;
  articleRequest++;
  articleLoading.value = false;
  articleId.value = id;
  article.value = null;
  articleError.value = invalid ? "文章地址无效" : "";
  if (id) void loadArticle(id);
}

async function loadArticle(id: string) {
  const request = ++articleRequest;
  articleLoading.value = true;
  articleError.value = "";
  try {
    const data = await api<DocumentDetail>(`/api/documents/${encodeURIComponent(id)}`);
    if (request === articleRequest && articleId.value === id) article.value = data;
  } catch (error) {
    if (request === articleRequest) articleError.value = error instanceof Error ? error.message : "文章加载失败";
  } finally {
    if (request === articleRequest) articleLoading.value = false;
  }
}

function clearFilters() { dateFrom.value = ""; dateTo.value = ""; categoriesText.value = ""; tagsText.value = ""; scenariosText.value = ""; }

const lastTurn = computed(() => turns.value.at(-1));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return client.request<T>(path, init);
}

onMounted(async () => {
  window.addEventListener("hashchange", syncArticleRoute);
  document.addEventListener("click", closeAccountMenu);
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
  document.removeEventListener("click", closeAccountMenu);
});

function closeAccountMenu(event: MouseEvent) {
  if (!(event.target instanceof Element && event.target.closest(".account-menu"))) accountMenuOpen.value = false;
}

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
  accountMenuOpen.value = false;
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
  accountMenuOpen.value = false;
  if (busy.value) return;
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    alert(error instanceof Error ? error.message : "退出失败");
    return;
  }
  // 退出后浏览器成为新的访客，账号中的会话不再可见。
  user.value = null;
  newSession();
  sessions.value = [];
  void loadSessions();
}

async function removeSession(id: string) {
  if (busy.value || !confirm("删除这个会话及其全部问答？")) return;
  try {
    await api(`/api/chat/sessions/${id}`, { method: "DELETE" });
    sessions.value = sessions.value.filter((session) => session.id !== id);
    if (sessionId.value === id) newSession();
  } catch (error) {
    alert(error instanceof Error ? error.message : "删除失败");
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
    alert("评价提交失败，请稍后重试。");
  } finally {
    turn.feedbackBusy = false;
  }
}

function useSuggestion(text: string) {
  question.value = text;
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <a class="brand" href="#/" aria-label="NYZ RAG 首页"><span class="brand-mark">N</span><span>NYZ <b>知识问答</b></span></a>
      <div class="topbar-actions">
        <div class="status"><span></span>文章知识库</div>
        <div v-if="user" class="account-menu">
          <button class="account-trigger" :aria-expanded="accountMenuOpen" aria-haspopup="menu" @click="accountMenuOpen = !accountMenuOpen"><span class="account-avatar">{{ user.email.slice(0, 1).toUpperCase() }}</span><span class="account-email">{{ user.email }}</span></button>
          <div v-if="accountMenuOpen" class="account-dropdown" role="menu">
            <button role="menuitem" @click="openAccount('password')">修改密码</button>
            <button role="menuitem" :disabled="busy" @click="logout">退出登录</button>
          </div>
        </div>
        <button v-else class="account-login" @click="openAccount('login')">登录 / 注册</button>
      </div>
    </header>
    <p v-if="accountNotice" class="account-notice" role="status">{{ accountNotice }}<button aria-label="关闭提示" @click="accountNotice = ''">×</button></p>
    <AccountDialog v-if="accountMode" v-model:mode="accountMode" @close="accountMode = null" @authenticated="onAuthenticated" @password-changed="onPasswordChanged" />

    <section v-show="onArticlePage" class="public-article" aria-live="polite">
      <a class="article-back" href="#/">← 返回知识问答</a>
      <div v-if="articleLoading" class="article-state" role="status">正在加载文章…</div>
      <div v-else-if="articleError" class="article-state article-error" role="alert">
        <p>{{ articleError }}</p><button v-if="articleId" @click="loadArticle(articleId)">重试</button>
      </div>
      <article v-else-if="article" class="article-document">
        <header class="article-header">
          <p class="eyebrow">知识库文章</p>
          <h1>{{ article.title }}</h1>
          <p v-if="article.summary" class="article-summary">{{ article.summary }}</p>
          <div class="article-meta">
            <span v-if="article.author">{{ article.author }}</span>
            <span v-if="article.category">{{ article.category }}</span>
            <time v-if="article.publishedAt" :datetime="article.publishedAt">{{ new Date(article.publishedAt).toLocaleDateString() }}</time>
            <span>更新于 {{ new Date(article.updatedAt).toLocaleDateString() }}</span>
          </div>
          <div v-if="article.tags.length || article.keywords.length || article.scenarios.length" class="article-taxonomy">
            <div v-if="article.tags.length"><strong>标签</strong><span v-for="tag in article.tags" :key="`tag-${tag}`">{{ tag }}</span></div>
            <div v-if="article.keywords.length"><strong>关键词</strong><span v-for="keyword in article.keywords" :key="`keyword-${keyword}`">{{ keyword }}</span></div>
            <div v-if="article.scenarios.length"><strong>适用场景</strong><span v-for="scenario in article.scenarios" :key="`scenario-${scenario}`">{{ scenario }}</span></div>
          </div>
          <p v-if="article.repostSource" class="article-repost">转载自 {{ article.repostSource }}</p>
        </header>
        <div class="article-body">
          <template v-for="(block, index) in articleBlocks" :key="index">
            <component :is="`h${block.level}`" v-if="block.kind === 'heading'" class="markdown-heading">
              <template v-for="(token, tokenIndex) in inlineTokens(block.text || '')" :key="tokenIndex"><a v-if="token.href" :href="token.href" target="_blank" rel="noopener noreferrer">{{ token.text }}</a><strong v-else-if="token.strong">{{ token.text }}</strong><code v-else-if="token.code">{{ token.text }}</code><template v-else>{{ token.text }}</template></template>
            </component>
            <p v-else-if="block.kind === 'paragraph'" class="markdown-paragraph">
              <template v-for="(token, tokenIndex) in inlineTokens(block.text || '')" :key="tokenIndex"><a v-if="token.href" :href="token.href" target="_blank" rel="noopener noreferrer">{{ token.text }}</a><strong v-else-if="token.strong">{{ token.text }}</strong><code v-else-if="token.code">{{ token.text }}</code><template v-else>{{ token.text }}</template></template>
            </p>
            <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'" class="markdown-list"><li v-for="(item, itemIndex) in block.items" :key="itemIndex">{{ item }}</li></component>
            <pre v-else-if="block.kind === 'code'" class="markdown-code"><code>{{ block.text }}</code></pre>
            <div v-else-if="block.kind === 'table'" class="markdown-table-wrap"><table><tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><template v-if="rowIndex === 0"><th v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</th></template><template v-else><td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td></template></tr></tbody></table></div>
          </template>
        </div>
        <a v-if="safeLink(article.url)" class="original-article" :href="safeLink(article.url)" target="_blank" rel="noopener noreferrer">查看原文 ↗</a>
      </article>
    </section>

    <section v-show="!onArticlePage" class="workspace">
      <aside class="rail" aria-label="主导航">
        <button class="rail-button active" aria-label="问答" title="问答">✳</button>
        <button class="rail-button" aria-label="新会话" title="新会话" :disabled="busy" @click="newSession">＋</button>
        <div class="rail-bottom"><button class="rail-button" aria-label="设置" title="设置">⚙</button></div>
      </aside>

      <section class="conversation">
        <div v-if="!turns.length" class="intro">
          <p class="eyebrow">NYZ ARTICLE INTELLIGENCE</p>
          <h1>从文章中，<span>找到答案。</span></h1>
          <p class="lede">向知识库提问，回答将基于已收录的文章内容。</p>
        </div>
        <div v-else class="thread-header">
          <strong>{{ sessions.find((session) => session.id === sessionId)?.title || turns[0].question }}</strong>
          <button :disabled="busy" @click="newSession">＋ 新会话</button>
        </div>

        <div v-if="turns.length" ref="thread" class="thread">
          <article v-for="(turn, index) in turns" :key="turn.id ?? `pending-${index}`" class="turn">
            <p class="question-bubble">{{ turn.question }}</p>
            <section class="answer" aria-live="polite">
              <div class="answer-heading"><span class="answer-icon">✳</span><div><strong>回答</strong><small>{{ turn.streaming ? (turn.answer ? '正在生成…' : '正在检索知识库…') : turn.answerMode === 'generated' ? '由模型依据知识库生成，[n] 对应引用来源' : turn.answerMode === 'extractive' ? '知识库原文摘录' : '' }}</small></div></div>
              <p v-if="turn.answer || turn.streaming" class="answer-text" :class="{ streaming: turn.streaming }">{{ turn.answer }}</p>
              <p v-if="turn.notice" class="answer-notice">{{ turn.notice }}</p>
              <div v-if="turn.sources.length || (!turn.streaming && turn.answerMode)" class="sources"><span>引用来源</span><a v-for="(source, sourceIndex) in turn.sources" :key="source.documentId" :href="documentHref(source.documentId)">[{{ sourceIndex + 1 }}] {{ source.title }}{{ source.repostSource ? `（转载自 ${source.repostSource}）` : '' }} ↗</a><span v-if="!turn.sources.length" class="empty-source">暂无匹配文章</span></div>
              <div v-if="!turn.streaming" class="answer-actions">
                <button v-if="turn.answer" @click="copy(turn)">{{ turn.copied ? '已复制' : '复制' }}</button>
                <button v-if="index === turns.length - 1" :disabled="busy" @click="regenerate">重新生成</button>
                <template v-if="turn.id">
                  <span>{{ turn.rating ? '感谢反馈' : '这个回答有帮助吗？' }}</span>
                  <button class="icon" :disabled="turn.feedbackBusy || !!turn.rating" :class="{ chosen: turn.rating === 'positive' }" aria-label="回答有帮助" title="有帮助" @click="sendFeedback(turn, 'positive')">👍</button>
                  <button class="icon" :disabled="turn.feedbackBusy || !!turn.rating" :class="{ chosen: turn.rating === 'negative' }" aria-label="回答需要改进" title="需要改进" @click="sendFeedback(turn, 'negative')">👎</button>
                </template>
              </div>
            </section>
          </article>
        </div>

        <form class="composer" @submit.prevent="ask">
          <label for="question">{{ turns.length ? '继续提问' : '你的问题' }}</label>
          <textarea id="question" v-model="question" rows="3" placeholder="例如：文章中提到的核心观点是什么？" @keydown.meta.enter.prevent="ask" @keydown.ctrl.enter.prevent="ask"></textarea>
          <div class="composer-footer">
            <span>Enter 换行 <i>·</i> ⌘ Enter 提交</span>
            <button v-if="busy" type="button" @click="stop"><span>停止生成</span><b aria-hidden="true">■</b></button>
            <button v-else type="submit" :disabled="!question.trim()"><span>提问</span><b aria-hidden="true">↗</b></button>
          </div>
        </form>

        <details class="retrieval-filters">
          <summary>检索范围 <span v-if="activeFilterCount">{{ activeFilterCount }} 项已设置</span></summary>
          <div class="filter-fields">
            <label>发布日期自 <input v-model="dateFrom" type="date" aria-label="发布日期起始日期"></label>
            <label>至 <input v-model="dateTo" type="date" aria-label="发布日期结束日期"></label>
            <label>分类 <input v-model="categoriesText" type="text" placeholder="逗号分隔的精确值" aria-label="分类筛选"></label>
            <label>标签 <input v-model="tagsText" type="text" placeholder="逗号分隔的精确值" aria-label="标签筛选"></label>
            <label>场景 <input v-model="scenariosText" type="text" placeholder="逗号分隔的精确值" aria-label="场景筛选"></label>
          </div>
          <button v-if="activeFilterCount" type="button" class="clear-filters" @click="clearFilters">清除筛选</button>
        </details>
        <p v-if="activeFilterCount" class="filter-scope">本次提问及重新生成将按当前检索范围筛选。</p>

        <div v-if="!turns.length" class="suggestions">
          <p>试试这样提问</p>
          <button @click="useSuggestion('最近收录的文章有哪些主要主题？')">最近收录的文章有哪些主要主题？ <span>↗</span></button>
          <button @click="useSuggestion('帮我总结一篇文章的核心观点')">帮我总结一篇文章的核心观点 <span>↗</span></button>
        </div>
        <footer>回答由知识库内容生成，请结合原文核实重要信息。</footer>
      </section>

      <aside class="context-panel">
        <div class="panel-title"><span>历史会话</span><button class="text-button" :disabled="busy" @click="newSession">新会话</button></div>
        <p v-if="!user" class="session-scope">未登录：会话仅保存在当前浏览器。<button @click="openAccount('login')">登录</button>后可跨设备查看。</p>
        <nav class="session-list" aria-label="历史会话">
          <div v-for="session in sessions" :key="session.id" class="session-item" :class="{ active: session.id === sessionId }">
            <button class="session-open" :disabled="busy" :title="session.title" @click="openSession(session.id)"><span>{{ session.title || '新会话' }}</span><small>{{ session.messageCount }} 轮 · {{ new Date(session.updatedAt).toLocaleDateString() }}</small></button>
            <button class="session-delete" :disabled="busy" aria-label="删除会话" title="删除会话" @click="removeSession(session.id)">×</button>
          </div>
          <p v-if="!sessions.length" class="session-empty">{{ sessionError || '暂无会话' }}</p>
        </nav>
        <div class="panel-divider"></div>
        <div class="panel-title"><span>知识库状态</span><span class="live-dot"></span></div>
        <div class="metric"><span>收录文章</span><b>{{ documentsCount }}</b></div>
        <div class="metric"><span>数据源</span><b>{{ sourcesCount }}</b></div>
        <div class="panel-note"><span>i</span><p>{{ lastUpdated ? `最近更新于 ${new Date(lastUpdated).toLocaleString()}` : "等待管理端完成首次同步。" }}</p></div>
      </aside>
    </section>
  </main>
</template>
