import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelProviderRecord } from "@nyz-rag/types";
import { embedChunks, requireEmbeddingModel } from "../src/embedding.js";
import { providerUrl, type ModelTarget } from "../src/provider.js";
import { noopLimiter } from "./admission-helpers.js";

function provider(overrides: Partial<ModelProviderRecord> = {}): ModelProviderRecord {
  return {
    id: "provider-1",
    name: "Compatible API",
    provider: "compatible",
    baseUrl: "https://embeddings.example/v1/",
    credentialEnv: "PROCESSING_TEST_API_KEY",
    enabled: true,
    hasApiKey: false,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const target = (overrides: Partial<ModelProviderRecord> = {}, model = "embedding-model"): ModelTarget => ({ provider: provider(overrides), model });

test("requires a configured embedding model", () => {
  const configured = target();
  assert.equal(requireEmbeddingModel(configured), configured);
  assert.throws(() => requireEmbeddingModel(null), /未配置可用的 Embedding 模型/);
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
  process.env.NYZ_MODEL_CREDENTIAL_ENVS = "PROCESSING_TEST_API_KEY";

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

  const vectors = await embedChunks(target(), Array.from({ length: 33 }, (_, index) => `chunk-${index}`), noopLimiter());
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
  process.env.NYZ_MODEL_CREDENTIAL_ENVS = "PROCESSING_TEST_API_KEY";

  let requestUrl = "";
  globalThis.fetch = (async (input) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 });
  }) as typeof fetch;

  await embedChunks(target({ name: "OpenAI", provider: "openai", baseUrl: "" }), ["input"], noopLimiter());
  assert.equal(requestUrl, "https://api.openai.com/v1/embeddings");
  await assert.rejects(embedChunks(target({ baseUrl: "" }), ["input"], noopLimiter()), /base URL is required/);
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
  process.env.NYZ_MODEL_CREDENTIAL_ENVS = "PROCESSING_TEST_API_KEY";

  globalThis.fetch = (async () => new Response("sensitive provider body test-secret", { status: 401 })) as typeof fetch;
  await assert.rejects(embedChunks(target(), ["input"], noopLimiter()), (error: unknown) => {
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
  await assert.rejects(embedChunks(target(), ["input", "input-2"], noopLimiter()), /invalid vector indices/);
});

test("retries transient failures per batch and gives up on permanent ones", async (context) => {
  const oldKey = process.env.PROCESSING_TEST_API_KEY;
  const oldFetch = globalThis.fetch;
  context.after(() => {
    if (oldKey === undefined) delete process.env.PROCESSING_TEST_API_KEY;
    else process.env.PROCESSING_TEST_API_KEY = oldKey;
    globalThis.fetch = oldFetch;
  });
  process.env.PROCESSING_TEST_API_KEY = "test-secret";
  process.env.NYZ_MODEL_CREDENTIAL_ENVS = "PROCESSING_TEST_API_KEY";
  const ok =(count = 1) => new Response(JSON.stringify({ data: Array.from({ length: count }, (_, index) => ({ index, embedding: [1, index] })) }), { status: 200 });
  // 依次返回给定的响应（Error 表示 fetch 抛出），记录请求次数与租约次数。
  const script = (...steps: Array<Response | Error>) => {
    let calls = 0;
    globalThis.fetch = (async () => {
      const step = steps[Math.min(calls++, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    }) as typeof fetch;
    return () => calls;
  };
  let leases = 0;
  const limiter = { acquire: async () => { leases += 1; return { release: async () => undefined }; }, close: async () => undefined };
  const noWait = [0, 0];

  const flaky = script(new Response("", { status: 503 }), new TypeError("fetch failed"), ok());
  assert.deepEqual(await embedChunks(target(), ["input"], limiter, noWait), [[1, 0]]);
  assert.equal(flaky(), 3, "503 and connection failures are retried");
  assert.equal(leases, 3, "every attempt is admitted separately");

  // 只重试失败的批次：第一批成功后，第二批失败一次再成功。
  const second = script(ok(32), new Response("", { status: 429 }), ok(1));
  assert.equal((await embedChunks(target(), Array.from({ length: 33 }, (_, index) => `chunk-${index}`), noopLimiter(), noWait)).length, 33);
  assert.equal(second(), 3);

  const exhausted = script(new Response("", { status: 502 }));
  await assert.rejects(embedChunks(target(), ["input"], noopLimiter(), noWait), /HTTP 502/);
  assert.equal(exhausted(), 3, "two retries at most");

  const permanent = script(new Response("", { status: 400 }), ok());
  await assert.rejects(embedChunks(target(), ["input"], noopLimiter(), noWait), /HTTP 400/);
  assert.equal(permanent(), 1, "client errors are not retried");

  const throttled = script(new Response("", { status: 429, headers: { "retry-after": "60" } }), ok());
  await assert.rejects(embedChunks(target(), ["input"], noopLimiter(), noWait), /HTTP 429/);
  assert.equal(throttled(), 1, "a long Retry-After fails fast");

  const timeout = script(new DOMException("The operation was aborted due to timeout", "TimeoutError"), ok());
  await assert.rejects(embedChunks(target(), ["input"], noopLimiter(), noWait), /failed or timed out/);
  assert.equal(timeout(), 1, "timeouts are not retried");

  const invalid = script(new Response("not json", { status: 200 }), ok());
  await assert.rejects(embedChunks(target(), ["input"], noopLimiter(), noWait), /invalid response/);
  assert.equal(invalid(), 1, "invalid responses are not retried");
});

test("provider URLs map loopback hosts to NYZ_LOOPBACK_HOST only when it is set (inside Docker)", () => {
  const endpoint = (baseUrl: string) => ({ name: "Local", provider: "compatible", baseUrl });
  const previous = process.env.NYZ_LOOPBACK_HOST;
  try {
    delete process.env.NYZ_LOOPBACK_HOST;
    assert.equal(providerUrl(endpoint("http://127.0.0.1:8317/v1/"), "models", "model list"), "http://127.0.0.1:8317/v1/models");
    process.env.NYZ_LOOPBACK_HOST = "host.docker.internal";
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      assert.equal(providerUrl(endpoint(`http://${host}:8317/v1`), "chat/completions", "chat"), "http://host.docker.internal:8317/v1/chat/completions", host);
    }
    assert.equal(providerUrl(endpoint("https://api.example/v1"), "embeddings", "embedding"), "https://api.example/v1/embeddings");
  } finally {
    if (previous === undefined) delete process.env.NYZ_LOOPBACK_HOST;
    else process.env.NYZ_LOOPBACK_HOST = previous;
  }
});
