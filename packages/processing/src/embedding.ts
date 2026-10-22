import type { ModelProviderRecord } from "@nyz-rag/types";
import { acquireModelLease, type AdmissionLimiter } from "./model-admission.js";
import { providerCredential, providerUrl } from "./provider.js";

const BATCH_SIZE = 32;
const REQUEST_TIMEOUT_MS = 30_000;

export function selectEmbeddingProvider(providers: ModelProviderRecord[]): ModelProviderRecord {
  const candidates = providers.filter((provider) =>
    provider.enabled && provider.isDefault && provider.embeddingModel.trim().length > 0,
  );

  if (candidates.length === 0) {
    throw new Error("No enabled default embedding provider is configured.");
  }
  if (candidates.length > 1) {
    throw new Error("Multiple enabled default embedding providers are configured.");
  }

  return candidates[0];
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

/**
 * Embed an array of text inputs using the given provider.
 * Each batch of up to BATCH_SIZE texts counts as one request against the admission limiter.
 * @param limiter  Optional injected limiter; uses the shared lazy limiter if omitted.
 */
export async function embedChunks(provider: ModelProviderRecord, inputs: string[], limiter?: AdmissionLimiter): Promise<number[][]> {
  const apiKey = providerCredential(provider, "embedding");

  const model = provider.embeddingModel.trim();
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

    // Each batch is one HTTP request; acquire admission before sending.
    const lease = await acquireModelLease(provider.id, "embedding", model, limiter);
    let response: Response;
    try {
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model, input: batch }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new Error("The embedding request failed or timed out.");
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`The embedding request failed with HTTP ${response.status}.`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The embedding provider returned an invalid response.");
      }

      const batchVectors = readEmbeddingResponse(payload, batch.length);
      for (const vector of batchVectors) {
        if (dimensions !== undefined && vector.length !== dimensions) {
          throw new Error("The embedding provider returned inconsistent vector dimensions.");
        }
        dimensions = vector.length;
        vectors.push(vector);
      }
    } finally {
      await lease.release();
    }
  }

  return vectors;
}
