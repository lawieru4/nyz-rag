<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import type {
  ChatAnswerMode, ChatFeedbackRating, ChatSessionListResponse, ChatSessionMessagesResponse, ChatSessionRecord, ChatSource, ChatStreamEvent, ChatStreamRequest,
} from "@nyz-rag/types";

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
const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
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
let controller: AbortController | null = null;

const lastTurn = computed(() => turns.value.at(-1));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, init);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `请求失败（${response.status}）`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

onMounted(async () => {
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

/** 读取 SSE 响应流；忽略心跳注释行。 */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event && data) yield { event, data: JSON.parse(data) } as ChatStreamEvent;
    }
  }
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
    const response = await fetch(`${apiBase}/api/chat/sessions/${sessionId.value}/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error ?? "请求失败");
    }
    for await (const { event, data } of readEvents(response.body)) {
      if (event === "source") turn.sources.push({ documentId: data.documentId, title: data.title, url: data.url, repostSource: data.repostSource });
      else if (event === "token") turn.answer += data.content;
      else if (event === "done") {
        Object.assign(turn, data);
        finished = true;
      } else if (event === "error") throw new Error(data.error);
      if (event !== "source") void scrollToEnd();
    }
    if (!finished) throw new Error("连接已中断，本轮回答未保存。");
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
  await stream(turns.value.at(-1)!, { question: value });
}

async function regenerate() {
  const turn = lastTurn.value;
  if (!turn || busy.value) return;
  const previous = { ...turn, sources: [...turn.sources] };
  const request: ChatStreamRequest = turn.id ? { regenerate: turn.id } : { question: turn.question };
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
      <a class="brand" href="/" aria-label="NYZ RAG 首页"><span class="brand-mark">N</span><span>NYZ <b>知识问答</b></span></a>
      <div class="status"><span></span>文章知识库</div>
    </header>

    <section class="workspace">
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
              <div v-if="turn.sources.length || (!turn.streaming && turn.answerMode)" class="sources"><span>引用来源</span><a v-for="(source, sourceIndex) in turn.sources" :key="source.documentId" :href="source.url" target="_blank" rel="noreferrer">[{{ sourceIndex + 1 }}] {{ source.title }}{{ source.repostSource ? `（转载自 ${source.repostSource}）` : '' }} ↗</a><span v-if="!turn.sources.length" class="empty-source">暂无匹配文章</span></div>
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

        <div v-if="!turns.length" class="suggestions">
          <p>试试这样提问</p>
          <button @click="useSuggestion('最近收录的文章有哪些主要主题？')">最近收录的文章有哪些主要主题？ <span>↗</span></button>
          <button @click="useSuggestion('帮我总结一篇文章的核心观点')">帮我总结一篇文章的核心观点 <span>↗</span></button>
        </div>
        <footer>回答由知识库内容生成，请结合原文核实重要信息。</footer>
      </section>

      <aside class="context-panel">
        <div class="panel-title"><span>历史会话</span><button class="text-button" :disabled="busy" @click="newSession">新会话</button></div>
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
