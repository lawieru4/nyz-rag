// 统一模型接口：Embedding、Chat（流式）与 Rerank，均按 OpenAI 兼容协议调用业务模型配置选定的供应商与模型。
// 错误信息不包含地址、密钥或供应商响应正文。
import { embedChunks } from "./embedding.js";
import { acquireModelLease, type AdmissionLimiter } from "./model-admission.js";
import { authorizationHeaders, providerCredential, providerUrl, type ModelProviderConfig, type ModelSelection, type ModelTarget } from "./provider.js";

const CHAT_TIMEOUT_MS = 120_000;
const MODEL_LIST_TIMEOUT_MS = 15_000;
const MAX_LISTED_MODELS = 2000;
const RERANK_TIMEOUT_MS = 30_000;

export interface EmbeddingModel {
  readonly model: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatChunk = { type: "token"; text: string } | { type: "usage"; promptTokens: number; completionTokens: number };

export interface ChatModel {
  readonly model: string;
  streamChat(messages: ChatMessage[], options?: { signal?: AbortSignal }): AsyncIterable<ChatChunk>;
}

export interface RerankResult {
  /** 在输入文档数组中的位置。 */
  index: number;
  score: number;
}

export interface RerankModel {
  readonly model: string;
  rerank(query: string, documents: string[], topN?: number): Promise<RerankResult[]>;
}

/** 本模块生成的错误，信息可直接展示；其他异常（网络、解析）统一替换为不含细节的信息。 */
class ModelError extends Error {}

/** 供应商的可用模型（OpenAI 兼容 GET /models 的 data[].id），供后台选择模型；去重并排序。 */
export async function listProviderModels(provider: Pick<ModelProviderConfig, "name" | "provider" | "baseUrl">, apiKey: string | null): Promise<string[]> {
  const url = providerUrl(provider, "models", "model list");
  let response: Response;
  try {
    response = await fetch(url, { headers: authorizationHeaders(apiKey), signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
  } catch {
    throw new ModelError("The model list request failed or timed out.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelError(`The model list request failed with HTTP ${response.status}.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ModelError("The provider returned an invalid model list.");
  }
  const data = typeof payload === "object" && payload !== null ? (payload as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new ModelError("The provider returned an invalid model list.");
  const ids = data.map((item) => typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return [...new Set(ids)].sort().slice(0, MAX_LISTED_MODELS);
}

export function createEmbeddingModel(selection: ModelTarget, limiter?: AdmissionLimiter): EmbeddingModel {
  return {
    model: selection.model.trim(),
    embedDocuments: (texts) => embedChunks(selection, texts, limiter),
    embedQuery: async (text) => (await embedChunks(selection, [text], limiter))[0],
  };
}

async function postJson(url: string, apiKey: string | null, body: unknown, signal: AbortSignal, label: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { ...authorizationHeaders(apiKey), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new ModelError(`The ${label} request failed or timed out.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelError(`The ${label} request failed with HTTP ${response.status}.`);
  }
  return response;
}

/** 逐条读取 SSE 的 data 字段。 */
async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
      if (done) break;
    }
    if (buffer.startsWith("data:")) yield buffer.slice(5).trim();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createChatModel({ provider, model: configuredModel, temperature, maxTokens }: ModelSelection, limiter?: AdmissionLimiter): ChatModel {
  const model = configuredModel.trim();
  return {
    model,
    async *streamChat(messages, options = {}) {
      if (!model) throw new ModelError("A chat model is required.");
      const apiKey = providerCredential(provider, "chat");
      const url = providerUrl(provider, "chat/completions", "chat");

      // Acquire admission before sending the request; hold until stream ends.
      const lease = await acquireModelLease(provider.id, "chat", model, limiter);
      try {
        const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await postJson(url, apiKey, {
          model, messages, temperature, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
        }, signal, "chat");
        if (!response.body) throw new ModelError("The chat provider returned an empty response.");
        try {
          for await (const data of readServerSentEvents(response.body)) {
            if (data === "[DONE]") return;
            let payload: { choices?: Array<{ delta?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null; error?: unknown };
            try {
              payload = JSON.parse(data);
            } catch {
              throw new ModelError("The chat provider returned an invalid stream.");
            }
            // 部分供应商在 HTTP 200 的流中以 error 事件报告过载等错误，不能当作正常结束。
            if (payload.error) throw new ModelError("The chat provider reported an error in the stream.");
            const text = payload.choices?.[0]?.delta?.content;
            if (typeof text === "string" && text) yield { type: "token", text };
            const usage = payload.usage;
            if (usage && typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
              yield { type: "usage", promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
            }
          }
        } catch (error) {
          // Cancel response body on stream error to free resources
          await response.body?.cancel().catch(() => undefined);
          throw error instanceof ModelError ? error : new ModelError("The chat stream was interrupted or timed out.");
        }
      } finally {
        await lease.release();
      }
    },
  };
}

/** 兼容 Jina / Cohere / SiliconFlow 风格的 /rerank 接口（results 或 output.results）。返回按得分降序排列。 */
export function createRerankModel({ provider, model: configuredModel }: ModelTarget, limiter?: AdmissionLimiter): RerankModel {
  const model = configuredModel.trim();
  return {
    model,
    async rerank(query, documents, topN = documents.length) {
      if (!model) throw new ModelError("A rerank model is required.");
      if (!documents.length) return [];
      const apiKey = providerCredential(provider, "rerank");
      const url = providerUrl(provider, "rerank", "rerank");

      const lease = await acquireModelLease(provider.id, "rerank", model, limiter);
      try {
        const response = await postJson(url, apiKey, { model, query, documents, top_n: Math.min(topN, documents.length), return_documents: false }, AbortSignal.timeout(RERANK_TIMEOUT_MS), "rerank");
        let payload: { results?: unknown; output?: { results?: unknown } };
        try {
          payload = await response.json();
        } catch {
          throw new ModelError("The rerank provider returned an invalid response.");
        }
        const items = payload?.results ?? payload?.output?.results;
        if (!Array.isArray(items)) throw new ModelError("The rerank provider returned an invalid response.");
        const seen = new Set<number>();
        const results = items.map((item: { index?: unknown; relevance_score?: unknown; score?: unknown }) => {
          const index = item?.index;
          const score = item?.relevance_score ?? item?.score;
          if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= documents.length || seen.has(index as number) || typeof score !== "number" || !Number.isFinite(score)) {
            throw new ModelError("The rerank provider returned invalid results.");
          }
          seen.add(index as number);
          return { index: index as number, score };
        });
        return results.sort((a, b) => b.score - a.score);
      } finally {
        await lease.release();
      }
    },
  };
}
