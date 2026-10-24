import { computed, onScopeDispose, ref } from "vue";
import type { ApiClient } from "@nyz-rag/api-client";
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

export function useChatSession(options: {
  client: Pick<ApiClient, "request" | "stream">;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  currentFilters: () => RetrievalFilters | undefined;
  onSessionChange: () => void;
  onContentChange: () => Promise<void>;
}) {
  const { client, storage, currentFilters, onSessionChange, onContentChange } = options;
  const question = ref("");
  const busy = ref(false);
  const sessions = ref<ChatSessionRecord[]>([]);
  const sessionId = ref<string | null>(null);
  const turns = ref<ChatTurnState[]>([]);
  const sessionError = ref("");
  const lastTurn = computed(() => turns.value.at(-1));
  let controller: AbortController | null = null;

  onScopeDispose(() => controller?.abort());

  async function loadSessions() {
    try {
      sessions.value = (await client.request<ChatSessionListResponse>("/api/chat/sessions?pageSize=30")).sessions;
    } catch {
      sessionError.value = "历史会话加载失败";
    }
  }

  async function openSession(id: string) {
    if (busy.value) return;
    try {
      const data = await client.request<ChatSessionMessagesResponse>(`/api/chat/sessions/${id}/messages`);
      sessionId.value = id;
      onSessionChange();
      turns.value = data.messages.map((message) => ({ ...message }));
      storage.setItem(SESSION_KEY, id);
      await onContentChange();
    } catch {
      if (storage.getItem(SESSION_KEY) === id) storage.removeItem(SESSION_KEY);
      if (sessionId.value === id) newSession();
    }
  }

  function newSession() {
    if (busy.value) return;
    sessionId.value = null;
    onSessionChange();
    turns.value = [];
    storage.removeItem(SESSION_KEY);
  }

  function restoreSession() {
    const saved = storage.getItem(SESSION_KEY);
    if (saved) void openSession(saved);
  }

  /** 返回本轮是否完成并保存。 */
  async function stream(turn: ChatTurnState, request: ChatStreamRequest): Promise<boolean> {
    busy.value = true;
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
            if (ev.event === "source") turn.sources.push({ documentId: ev.data.documentId, title: ev.data.title, url: ev.data.url, repostSource: ev.data.repostSource });
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
    if (!value || busy.value) return;
    // 上一轮未完成的回答没有保存（没有 id），不保留在界面上。
    if (lastTurn.value && !lastTurn.value.id) turns.value.pop();
    question.value = "";
    turns.value.push({ question: value, answer: "", sources: [], rating: null });
    await onContentChange();
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

  return { question, busy, sessions, sessionId, turns, sessionError, loadSessions, openSession, newSession, restoreSession, ask, regenerate, stop };
}
