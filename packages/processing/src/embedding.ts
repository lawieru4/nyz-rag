import { setTimeout as delay } from "node:timers/promises";
import { acquireModelLease, type AdmissionLimiter } from "./model-admission.js";
import { authorizationHeaders, providerCredential, providerUrl, type ModelTarget } from "./provider.js";

const BATCH_SIZE = 32;
const REQUEST_TIMEOUT_MS = 30_000;

/** 业务模型中的 Embedding 模型；未配置或供应商已停用时报错。 */
export function requireEmbeddingModel<T extends ModelTarget>(selection: T | null): T {
  if (!selection) throw new Error("未配置可用的 Embedding 模型，请在模型配置中选择");
  return selection;
}

function readEmbeddingResponse(payload: unknown, expectedCount: number): number[][] {
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error("The embedding provider returned an invalid response.");
  }

  const data = (payload as { data: unknown[] }).data;
  if (data.length !== expectedCount) {
    throw new Error("The embedding provider returned an unexpected number of vectors.");
  }

  const vectors = new Array<number[] | undefined>(expectedCount);
  for (const item of data) {
    if (typeof item !== "object" || item === null) {
      throw new Error("The embedding provider returned an invalid response.");
    }
    const { index, embedding } = item as { index?: unknown; embedding?: unknown };
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= expectedCount || vectors[index as number]) {
      throw new Error("The embedding provider returned invalid vector indices.");
    }
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("The embedding provider returned an invalid vector.");
    }
    const vector = embedding as number[];
    if (!vector.some((value) => value !== 0)) {
      throw new Error("The embedding provider returned a zero vector.");
    }
    vectors[index as number] = vector;
  }

  if (vectors.some((vector) => vector === undefined)) {
    throw new Error("The embedding provider returned incomplete vector indices.");
  }
  return vectors as number[][];
}

/** 临时错误（限流、5xx、连接失败）的重试等待；超时不重试，单次已等 REQUEST_TIMEOUT_MS，再重试会让问答等待过久。 */
const RETRY_DELAYS_MS = [1_000, 3_000];
/** 服务端要求等待（Retry-After）超过此值时不再重试，直接失败。 */
const MAX_RETRY_WAIT_MS = 10_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

class TransientEmbeddingError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) { super(message); }
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after") ?? undefined);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** 一批输入的一次请求：先取得限流租约，请求结束即释放。 */
async function requestBatch(url: string, apiKey: string | null, providerId: string, model: string, batch: string[], limiter?: AdmissionLimiter): Promise<number[][]> {
  const lease = await acquireModelLease(providerId, "embedding", model, limiter);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          ...authorizationHeaders(apiKey),
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = "The embedding request failed or timed out.";
      throw error instanceof Error && error.name === "TimeoutError" ? new Error(message) : new TransientEmbeddingError(message);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const message = `The embedding request failed with HTTP ${response.status}.`;
      throw RETRYABLE_STATUS.has(response.status) ? new TransientEmbeddingError(message, retryAfterMs(response)) : new Error(message);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("The embedding provider returned an invalid response.");
    }
    return readEmbeddingResponse(payload, batch.length);
  } finally {
    await lease.release();
  }
}

/**
 * Embed an array of text inputs using the given provider and model.
 * Each batch of up to BATCH_SIZE texts counts as one request against the admission limiter, including each retry.
 * @param limiter  Optional injected limiter; uses the shared lazy limiter if omitted.
 * @param retryDelaysMs  Waits before each retry of a transient failure (tests pass zeros).
 */
export async function embedChunks(
  { provider, model: configuredModel }: ModelTarget, inputs: string[], limiter?: AdmissionLimiter, retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<number[][]> {
  const apiKey = providerCredential(provider, "embedding");

  const model = configuredModel.trim();
  if (!model) {
    throw new Error("An embedding model is required.");
  }
  if (!inputs.every((input) => typeof input === "string")) {
    throw new Error("Embedding inputs must be strings.");
  }

  const url = providerUrl(provider, "embeddings", "embedding");
  const vectors: number[][] = [];
  let dimensions: number | undefined;

  for (let offset = 0; offset < inputs.length; offset += BATCH_SIZE) {
    const batch = inputs.slice(offset, offset + BATCH_SIZE);
    let batchVectors: number[][];
    for (let attempt = 0; ; attempt += 1) {
      try {
        batchVectors = await requestBatch(url, apiKey, provider.id, model, batch, limiter);
        break;
      } catch (error) {
        if (!(error instanceof TransientEmbeddingError) || attempt >= retryDelaysMs.length) throw error;
        // 等待期间不持有租约，不占用并发名额。
        const wait = error.retryAfterMs ?? retryDelaysMs[attempt];
        if (wait > MAX_RETRY_WAIT_MS) throw error;
        await delay(wait);
      }
    }
    for (const vector of batchVectors) {
      if (dimensions !== undefined && vector.length !== dimensions) {
        throw new Error("The embedding provider returned inconsistent vector dimensions.");
      }
      dimensions = vector.length;
      vectors.push(vector);
    }
  }

  return vectors;
}
