import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import {
  AdmissionError, buildAnswerContext, buildChatMessages, ChatConflictError, createChatMessage, createChatModel, createChatSession, createEmbeddingModel, createRerankModel,
  DEFAULT_RETRIEVAL_SETTINGS, deleteChatSession, extractiveAnswer, getChatSession, getKnowledgeBase, getModelSelections, HISTORY_TURNS, keywordSearchChunks,
  listChatMessages, listChatSessions, listKnowledgeBases, listSessionMessages, parseRetrievalFilters, rateChatMessage, retrievedChunkRecords, retrieve,
  summarySearchChunks, usableModel, vectorSearchChunks, type AnswerContext, type ChatOwner, type ChatTurn,
} from "@nyz-rag/processing";
import type {
  ChatAnswerMode, ChatFeedbackRequest, ChatLogListResponse, ChatRequest, ChatResponse, ChatSessionListResponse, ChatSessionMessage, ChatSessionMessagesResponse, ChatSessionRecord, ChatSource,
  ChatStreamEvent, ChatStreamRequest, CreateChatSessionRequest, KnowledgeBaseRecord, RetrievalFilters,
} from "@nyz-rag/types";
import { elapsed, MAX_QUESTION_LENGTH, pageParams } from "./common.js";
import { requestOwner } from "./user-auth.js";
import { requires } from "./admin-auth.js";

// SSE 心跳间隔，避免检索或等待首 Token 期间被代理（Nginx 默认 60 秒）断开。
const HEARTBEAT_MS = 15_000;

interface AnswerOptions {
  question: string;
  filters?: RetrievalFilters;
  knowledgeBase: KnowledgeBaseRecord | null;
  history?: ChatTurn[];
  signal?: AbortSignal;
  log: FastifyBaseLogger;
  onSources?(sources: ChatSource[]): void;
  onToken?(text: string): void;
}

interface AnswerResult {
  answer: string;
  answerMode: ChatAnswerMode;
  context: AnswerContext;
  usage: { model?: string; firstTokenMs?: number; promptTokens?: number; completionTokens?: number };
  retrievalMs: number;
  totalMs: number;
}

const questionError = (question: string | undefined) => !question ? "question is required"
  : question.length > MAX_QUESTION_LENGTH ? `question must be at most ${MAX_QUESTION_LENGTH} characters` : null;

/** 会话或请求未指定知识库时使用最近创建的知识库；会话绑定的知识库被删除后同样回退。 */
async function resolveKnowledgeBase(id: string | undefined) {
  return (id ? await getKnowledgeBase(id) : null) ?? (await listKnowledgeBases())[0] ?? null;
}

/**
 * 混合检索（关键词 + 向量，RRF 合并，可选 Rerank）后调用业务模型配置中的 Chat 模型回答；Embedding、Rerank 同样取各自配置的供应商与模型。
 * 未配置 Chat 模型、密钥不可用或调用失败时降级为摘录原文片段；向量检索与 Rerank 失败时同样降级，并记录日志。
 * 限流拒绝与限流服务故障不降级，返回错误且不保存回答。
 * signal 中止（客户端断开）时直接返回，由调用方丢弃结果。
 */
async function answerQuestion(options: AnswerOptions): Promise<AnswerResult> {
  const { question, knowledgeBase, log } = options;
  const started = performance.now();
  const settings = knowledgeBase ?? DEFAULT_RETRIEVAL_SETTINGS;
  // 未配置、供应商已停用或密钥不可用（环境变量缺失、无法解密）的用途视为未配置。
  const selections = await getModelSelections();
  const chatModel = usableModel(selections.chat);
  const embeddingModel = usableModel(selections.embedding);
  const rerankModel = usableModel(selections.rerank);
  const embedding = embeddingModel ? createEmbeddingModel(embeddingModel) : null;
  const reranker = rerankModel ? createRerankModel(rerankModel) : null;

  // 切片与摘要两路向量召回共用同一个查询向量，只调用一次 Embedding。
  const queryVectors = new Map<string, Promise<number[]>>();
  const embedQuery = (text: string) => {
    if (!queryVectors.has(text)) queryVectors.set(text, embedding!.embedQuery(text));
    return queryVectors.get(text)!;
  };
  const { chunks, warnings } = await retrieve(question, settings, {
    keywordSearch: (terms, limit) => keywordSearchChunks(terms, limit, undefined, options.filters),
    vectorSearch: embedding ? async (text, limit) => vectorSearchChunks(await embedQuery(text), embedding, limit, undefined, options.filters) : undefined,
    summarySearch: embedding ? async (text, limit) => summarySearchChunks(await embedQuery(text), embedding, limit, undefined, options.filters) : undefined,
    rerank: reranker ? (query, documents, topN) => reranker.rerank(query, documents, topN) : undefined,
  });
  for (const warning of warnings) log.warn(warning);
  const retrievalMs = elapsed(started);
  const context = buildAnswerContext(chunks, settings.maxContextLength);
  options.onSources?.(context.sources);

  let answer = extractiveAnswer(context);
  let answerMode: ChatAnswerMode = "extractive";
  const usage: AnswerResult["usage"] = {};
  if (context.chunks.length && chatModel && !options.signal?.aborted) {
    const chat = createChatModel(chatModel);
    try {
      let text = "";
      for await (const chunk of chat.streamChat(buildChatMessages(knowledgeBase?.prompt ?? "", question, context, options.history), { signal: options.signal })) {
        if (chunk.type === "token") {
          usage.firstTokenMs ??= elapsed(started);
          text += chunk.text;
          options.onToken?.(chunk.text);
        } else {
          usage.promptTokens = chunk.promptTokens;
          usage.completionTokens = chunk.completionTokens;
        }
      }
      if (text.trim()) {
        answer = text.trim();
        answerMode = "generated";
        usage.model = chat.model;
      } else {
        log.warn("Chat model returned an empty answer; using extractive answer");
      }
    } catch (error) {
      if (error instanceof AdmissionError) throw error;
      if (!options.signal?.aborted) log.warn(`Chat model failed; using extractive answer: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return { answer, answerMode, context, usage, retrievalMs, totalMs: elapsed(started) };
}

async function saveAnswer(result: AnswerResult, input: { question: string; knowledgeBase: KnowledgeBaseRecord | null; owner: ChatOwner; sessionId?: string; supersedes?: string }) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await createChatMessage({
    id, createdAt, owner: input.owner, sessionId: input.sessionId, supersedes: input.supersedes, question: input.question, answer: result.answer, answerMode: result.answerMode,
    knowledgeBaseId: input.knowledgeBase?.id, ...result.usage, retrievalMs: result.retrievalMs, totalMs: result.totalMs,
    sources: result.context.sources, chunks: retrievedChunkRecords(result.context),
  });
  return { id, createdAt };
}

export const chatRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { query?: string; rating?: string; page?: string; pageSize?: string } }>("/api/admin/chat-logs", requires("chat-logs:view"), async (request): Promise<ChatLogListResponse> => {
    const { query = "", rating, page = "1", pageSize = "20" } = request.query;
    return listChatMessages({ query, rating, ...pageParams(page, pageSize) });
  });

  // 单次问答：不属于会话，完整回答一次返回。
  app.post<{ Body: ChatRequest; Reply: ChatResponse }>("/api/chat", async (request, reply) => {
    const question = typeof request.body?.question === "string" ? request.body.question.trim() : undefined;
    const error = questionError(question);
    if (error) return reply.code(400).send({ error });
    let filters: RetrievalFilters;
    try { filters = parseRetrievalFilters(request.body.filters); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const knowledgeBaseId = request.body.knowledgeBaseId;
    const knowledgeBase = await resolveKnowledgeBase(knowledgeBaseId);
    if (knowledgeBaseId && knowledgeBase?.id !== knowledgeBaseId) return reply.code(404).send({ error: "knowledge base not found" });

    const result = await answerQuestion({ question: question!, knowledgeBase, filters, log: request.log });
    const { id: messageId } = await saveAnswer(result, { question: question!, knowledgeBase, owner: requestOwner(request) });
    return { messageId, answer: result.answer, answerMode: result.answerMode, sources: result.context.sources };
  });

  // 会话只对其归属者（登录账号或本浏览器的访客）可见；他人的会话与不存在的会话一样返回 404。
  app.get<{ Querystring: { page?: string; pageSize?: string } }>("/api/chat/sessions", async (request): Promise<ChatSessionListResponse> => {
    const { page = "1", pageSize = "20" } = request.query;
    return listChatSessions(pageParams(page, pageSize), requestOwner(request));
  });

  app.post<{ Body: CreateChatSessionRequest }>("/api/chat/sessions", async (request, reply): Promise<ChatSessionRecord> => {
    const { title = "", knowledgeBaseId } = request.body ?? {};
    if (typeof title !== "string") return reply.code(400).send({ error: "title must be a string" });
    if (knowledgeBaseId !== undefined && !await getKnowledgeBase(knowledgeBaseId)) return reply.code(404).send({ error: "knowledge base not found" });
    return reply.code(201).send(await createChatSession({ title, knowledgeBaseId, owner: requestOwner(request) }));
  });

  app.get<{ Params: { id: string } }>("/api/chat/sessions/:id/messages", async (request, reply): Promise<ChatSessionMessagesResponse> => {
    const session = await getChatSession(request.params.id, requestOwner(request));
    if (!session) return reply.code(404).send({ error: "session not found" });
    return { session, messages: await listSessionMessages(session.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/chat/sessions/:id", async (request, reply) => {
    if (!await deleteChatSession(request.params.id, requestOwner(request))) return reply.code(404).send({ error: "session not found" });
    return reply.code(204).send();
  });

  // 流式问答（SSE）。问题可能较长，因此用 POST 而非 GET，客户端以 fetch 读取响应流。
  // 客户端断开时中止模型调用，不保存本轮问答。
  app.post<{ Params: { id: string }; Body: ChatStreamRequest }>("/api/chat/sessions/:id/stream", async (request, reply) => {
    let filters: RetrievalFilters;
    try { filters = parseRetrievalFilters(request.body?.filters); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const owner = requestOwner(request);
    const session = await getChatSession(request.params.id, owner);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const { regenerate } = request.body ?? {};
    const messages = await listSessionMessages(session.id);
    let question: string;
    let history: ChatSessionMessage[];
    if (regenerate !== undefined) {
      if (request.body.question !== undefined) return reply.code(400).send({ error: "question and regenerate cannot be used together" });
      const last = messages.at(-1);
      if (!last || last.id !== regenerate) return reply.code(409).send({ error: "only the latest answer can be regenerated" });
      question = last.question;
      history = messages.slice(0, -1);
    } else {
      question = typeof request.body?.question === "string" ? request.body.question.trim() : "";
      const error = questionError(question);
      if (error) return reply.code(400).send({ error });
      history = messages;
    }
    const knowledgeBase = await resolveKnowledgeBase(session.knowledgeBaseId);

    reply.hijack();
    const raw = reply.raw;
    // 已由插件（如 CORS）设置在 reply 上的响应头需手动带到原始响应。
    for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) raw.setHeader(name, value);
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (text: string) => { if (!raw.destroyed && !raw.writableEnded) raw.write(text); };
    const send = ({ event, data }: ChatStreamEvent) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const controller = new AbortController();
    raw.on("close", () => { if (!raw.writableEnded) controller.abort(); });
    const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);

    try {
      const result = await answerQuestion({
        question, knowledgeBase, filters, log: request.log, signal: controller.signal,
        history: history.slice(-HISTORY_TURNS).map(({ question, answer }) => ({ question, answer })),
        onSources: (sources) => sources.forEach((source, index) => send({ event: "source", data: { ...source, citation: index + 1 } })),
        onToken: (content) => send({ event: "token", data: { content } }),
      });
      if (controller.signal.aborted) {
        request.log.info("Client disconnected; the answer was discarded");
        return;
      }
      const { id, createdAt } = await saveAnswer(result, { question, knowledgeBase, owner, sessionId: session.id, supersedes: regenerate });
      send({ event: "done", data: { id, question, answer: result.answer, answerMode: result.answerMode, sources: result.context.sources, rating: null, createdAt } });
    } catch (error) {
      request.log.error(error);
      send({ event: "error", data: { error: error instanceof ChatConflictError || error instanceof AdmissionError ? error.message : "回答生成失败，请稍后重试。" } });
    } finally {
      clearInterval(heartbeat);
      if (!raw.writableEnded) raw.end();
    }
  });

  app.post<{ Params: { id: string }; Body: ChatFeedbackRequest }>("/api/messages/:id/feedback", async (request, reply) => {
    const { rating } = request.body ?? {};
    if (rating !== "positive" && rating !== "negative") return reply.code(400).send({ error: "rating must be positive or negative" });
    // 只能评价自己的问答。
    if (!await rateChatMessage(request.params.id, rating, requestOwner(request))) return reply.code(404).send({ error: "message not found" });
    return reply.code(204).send();
  });
};
