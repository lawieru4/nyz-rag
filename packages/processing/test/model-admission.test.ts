/**
 * Model admission tests:
 *  - No fetch when admission is denied (embedding / chat / rerank)
 *  - Lease always released even on HTTP errors
 *  - Chat generator releases lease on early consumer return and on [DONE]
 *  - Each embedding batch acquires one lease
 *  - modelAdmissionConfig strict safe-integer validation
 *  - rag.retrieve propagates AdmissionError from vector/summary/rerank catches
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { ModelProviderRecord } from "@nyz-rag/types";
import type { ModelSelection } from "../src/provider.js";
import { AdmissionError, type AdmissionLimiter } from "../src/index.js";
import { embedChunks } from "../src/embedding.js";
import { createChatModel, createRerankModel } from "../src/models.js";
import { retrieve, type RetrievalDependencies, type ChunkHit } from "../src/rag.js";
import { modelAdmissionConfig } from "../src/model-admission.js";
import { noopLimiter, denyingLimiter } from "./admission-helpers.js";

// ─── Provider fixture ─────────────────────────────────────────────────────────

function provider(overrides: Partial<ModelProviderRecord> = {}): ModelProviderRecord {
  return {
    id: "prov-1",
    name: "Compatible",
    provider: "compatible",
    baseUrl: "https://api.example/v1",
    credentialEnv: "MODEL_ADMISSION_TEST_KEY",
    enabled: true,
    hasApiKey: false,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

const selection = (model: string): ModelSelection => ({ provider: provider(), model, temperature: 0.1, maxTokens: 128 });

/** Set / restore env and globalThis.fetch around a test. */
function withFetch(
  context: { after(fn: () => void): void },
  handler: ((url: string, init?: RequestInit) => Response | Promise<Response>) | null,
) {
  const oldKey = process.env.MODEL_ADMISSION_TEST_KEY;
  const oldFetch = globalThis.fetch;
  context.after(() => {
    if (oldKey === undefined) delete process.env.MODEL_ADMISSION_TEST_KEY;
    else process.env.MODEL_ADMISSION_TEST_KEY = oldKey;
    globalThis.fetch = oldFetch;
  });
  process.env.MODEL_ADMISSION_TEST_KEY = "test-secret";
  if (handler) {
    globalThis.fetch = (async (input, init) => handler(String(input), init)) as typeof fetch;
  }
}

/** Build a 429 AdmissionError. */
function admission429(): AdmissionError {
  return new AdmissionError(429, 30, "Too many requests. Please wait 30 seconds before trying again.");
}

/** Build a 503 AdmissionError. */
function admission503(): AdmissionError {
  return new AdmissionError(503, 5, "The server is busy. Please wait 5 seconds and try again.");
}

// ─── 1. No fetch when admission is denied ─────────────────────────────────────

describe("no fetch when admission is denied", () => {
  test("embedding: acquire throws → fetch is never called", async (context) => {
    withFetch(context, null); // null: if fetch is called the test would fail (undefined)
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return new Response("", { status: 200 }); }) as typeof fetch;

    const err = admission429();
    await assert.rejects(
      () => embedChunks(selection("emb-model"), ["hello"], denyingLimiter(err)),
      (e: unknown) => { assert.strictEqual(e, err); return true; },
    );
    assert.equal(fetchCalled, false, "fetch must not be called when admission is denied");
  });

  test("chat: acquire throws → fetch is never called", async (context) => {
    withFetch(context, null);
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return new Response("", { status: 200 }); }) as typeof fetch;

    const err = admission503();
    const gen = createChatModel(selection("chat-model"), denyingLimiter(err)).streamChat([{ role: "user", content: "hi" }]);
    await assert.rejects(
      async () => { for await (const _ of gen) { /* drain */ } },
      (e: unknown) => { assert.strictEqual(e, err); return true; },
    );
    assert.equal(fetchCalled, false, "fetch must not be called when admission is denied");
  });

  test("rerank: acquire throws → fetch is never called", async (context) => {
    withFetch(context, null);
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return new Response("", { status: 200 }); }) as typeof fetch;

    const err = admission429();
    await assert.rejects(
      () => createRerankModel(selection("rerank-model"), denyingLimiter(err)).rerank("q", ["a", "b"]),
      (e: unknown) => { assert.strictEqual(e, err); return true; },
    );
    assert.equal(fetchCalled, false, "fetch must not be called when admission is denied");
  });
});

// ─── 2. Lease released on HTTP errors ─────────────────────────────────────────

describe("lease released on errors", () => {
  test("embedding: HTTP 500 releases the lease", async (context) => {
    withFetch(context, () => new Response("error", { status: 500 }));
    let released = false;
    const trackingLimiter: AdmissionLimiter = {
      acquire: async () => ({ release: async () => { released = true; } }),
      close: async () => undefined,
    };
    await assert.rejects(
      () => embedChunks(selection("emb-model"), ["hello"], trackingLimiter),
      /HTTP 500/,
    );
    assert.equal(released, true, "lease must be released even when the HTTP request fails");
  });

  test("chat: HTTP 401 releases the lease", async (context) => {
    withFetch(context, () => new Response("unauthorized", { status: 401 }));
    let released = false;
    const trackingLimiter: AdmissionLimiter = {
      acquire: async () => ({ release: async () => { released = true; } }),
      close: async () => undefined,
    };
    const gen = createChatModel(selection("chat-model"), trackingLimiter).streamChat([{ role: "user", content: "hi" }]);
    await assert.rejects(
      async () => { for await (const _ of gen) { /* drain */ } },
      /HTTP 401/,
    );
    assert.equal(released, true, "lease must be released when chat HTTP request fails");
  });

  test("rerank: HTTP 503 releases the lease", async (context) => {
    withFetch(context, () => new Response("busy", { status: 503 }));
    let released = false;
    const trackingLimiter: AdmissionLimiter = {
      acquire: async () => ({ release: async () => { released = true; } }),
      close: async () => undefined,
    };
    await assert.rejects(
      () => createRerankModel(selection("rerank-model"), trackingLimiter).rerank("q", ["doc-a"]),
      /HTTP 503/,
    );
    assert.equal(released, true, "lease must be released when rerank HTTP request fails");
  });
});

// ─── 3. Chat generator early return / [DONE] releases lease ──────────────────

describe("chat generator lease lifecycle", () => {
  /** Minimal SSE body that yields one token then [DONE]. */
  function makeChatResponse(tokens: string[], cancel: () => void): Response {
    const events = [
      ...tokens.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`),
      "data: [DONE]\n\n",
    ].join("");
    const bytes = new TextEncoder().encode(events);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel,
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  test("[DONE] sentinel causes lease release", async (context) => {
    let cancelled = false;
    withFetch(context, () => makeChatResponse(["token1", "token2"], () => { cancelled = true; }));
    let released = false;
    const trackingLimiter: AdmissionLimiter = {
      acquire: async () => ({ release: async () => { assert.equal(cancelled, true); released = true; } }),
      close: async () => undefined,
    };
    const chunks: string[] = [];
    for await (const chunk of createChatModel(selection("chat-model"), trackingLimiter).streamChat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "token") chunks.push(chunk.text);
    }
    assert.deepEqual(chunks, ["token1", "token2"]);
    assert.equal(released, true, "lease must be released after [DONE]");
  });

  test("early consumer break releases lease", async (context) => {
    let cancelled = false;
    withFetch(context, () => makeChatResponse(["token1", "token2", "token3"], () => { cancelled = true; }));
    let released = false;
    const trackingLimiter: AdmissionLimiter = {
      acquire: async () => ({ release: async () => { assert.equal(cancelled, true); released = true; } }),
      close: async () => undefined,
    };
    // Break after first token
    for await (const chunk of createChatModel(selection("chat-model"), trackingLimiter).streamChat([{ role: "user", content: "hi" }])) {
      if (chunk.type === "token") break;
    }
    assert.equal(released, true, "lease must be released when consumer breaks early");
  });
});

// ─── 4. Each embedding batch acquires one lease ────────────────────────────────

test("each embedding batch acquires exactly one lease", async (context) => {
  withFetch(context, (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({
      data: body.input.map((_, i) => ({ index: i, embedding: [i + 1, 0.5] })),
    }), { status: 200 });
  });

  let acquireCount = 0;
  let releaseCount = 0;
  const countingLimiter: AdmissionLimiter = {
    acquire: async () => {
      acquireCount++;
      return { release: async () => { releaseCount++; } };
    },
    close: async () => undefined,
  };

  // 65 inputs → ceil(65/32) = 3 batches
  const inputs = Array.from({ length: 65 }, (_, i) => `text-${i}`);
  await embedChunks(selection("emb-model"), inputs, countingLimiter);
  assert.equal(acquireCount, 3, "3 batches → 3 lease acquisitions");
  assert.equal(releaseCount, 3, "3 leases must all be released");
});

// ─── 5. modelAdmissionConfig strict safe-integer validation ──────────────────

describe("modelAdmissionConfig strict safe-integer env validation", () => {
  function withEnv(key: string, value: string | undefined, fn: () => void) {
    const saved = process.env[key];
    try {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      fn();
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  }

  test("fractional limits are rejected without truncation", () => {
    withEnv("MODEL_RATE_LIMIT_MAX", "1.5", () => {
      assert.throws(() => modelAdmissionConfig(), /positive safe integer/);
    });
  });

  test("zero limits are rejected", () => {
    withEnv("MODEL_RATE_LIMIT_MAX", "0", () => {
      assert.throws(() => modelAdmissionConfig(), /positive safe integer/);
    });
  });

  test("negative limits are rejected", () => {
    withEnv("MODEL_CONCURRENCY_LIMIT", "-1", () => {
      assert.throws(() => modelAdmissionConfig(), /positive safe integer/);
    });
  });

  test("non-numeric limits are rejected", () => {
    withEnv("RATE_LIMIT_WINDOW_MS", "not-a-number", () => {
      assert.throws(() => modelAdmissionConfig(), /positive safe integer/);
    });
  });

  test("large safe integer is accepted", () => {
    withEnv("MODEL_RATE_LIMIT_MAX", "9007199254740991", () => {
      assert.equal(modelAdmissionConfig().rateLimit, Number.MAX_SAFE_INTEGER);
    });
  });

  test("unsafe integers are rejected", () => {
    withEnv("MODEL_RATE_LIMIT_MAX", "9007199254740992", () => {
      assert.throws(() => modelAdmissionConfig(), /positive safe integer/);
    });
  });

  test("empty, non-finite and trailing-garbage limits are rejected", () => {
    for (const value of ["", "Infinity", "10requests"]) withEnv("MODEL_RATE_LIMIT_MAX", value, () => {
      assert.throws(() => modelAdmissionConfig(), /positive safe integer/);
    });
  });
});

// ─── 6. rag.retrieve propagates AdmissionError ────────────────────────────────

describe("rag.retrieve propagates AdmissionError", () => {
  const settings = { topK: 3, similarityThreshold: 0.3, rerankEnabled: false, maxContextLength: 1000 };
  const hit = (id: string, score: number): ChunkHit => ({
    chunkId: id, documentId: `doc-${id}`, title: `标题${id}`, url: `https://example.test/${id}`,
    content: `正文${id}`, context: `文章：标题${id}`, sectionPath: [], contentType: "text", score,
  });

  test("AdmissionError 429 from vectorSearch propagates (not swallowed)", async () => {
    const err = admission429();
    const deps: RetrievalDependencies = {
      keywordSearch: async () => [hit("a", 5)],
      vectorSearch: async () => { throw err; },
    };
    await assert.rejects(
      () => retrieve("电池", settings, deps),
      (e: unknown) => { assert.strictEqual(e, err); return true; },
    );
  });

  test("AdmissionError 503 from summarySearch propagates (not swallowed)", async () => {
    const err = admission503();
    const deps: RetrievalDependencies = {
      keywordSearch: async () => [hit("a", 5)],
      summarySearch: async () => { throw err; },
    };
    await assert.rejects(
      () => retrieve("固态电池", settings, deps),
      (e: unknown) => { assert.strictEqual(e, err); return true; },
    );
  });

  test("non-AdmissionError from vectorSearch is still swallowed into warnings", async () => {
    const deps: RetrievalDependencies = {
      keywordSearch: async () => [hit("a", 5)],
      vectorSearch: async () => { throw new Error("HTTP 500 from vector search"); },
    };
    const result = await retrieve("电池", settings, deps);
    assert.equal(result.chunks.length, 1);
    assert.match(result.warnings[0], /向量检索失败/);
  });

  test("AdmissionError 429 from rerank propagates", async () => {
    const err = admission429();
    const deps: RetrievalDependencies = {
      keywordSearch: async () => [hit("a", 5), hit("b", 3)],
      rerank: async () => { throw err; },
    };
    await assert.rejects(
      () => retrieve("电池", { ...settings, rerankEnabled: true }, deps),
      (e: unknown) => { assert.strictEqual(e, err); return true; },
    );
  });

  test("non-AdmissionError from rerank is swallowed into warnings", async () => {
    const deps: RetrievalDependencies = {
      keywordSearch: async () => [hit("a", 5), hit("b", 3)],
      rerank: async () => { throw new Error("HTTP 503 from rerank"); },
    };
    const result = await retrieve("电池", { ...settings, rerankEnabled: true }, deps);
    assert.equal(result.chunks.length, 2);
    assert.match(result.warnings[0], /重排序失败/);
  });

  test("AdmissionError 503 from summarySearch propagates even when keyword succeeds", async () => {
    const err = admission503();
    const deps: RetrievalDependencies = {
      keywordSearch: async () => [hit("a", 5)],
      vectorSearch: async () => [hit("a", 0.9)],
      summarySearch: async () => { throw err; },
    };
    await assert.rejects(
      () => retrieve("主题", settings, deps),
      (e: unknown) => { assert.strictEqual(e, err); return true; },
    );
  });
});
