import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelProviderRecord } from "@nyz-rag/types";
import { embedChunks, selectEmbeddingProvider } from "../src/embedding.js";
import { noopLimiter } from "./admission-helpers.js";

function provider(overrides: Partial<ModelProviderRecord> = {}): ModelProviderRecord {
  return {
    id: "provider-1",
    name: "Compatible API",
    provider: "compatible",
    baseUrl: "https://embeddings.example/v1/",
    chatModel: "chat-model",
    embeddingModel: "embedding-model",
    rerankModel: "",
    credentialEnv: "PROCESSING_TEST_API_KEY",
    enabled: true,
    isDefault: true,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

test("selects only one enabled default with a configured embedding model", () => {
  const configured = provider();
  assert.equal(selectEmbeddingProvider([
    provider({ id: "disabled", enabled: false }),
    provider({ id: "no-model", embeddingModel: " " }),
    configured,
  ]), configured);
  assert.throws(() => selectEmbeddingProvider([]), /No enabled default embedding provider/);
  assert.throws(() => selectEmbeddingProvider([configured, provider({ id: "second" })]), /Multiple enabled default/);
});

test("batches requests and restores vectors by response index", async (context) => {
  const oldKey = process.env.PROCESSING_TEST_API_KEY;
  const oldFetch = globalThis.fetch;
  context.after(() => {
    if (oldKey === undefined) delete process.env.PROCESSING_TEST_API_KEY;
    else process.env.PROCESSING_TEST_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  });
  process.env.PROCESSING_TEST_API_KEY = "test-secret";

  const batchSizes: number[] = [];
  const requestUrls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    requestUrls.push(String(input));
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    batchSizes.push(body.input.length);
    return new Response(JSON.stringify({
      data: body.input.map((_, index) => ({ index, embedding: [index + 1, 1] })).reverse(),
    }), { status: 200 });
  }) as typeof fetch;

  const vectors = await embedChunks(provider(), Array.from({ length: 33 }, (_, index) => `chunk-${index}`), noopLimiter());
  assert.deepEqual(batchSizes, [32, 1]);
  assert.deepEqual(requestUrls, [
    "https://embeddings.example/v1/embeddings",
    "https://embeddings.example/v1/embeddings",
  ]);
  assert.deepEqual(vectors[0], [1, 1]);
  assert.deepEqual(vectors[31], [32, 1]);
  assert.deepEqual(vectors[32], [1, 1]);
});

test("uses the OpenAI default URL only for a recognized OpenAI provider", async (context) => {
  const oldKey = process.env.PROCESSING_TEST_API_KEY;
  const oldFetch = globalThis.fetch;
  context.after(() => {
    if (oldKey === undefined) delete process.env.PROCESSING_TEST_API_KEY;
    else process.env.PROCESSING_TEST_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  });
  process.env.PROCESSING_TEST_API_KEY = "test-secret";

  let requestUrl = "";
  globalThis.fetch = (async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 });
  }) as typeof fetch;

  await embedChunks(provider({ name: "OpenAI", provider: "openai", baseUrl: "" }), ["input"], noopLimiter());
  assert.equal(requestUrl, "https://api.openai.com/v1/embeddings");
  await assert.rejects(embedChunks(provider({ baseUrl: "" }), ["input"], noopLimiter()), /base URL is required/);
});

test("rejects malformed vectors and hides provider response bodies", async (context) => {
  const oldKey = process.env.PROCESSING_TEST_API_KEY;
  const oldFetch = globalThis.fetch;
  context.after(() => {
    if (oldKey === undefined) delete process.env.PROCESSING_TEST_API_KEY;
    else process.env.PROCESSING_TEST_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  });
  process.env.PROCESSING_TEST_API_KEY = "test-secret";

  globalThis.fetch = (async () => new Response("sensitive provider body test-secret", { status: 401 })) as typeof fetch;
  await assert.rejects(embedChunks(provider(), ["input"], noopLimiter()), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /sensitive provider body|test-secret/);
    return true;
  });

  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [
      { index: 0, embedding: [1, 2] },
      { index: 0, embedding: [3, 4] },
    ],
  }), { status: 200 })) as typeof fetch;
  await assert.rejects(embedChunks(provider(), ["input", "input-2"], noopLimiter()), /invalid vector indices/);
});
