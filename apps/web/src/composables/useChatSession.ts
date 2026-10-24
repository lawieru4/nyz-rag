import { computed, onScopeDispose, ref } from "vue";
import { ApiError, type ApiClient } from "@nyz-rag/api-client";
import type {
  ChatAnswerMode, ChatFeedbackRating, ChatSessionListResponse, ChatSessionMessagesResponse,
  ChatSessionRecord, ChatSource, ChatStreamRequest, RetrievalFilters,
} from "@nyz-rag/types";

export interface ChatTurnState {
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

/** 会话不存在或不属于当前身份（他人的会话一律 404），本地引用应清除；其余错误（网络、5xx）可重试。 */
function sessionGone(error: unknown) {
  return error instanceof ApiError && (error.status === 404 || error.status === 400);
}

export function useChatSession(options: {
  client: Pick<ApiClient, "request" | "stream">;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  currentFilters: () => RetrievalFilters | undefined;
  onSessionChange: () => void;
  onContentChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { client, storage, currentFilters, onSessionChange, onContentChange, onError } = options;
  const question = ref("");
  const busy = ref(false);
  /** 身份（登录或访客 Cookie）确定之前不提问，避免并发请求各自分配访客身份。 */
  const ready = ref(false);
  const sessions = ref<ChatSessionRecord[]>([]);
  const sessionId = ref<string | null>(null);
  const turns = ref<ChatTurnState[]>([]);
  const sessionError = ref("");
  const lastTurn = computed(() => turns.value.at(-1));
  let controller: AbortController | null = null;
  // 历史列表与会话详情各自只认最近一次请求；切换会话、新建、开始生成、退出登录都会让旧请求失效。
  let listRequest: AbortController | null = null;
  let detailRequest: AbortController | null = null;

  function cancelDetail() {
    detailRequest?.abort();
    detailRequest = null;
  }

  onScopeDispose(() => {
    controller?.abort();
    listRequest?.abort();
    cancelDetail();
  });

  async function initialize(resolveIdentity: () => Promise<void>) {
    await resolveIdentity();
    ready.value = true;
    void loadSessions();
    restoreSession();
  }

  async function loadSessions() {
    listRequest?.abort();
    const request = new AbortController();
    listRequest = request;
    try {
      const data = await client.request<ChatSessionListResponse>("/api/chat/sessions?pageSize=30", { signal: request.signal });
      if (listRequest !== request) return;
      sessions.value = data.sessions;
      sessionError.value = "";
    } catch {
      if (listRequest === request) sessionError.value = "历史会话加载失败";
    } finally {
      if (listRequest === request) listRequest = null;
    }
  }

  async function openSession(id: string, { restoring = false } = {}) {
    if (busy.value) return;
    cancelDetail();
    const request = new AbortController();
    detailRequest = request;
    try {
      const data = await client.request<ChatSessionMessagesResponse>(`/api/chat/sessions/${id}/messages`, { signal: request.signal });
      if (detailRequest !== request) return;
      detailRequest = null;
      sessionId.value = id;
      onSessionChange();
      turns.value = data.messages.map((message) => ({ ...message }));
      storage.setItem(SESSION_KEY, id);
      await onContentChange();
    } catch (error) {
      if (detailRequest !== request) return;
      detailRequest = null;
      if (!sessionGone(error)) {
        // 临时错误保留当前会话与本地记录，稍后可重试。
        onError(restoring ? "上次的会话加载失败，请稍后刷新重试" : "会话加载失败，请稍后重试");
        return;
      }
      if (storage.getItem(SESSION_KEY) === id) storage.removeItem(SESSION_KEY);
      sessions.value = sessions.value.filter((session) => session.id !== id);
      if (sessionId.value === id) clearSession();
      if (!restoring) onError("会话不存在或已删除");
    }
  }

  function clearSession() {
    sessionId.value = null;
    onSessionChange();
    turns.value = [];
    storage.removeItem(SESSION_KEY);
  }

  function newSession() {
    if (busy.value) return;
    cancelDetail();
    clearSession();
  }

  function restoreSession() {
    const saved = storage.getItem(SESSION_KEY);
    if (saved) void openSession(saved, { restoring: true });
  }

  /** 登录后本浏览器的访客会话已归入账号，当前会话保持打开；退出后成为新访客，原会话不再可见。 */
  function identityChanged(change: "signed-in" | "signed-out") {
    if (change === "signed-out") {
      cancelDetail();
      clearSession();
      sessions.value = [];
    }
    sessionError.value = "";
    void loadSessions();
  }

  /** 返回本轮是否完成并保存。 */
  async function stream(turn: ChatTurnState, request: ChatStreamRequest): Promise<boolean> {
    // 在首个 await 之前占用，并让正在加载的会话详情失效，避免它覆盖生成中的问答。
    busy.value = true;
    cancelDetail();
    let finished = false;
    turn.streaming = true;
    controller = new AbortController();
    try {
      if (!sessionId.value) {
        const session = await client.request<ChatSessionRecord>("/api/chat/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        sessionId.value = session.id;
        storage.setItem(SESSION_KEY, session.id);
      }
      await client.stream(
        `/api/chat/sessions/${sessionId.value}/stream`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, filters: currentFilters() }), signal: controller.signal },
        {
          onEvent(ev) {
            if (ev.event === "source") { const { citation: _, ...source } = ev.data; turn.sources.push(source); }
            else if (ev.event === "token") turn.answer += ev.data.content;
            else if (ev.event === "done") { Object.assign(turn, ev.data); finished = true; }
            else if (ev.event === "error") throw new Error(ev.data.error);
            if (ev.event !== "source") void onContentChange();
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
    if (!value || busy.value || !ready.value) return;
    // 上一轮未完成的回答没有保存（没有 id），不保留在界面上。
    if (lastTurn.value && !lastTurn.value.id) turns.value.pop();
    question.value = "";
    turns.value.push({ question: value, answer: "", sources: [], rating: null });
    void onContentChange();
    await stream(turns.value.at(-1)!, { question: value, filters: currentFilters() });
  }

  async function regenerate() {
    const turn = lastTurn.value;
    if (!turn || busy.value || !ready.value) return;
    const previous = { ...turn, sources: [...turn.sources] };
    const request: ChatStreamRequest = turn.id ? { regenerate: turn.id, filters: currentFilters() } : { question: turn.question, filters: currentFilters() };
    Object.assign(turn, { answer: "", sources: [], rating: null, notice: undefined, copied: false, answerMode: undefined });
    // 重新生成失败时原回答仍在会话中，恢复显示。
    if (!await stream(turn, request) && previous.id) Object.assign(turn, previous, { notice: "重新生成未完成，已保留原回答。" });
  }

  function stop() {
    controller?.abort();
  }

  return {
    question, busy, ready, sessions, sessionId, turns, sessionError,
    initialize, loadSessions, openSession, newSession, identityChanged, ask, regenerate, stop,
  };
}
