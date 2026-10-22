// 统一模型接口：Embedding、Chat（流式）与 Rerank，均按 OpenAI 兼容协议调用供应商配置中的模型。
// 错误信息不包含地址、密钥或供应商响应正文。
import type { ModelProviderRecord } from "@nyz-rag/types";
import { embedChunks } from "./embedding.js";
import { acquireModelLease, type AdmissionLimiter } from "./model-admission.js";
import { providerCredential, providerUrl } from "./provider.js";

const CHAT_TIMEOUT_MS = 120_000;
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

/** 唯一的启用默认供应商；数据库唯一索引保证最多一个默认。 */
export function selectDefaultProvider(providers: ModelProviderRecord[]): ModelProviderRecord | null {
  return providers.find((provider) => provider.enabled && provider.isDefault) ?? null;
}

export function createEmbeddingModel(provider: ModelProviderRecord, limiter?: AdmissionLimiter): EmbeddingModel {
  return {
    model: provider.embeddingModel.trim(),
    embedDocuments: (texts) => embedChunks(provider, texts, limiter),
    embedQuery: async (text) => (await embedChunks(provider, [text], limiter))[0],
  };
}

async function postJson(url: string, apiKey: string, body: unknown, signal: AbortSignal, label: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
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

export function createChatModel(provider: ModelProviderRecord, limiter?: AdmissionLimiter): ChatModel {
  const model = provider.chatModel.trim();
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
          model, messages, temperature: provider.temperature, max_tokens: provider.maxTokens, stream: true, stream_options: { include_usage: true },
        }, signal, "chat");
        if (!response.body) throw new ModelError("The chat provider returned an empty response.");
        try {
          for await (const data of readServerSentEvents(response.body)) {
            if (data === "[DONE]") return;
            let payload: { choices?: Array<{ delta?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null };
            try {
              payload = JSON.parse(data);
            } catch {
              throw new ModelError("The chat provider returned an invalid stream.");
            }
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
export function createRerankModel(provider: ModelProviderRecord, limiter?: AdmissionLimiter): RerankModel {
  const model = provider.rerankModel.trim();
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
