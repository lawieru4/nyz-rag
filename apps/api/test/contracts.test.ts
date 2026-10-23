/**
 * contracts.test.ts — API contract tests using Fastify inject (no DB / Redis).
 *
 * Strategy:
 *  - Build a lightweight Fastify instance with the same AJV settings as production.
 *  - Register configureCommon() to install the schema hook + error handler.
 *  - Register stub route handlers at the exact URLs used by the real app.
 *  - The onRoute hook attaches the JSON Schema from schemas.ts automatically.
 *  - Inject requests and assert:
 *      • Invalid input → 400 with { error: string } before the handler runs
 *      • Valid input   → handler's 200 response passes serialization intact
 *      • 404 handler   → { error: "not found" }
 *      • 500 from handler → { error: "Internal server error" } (no leak)
 *
 * Run with:
 *   pnpm --filter @nyz-rag/api test
 * or directly:
 *   node --import tsx/esm --test apps/api/test/contracts.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { configureCommon } from "../src/common.js";
import { routeSchemas } from "../src/schemas.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a test app: same AJV settings as production, configureCommon installed, no real DB. */
function buildTestApp() {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  configureCommon(app);
  return app;
}

/** Assert the response has { error: string } and the given status. */
function assertError(res: { statusCode: number; json(): unknown }, status: number) {
  assert.equal(res.statusCode, status);
  const body = res.json() as Record<string, unknown>;
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
}

/** Assert the response has status 200 and a JSON body matching the predicate. */
function assertOk(res: { statusCode: number; json(): unknown }, check?: (b: unknown) => void) {
  assert.equal(res.statusCode, 200);
  const body = res.json();
  check?.(body);
}

// Canonical UUID for param tests
const UUID = "00000000-0000-4000-8000-000000000001";
// Non-UUID that should be rejected by params schema
const BAD_ID = "not-a-uuid";

// ─── Schema registry completeness ────────────────────────────────────────────

test("routeSchemas exports an object with at least 20 route entries", () => {
  const keys = Object.keys(routeSchemas);
  assert.ok(keys.length >= 20, `Expected >= 20 routes, got ${keys.length}`);
});

test("every routeSchemas key has the form 'METHOD /path'", () => {
  const methods = new Set(["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"]);
  for (const key of Object.keys(routeSchemas)) {
    const [method, path] = key.split(" ");
    assert.ok(methods.has(method), `Unknown method in key: ${key}`);
    assert.ok(path?.startsWith("/"), `Path must start with / in key: ${key}`);
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────

test("GET /health — returns health object", async () => {
  const app = buildTestApp();
  app.get("/health", async () => ({
    status: "ok",
    service: "nyz-rag-api",
    timestamp: new Date().toISOString(),
  }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/health" });
  assertOk(res, (b) => {
    const body = b as Record<string, string>;
    assert.equal(body.status, "ok");
    assert.equal(body.service, "nyz-rag-api");
    assert.equal(typeof body.timestamp, "string");
  });
});

// ─── 404 handler ─────────────────────────────────────────────────────────────

test("unknown route — returns 404 { error }", async () => {
  const app = buildTestApp();
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/no-such-route" });
  assertError(res, 404);
});

// ─── 500 handler ─────────────────────────────────────────────────────────────

test("unhandled throw in handler — returns 500 { error } without leak", async () => {
  const app = buildTestApp();
  app.get("/api/admin/knowledge-bases", async () => {
    throw new Error("secret db password is hunter2");
  });
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/admin/knowledge-bases" });
  assert.equal(res.statusCode, 500);
  const body = res.json() as Record<string, string>;
  assert.equal(body.error, "Internal server error");
  assert.ok(!JSON.stringify(body).includes("hunter2"), "Internal error must not leak secret");
});

test("SyntaxError thrown inside a handler stays a 500, not a malformed-body 400", async () => {
  const app = buildTestApp();
  app.get("/api/admin/knowledge-bases", async () => JSON.parse("{ upstream response"));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/admin/knowledge-bases" });
  assert.equal(res.statusCode, 500);
  assert.equal((res.json() as Record<string, string>).error, "Internal server error");
});

// ─── POST /api/chat ───────────────────────────────────────────────────────────

test("POST /api/chat — missing question → 400", async () => {
  const app = buildTestApp();
  app.post("/api/chat", async () => ({ messageId: UUID, answer: "ok", answerMode: "extractive", sources: [] }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/chat",
    payload: { knowledgeBaseId: UUID },
  });
  assertError(res, 400);
});

test("POST /api/chat — question too long → 400", async () => {
  const app = buildTestApp();
  app.post("/api/chat", async () => ({ messageId: UUID, answer: "ok", answerMode: "extractive", sources: [] }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/chat",
    payload: { question: "x".repeat(2001) },
  });
  assertError(res, 400);
});

test("POST /api/chat — valid request → 200 with required fields", async () => {
  const app = buildTestApp();
  app.post("/api/chat", async () => ({
    messageId: UUID,
    answer: "The answer is 42.",
    answerMode: "extractive",
    sources: [{ documentId: UUID, title: "Doc", url: "https://example.com" }],
  }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/chat",
    payload: { question: "What is the answer?" },
  });
  assertOk(res, (b) => {
    const body = b as Record<string, unknown>;
    assert.equal(typeof body.messageId, "string");
    assert.equal(typeof body.answer, "string");
    assert.ok(Array.isArray(body.sources));
  });
});

test("POST /api/chat — unknown body field rejected when additionalProperties:false", async () => {
  const app = buildTestApp();
  // With removeAdditional:false, unknown fields cause 400 validation failure
  app.post("/api/chat", async () => ({ messageId: UUID, answer: "ok", answerMode: "extractive", sources: [] }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/chat",
    payload: { question: "hi", __inject_evil: 1 },
  });
  // additionalProperties:false + removeAdditional:false = validation error
  assertError(res, 400);
});

// ─── GET /api/chat/sessions ───────────────────────────────────────────────────

test("GET /api/chat/sessions — bad page param string → 400", async () => {
  const app = buildTestApp();
  app.get("/api/chat/sessions", async () => ({ sessions: [], total: 0 }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/chat/sessions?page=abc" });
  assertError(res, 400);
});

test("GET /api/chat/sessions — valid page param → 200", async () => {
  const app = buildTestApp();
  app.get("/api/chat/sessions", async () => ({ sessions: [], total: 0 }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/chat/sessions?page=2&pageSize=10" });
  assertOk(res, (b) => {
    const body = b as Record<string, unknown>;
    assert.ok(Array.isArray(body.sessions));
    assert.equal(typeof body.total, "number");
  });
});

// ─── POST /api/chat/sessions ──────────────────────────────────────────────────

test("POST /api/chat/sessions — title is not a string → 400", async () => {
  const app = buildTestApp();
  app.post("/api/chat/sessions", async (_req, reply) =>
    reply.code(201).send({ id: UUID, title: "", messageCount: 0, createdAt: "", updatedAt: "" }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/chat/sessions",
    payload: { title: 42 },
  });
  assertError(res, 400);
});

test("POST /api/chat/sessions — valid optional body → 201", async () => {
  const app = buildTestApp();
  app.post("/api/chat/sessions", async (_req, reply) =>
    reply.code(201).send({ id: UUID, title: "", messageCount: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" }));
  await app.ready();

  const res = await app.inject({ method: "POST", url: "/api/chat/sessions", payload: {} });
  assert.equal(res.statusCode, 201);
});

// ─── UUID param validation ────────────────────────────────────────────────────

test("GET /api/chat/sessions/:id/messages — non-UUID id → 400", async () => {
  const app = buildTestApp();
  app.get("/api/chat/sessions/:id/messages", async () => ({
    session: { id: UUID, title: "", messageCount: 0, createdAt: "", updatedAt: "" },
    messages: [],
  }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: `/api/chat/sessions/${BAD_ID}/messages` });
  assertError(res, 400);
});

test("GET /api/chat/sessions/:id/messages — valid UUID id → passes to handler", async () => {
  const app = buildTestApp();
  app.get("/api/chat/sessions/:id/messages", async () => ({
    session: { id: UUID, title: "Test", messageCount: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01" },
    messages: [],
  }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: `/api/chat/sessions/${UUID}/messages` });
  assertOk(res, (b) => {
    const body = b as Record<string, unknown>;
    assert.ok(body.session);
    assert.ok(Array.isArray(body.messages));
  });
});

test("DELETE /api/chat/sessions/:id — non-UUID id → 400", async () => {
  const app = buildTestApp();
  app.delete("/api/chat/sessions/:id", async (_req, reply) => reply.code(204).send());
  await app.ready();

  const res = await app.inject({ method: "DELETE", url: `/api/chat/sessions/${BAD_ID}` });
  assertError(res, 400);
});

test("POST /api/messages/:id/feedback — non-UUID id → 400", async () => {
  const app = buildTestApp();
  app.post("/api/messages/:id/feedback", async (_req, reply) => reply.code(204).send());
  await app.ready();

  const res = await app.inject({
    method: "POST", url: `/api/messages/${BAD_ID}/feedback`,
    payload: { rating: "positive" },
  });
  assertError(res, 400);
});

test("POST /api/messages/:id/feedback — invalid rating value → 400", async () => {
  const app = buildTestApp();
  app.post("/api/messages/:id/feedback", async (_req, reply) => reply.code(204).send());
  await app.ready();

  const res = await app.inject({
    method: "POST", url: `/api/messages/${UUID}/feedback`,
    payload: { rating: "meh" },
  });
  assertError(res, 400);
});

test("POST /api/messages/:id/feedback — valid rating → 204", async () => {
  const app = buildTestApp();
  app.post("/api/messages/:id/feedback", async (_req, reply) => reply.code(204).send());
  await app.ready();

  const res = await app.inject({
    method: "POST", url: `/api/messages/${UUID}/feedback`,
    payload: { rating: "negative" },
  });
  assert.equal(res.statusCode, 204);
});

// ─── POST /api/chat/sessions/:id/stream (SSE) ────────────────────────────────

test("POST /api/chat/sessions/:id/stream — non-UUID id → 400", async () => {
  const app = buildTestApp();
  app.post("/api/chat/sessions/:id/stream", async (_req, reply) => reply.code(200).send());
  await app.ready();

  const res = await app.inject({
    method: "POST", url: `/api/chat/sessions/${BAD_ID}/stream`,
    payload: { question: "hi" },
  });
  assertError(res, 400);
});

test("POST /api/chat/sessions/:id/stream — question too long → 400", async () => {
  const app = buildTestApp();
  app.post("/api/chat/sessions/:id/stream", async (_req, reply) => reply.code(200).send());
  await app.ready();

  const res = await app.inject({
    method: "POST", url: `/api/chat/sessions/${UUID}/stream`,
    payload: { question: "q".repeat(2001) },
  });
  assertError(res, 400);
});

test("POST /api/chat/sessions/:id/stream — valid body passes schema → handler called", async () => {
  const app = buildTestApp();
  let handlerCalled = false;
  app.post("/api/chat/sessions/:id/stream", async (_req, reply) => {
    handlerCalled = true;
    return reply.code(200).send("ok");
  });
  await app.ready();

  const res = await app.inject({
    method: "POST", url: `/api/chat/sessions/${UUID}/stream`,
    payload: { question: "What happened?" },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(handlerCalled);
});

// ─── POST /api/search ────────────────────────────────────────────────────────

test("POST /api/search — missing query → 400", async () => {
  const app = buildTestApp();
  app.post("/api/search", async () => ({ query: "", results: [], total: 0 }));
  await app.ready();

  const res = await app.inject({ method: "POST", url: "/api/search", payload: {} });
  assertError(res, 400);
});

test("POST /api/search — query exceeds 2000 chars → 400", async () => {
  const app = buildTestApp();
  app.post("/api/search", async () => ({ query: "", results: [], total: 0 }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/search",
    payload: { query: "a".repeat(2001) },
  });
  assertError(res, 400);
});

test("POST /api/search — valid query → 200 with results array", async () => {
  const app = buildTestApp();
  app.post("/api/search", async () => ({
    query: "test",
    results: [{ documentId: UUID, title: "Doc", url: "https://x.com", excerpt: "blah", score: 0.9 }],
    total: 1,
  }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/search",
    payload: { query: "test" },
  });
  assertOk(res, (b) => {
    const body = b as Record<string, unknown>;
    assert.equal(typeof body.query, "string");
    assert.ok(Array.isArray(body.results));
    assert.equal(typeof body.total, "number");
  });
});

// ─── Admin: documents ────────────────────────────────────────────────────────

test("GET /api/admin/documents — invalid status enum → 400", async () => {
  const app = buildTestApp();
  app.get("/api/admin/documents", async () => ({ documents: [], total: 0 }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/admin/documents?status=unknown" });
  assertError(res, 400);
});

test("GET /api/admin/documents — valid query → 200", async () => {
  const app = buildTestApp();
  app.get("/api/admin/documents", async () => ({ documents: [], total: 0 }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/admin/documents?status=ready&page=1" });
  assertOk(res, (b) => {
    const body = b as Record<string, unknown>;
    assert.ok(Array.isArray(body.documents));
  });
});

test("GET /api/admin/documents/:id — non-UUID → 400", async () => {
  const app = buildTestApp();
  app.get("/api/admin/documents/:id", async () => ({}));
  await app.ready();

  const res = await app.inject({ method: "GET", url: `/api/admin/documents/${BAD_ID}` });
  assertError(res, 400);
});

// ─── Admin: knowledge bases ───────────────────────────────────────────────────

test("POST /api/admin/knowledge-bases — missing required fields → 400", async () => {
  const app = buildTestApp();
  app.post("/api/admin/knowledge-bases", async (_req, reply) =>
    reply.code(201).send({ id: UUID, name: "k", description: "", topK: 5, similarityThreshold: 0.7, rerankEnabled: false, maxContextLength: 4096, prompt: "", model: "", createdAt: "", updatedAt: "" }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/admin/knowledge-bases",
    payload: { name: "test" }, // missing topK, similarityThreshold, etc.
  });
  assertError(res, 400);
});

test("POST /api/admin/knowledge-bases — blank name or out-of-range settings → 400", async () => {
  const app = buildTestApp();
  app.post("/api/admin/knowledge-bases", async () => { throw new Error("handler must not run"); });
  await app.ready();

  const valid = { name: "kb", description: "", topK: 5, similarityThreshold: 0.7, rerankEnabled: false, maxContextLength: 4096, prompt: "", model: "" };
  for (const invalid of [{ name: "   " }, { topK: 0 }, { topK: 101 }, { topK: 2.5 }, { similarityThreshold: 1.5 }, { maxContextLength: 255 }, { maxContextLength: 300.5 }]) {
    const res = await app.inject({ method: "POST", url: "/api/admin/knowledge-bases", payload: { ...valid, ...invalid } });
    assertError(res, 400);
  }
});

test("POST /api/admin/knowledge-bases — valid body → 201", async () => {
  const app = buildTestApp();
  app.post("/api/admin/knowledge-bases", async (_req, reply) =>
    reply.code(201).send({
      id: UUID, name: "kb", description: "", topK: 5, similarityThreshold: 0.7,
      rerankEnabled: false, maxContextLength: 4096, prompt: "", model: "", createdAt: "2026-01-01", updatedAt: "2026-01-01",
    }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/admin/knowledge-bases",
    payload: { name: "kb", description: "", topK: 5, similarityThreshold: 0.7, rerankEnabled: false, maxContextLength: 4096, prompt: "", model: "" },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as Record<string, unknown>;
  assert.equal(typeof body.id, "string");
  assert.equal(typeof body.name, "string");
});

test("PATCH /api/admin/knowledge-bases/:id — non-UUID → 400", async () => {
  const app = buildTestApp();
  app.patch("/api/admin/knowledge-bases/:id", async () => ({}));
  await app.ready();

  const res = await app.inject({
    method: "PATCH", url: `/api/admin/knowledge-bases/${BAD_ID}`,
    payload: { name: "x", description: "", topK: 5, similarityThreshold: 0.7, rerankEnabled: false, maxContextLength: 4096, prompt: "", model: "" },
  });
  assertError(res, 400);
});

// ─── Admin: model providers ───────────────────────────────────────────────────

test("POST /api/admin/model-providers — missing required fields → 400", async () => {
  const app = buildTestApp();
  app.post("/api/admin/model-providers", async (_req, reply) => reply.code(201).send({}));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/admin/model-providers",
    payload: { name: "test" }, // missing provider, baseUrl and enabled
  });
  assertError(res, 400);
});

test("POST /api/admin/model-providers — invalid credentialEnv pattern → 400", async () => {
  const app = buildTestApp();
  app.post("/api/admin/model-providers", async (_req, reply) => reply.code(201).send({}));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/admin/model-providers",
    payload: {
      name: "test", provider: "openai", baseUrl: "", enabled: true,
      credentialEnv: "lowercase_var", // must be empty or match ^[A-Z][A-Z0-9_]*$
    },
  });
  assertError(res, 400);
});

test("POST /api/admin/model-providers — blank name, model fields or oversized key → 400", async () => {
  const app = buildTestApp();
  app.post("/api/admin/model-providers", async () => { throw new Error("handler must not run"); });
  await app.ready();

  const valid = { name: "test", provider: "openai", credentialEnv: "OPENAI_API_KEY", baseUrl: "", enabled: true };
  // Providers only describe the connection; models are chosen in the model settings.
  for (const invalid of [{ name: " " }, { provider: "\t" }, { chatModel: "gpt-4" }, { isDefaultEmbedding: true }, { temperature: 0.3 }, { apiKey: "x".repeat(4097) }]) {
    const res = await app.inject({ method: "POST", url: "/api/admin/model-providers", payload: { ...valid, ...invalid } });
    assertError(res, 400);
  }
});

test("POST /api/admin/model-providers — valid body → 201 without the key ciphertext", async () => {
  const app = buildTestApp();
  app.post("/api/admin/model-providers", async (_req, reply) =>
    reply.code(201).send({
      id: UUID, name: "test", provider: "openai", baseUrl: "", credentialEnv: "", hasApiKey: true, apiKeyCiphertext: "v1:must-not-leak",
      enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01",
    }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/admin/model-providers",
    payload: { name: "test", provider: "openai", baseUrl: "", enabled: true, apiKey: "sk-test" },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().hasApiKey, true);
  assert.doesNotMatch(res.body, /must-not-leak|apiKeyCiphertext/, "only declared fields are serialized");
});

test("PUT /api/admin/model-settings/:capability — validates the capability and body", async () => {
  const app = buildTestApp();
  app.put("/api/admin/model-settings/:capability", async () => ({
    capability: "chat", providerId: UUID, model: "deepseek-ai/DeepSeek-V3", temperature: 0.3, maxTokens: 1024, updatedAt: "2026-01-01", extra: "dropped",
  }));
  await app.ready();

  const valid = { providerId: UUID, model: "deepseek-ai/DeepSeek-V3" };
  assertError(await app.inject({ method: "PUT", url: "/api/admin/model-settings/vision", payload: valid }), 400);
  for (const invalid of [{ providerId: BAD_ID }, { model: " " }, { model: "x".repeat(201) }, { temperature: 5 }, { maxTokens: 10.5 }, { extra: 1 }]) {
    assertError(await app.inject({ method: "PUT", url: "/api/admin/model-settings/chat", payload: { ...valid, ...invalid } }), 400);
  }
  const res = await app.inject({ method: "PUT", url: "/api/admin/model-settings/chat", payload: { ...valid, temperature: 0.7, maxTokens: 512 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().extra, undefined);
});

test("GET /api/admin/model-settings — returns every capability, null when unset", async () => {
  const app = buildTestApp();
  app.get("/api/admin/model-settings", async () => ({
    chat: null, rerank: null,
    embedding: { capability: "embedding", providerId: UUID, model: "BAAI/bge-m3", temperature: 0.3, maxTokens: 1024, updatedAt: "2026-01-01" },
  }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/admin/model-settings" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    chat: null, rerank: null,
    embedding: { capability: "embedding", providerId: UUID, model: "BAAI/bge-m3", temperature: 0.3, maxTokens: 1024, updatedAt: "2026-01-01" },
  });
});

test("GET /api/admin/model-providers/:id/models — non-UUID → 400", async () => {
  const app = buildTestApp();
  app.get("/api/admin/model-providers/:id/models", async () => ({ models: [] }));
  await app.ready();

  assertError(await app.inject({ method: "GET", url: `/api/admin/model-providers/${BAD_ID}/models` }), 400);
});

test("POST /api/admin/model-providers/models — validates the endpoint body", async () => {
  const app = buildTestApp();
  app.post("/api/admin/model-providers/models", async () => ({ models: ["a"] }));
  await app.ready();

  for (const payload of [{ baseUrl: "https://example.com/v1" }, { provider: "x", baseUrl: "https://example.com/v1", providerId: BAD_ID }, { provider: "x", baseUrl: "", extra: 1 }]) {
    assertError(await app.inject({ method: "POST", url: "/api/admin/model-providers/models", payload }), 400);
  }
  const res = await app.inject({ method: "POST", url: "/api/admin/model-providers/models", payload: { provider: "x", baseUrl: "https://example.com/v1", apiKey: "k" } });
  assert.deepEqual(res.json(), { models: ["a"] });
});

test("PUT /api/admin/settings/article-token — rejects blank or whitespace tokens and never returns the value", async () => {
  const app = buildTestApp();
  app.put("/api/admin/settings/article-token", async () => ({ configured: true, updatedAt: "2026-01-01", encryptionReady: true, value: "must-not-leak" }));
  await app.ready();

  for (const payload of [{}, { value: "" }, { value: "has space" }, { value: "x", extra: 1 }]) {
    assertError(await app.inject({ method: "PUT", url: "/api/admin/settings/article-token", payload }), 400);
  }
  const res = await app.inject({ method: "PUT", url: "/api/admin/settings/article-token", payload: { value: "token-123" } });
  assert.deepEqual(res.json(), { configured: true, updatedAt: "2026-01-01", encryptionReady: true });
});

test("DELETE /api/admin/model-providers/:id — non-UUID → 400", async () => {
  const app = buildTestApp();
  app.delete("/api/admin/model-providers/:id", async (_req, reply) => reply.code(204).send());
  await app.ready();

  const res = await app.inject({ method: "DELETE", url: `/api/admin/model-providers/${BAD_ID}` });
  assertError(res, 400);
});

// ─── Admin: sources ───────────────────────────────────────────────────────────

test("POST /api/admin/sources — missing required fields → 400", async () => {
  const app = buildTestApp();
  app.post("/api/admin/sources", async () => ({}));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/admin/sources",
    payload: { name: "test" }, // missing url and kind
  });
  assertError(res, 400);
});

test("POST /api/admin/sources — invalid kind → 400", async () => {
  const app = buildTestApp();
  app.post("/api/admin/sources", async () => ({}));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/admin/sources",
    payload: { name: "test", url: "https://example.com", kind: "invalid-kind" },
  });
  assertError(res, 400);
});

test("POST /api/admin/sources — web site sources are no longer accepted → 400", async () => {
  const app = buildTestApp();
  app.post("/api/admin/sources", async () => ({}));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/admin/sources",
    payload: { name: "test", url: "https://example.com", kind: "网页站点" },
  });
  assertError(res, 400);
});

test("POST /api/admin/sources — valid body → 200", async () => {
  const app = buildTestApp();
  app.post("/api/admin/sources", async () => ({
    id: UUID, name: "src", url: "https://example.com", kind: "文章 API",
    frequency: "", status: "运行中", documentCount: 0, updatedAt: null,
  }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/admin/sources",
    payload: { name: "src", url: "https://example.com", kind: "文章 API", frequency: "daily" },
  });
  assertOk(res);
});

test("PATCH /api/admin/sources/:id — invalid status → 400", async () => {
  const app = buildTestApp();
  app.patch("/api/admin/sources/:id", async () => ({}));
  await app.ready();

  const res = await app.inject({
    method: "PATCH", url: `/api/admin/sources/${UUID}`,
    payload: { status: "archived" },
  });
  assertError(res, 400);
});

test("PATCH /api/admin/sources/:id — valid status → 200", async () => {
  const app = buildTestApp();
  app.patch("/api/admin/sources/:id", async () => ({
    id: UUID, name: "src", url: "https://example.com", kind: "文章 API",
    frequency: "", status: "已暂停", documentCount: 0, updatedAt: null,
  }));
  await app.ready();

  const res = await app.inject({
    method: "PATCH", url: `/api/admin/sources/${UUID}`,
    payload: { status: "已暂停" },
  });
  assertOk(res);
});

// ─── Admin: chat logs ────────────────────────────────────────────────────────

test("GET /api/admin/chat-logs — invalid rating enum → 400", async () => {
  const app = buildTestApp();
  app.get("/api/admin/chat-logs", async () => ({ logs: [], total: 0 }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/admin/chat-logs?rating=positive" });
  assertError(res, 400);
});

test("GET /api/admin/chat-logs — valid query → 200", async () => {
  const app = buildTestApp();
  app.get("/api/admin/chat-logs", async () => ({ logs: [], total: 0 }));
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/admin/chat-logs?rating=rated&page=1" });
  assertOk(res, (b) => {
    const body = b as Record<string, unknown>;
    assert.ok(Array.isArray(body.logs));
    assert.equal(typeof body.total, "number");
  });
});

// ─── Response serialization preserves nested fields ──────────────────────────

test("GET /api/admin/documents/:id — response serializer preserves nested metadata and chunks", async () => {
  const app = buildTestApp();
  const mockDoc = {
    id: UUID,
    sourceId: UUID,
    title: "Test",
    url: "https://example.com",
    canonicalUrl: "https://example.com/",
    externalId: "a1",
    tags: ["tag1"],
    status: "ready",
    processingStatus: "chunked",
    embedding: { status: "ready", chunkCount: 2 },
    chunkCount: 2,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    content: "Full content here",
    chunks: [{ id: UUID, index: 0, content: "chunk text", tokenEstimate: 10 }],
    duplicates: [{ id: UUID, sourceId: UUID, title: "Repost", url: "https://mirror.example.com/a" }],
    metadata: {
      summary: "summary text",
      cover: null,
      doi: null,
      sourceMeta: null,
      projectMeta: { name: "Battery project", principal: "A. Smith", institution: "National Lab", keywords: ["battery"] },
      titleMeta: { journal: "Advanced Materials", journalAbbreviation: "AM", institutions: ["浙江大学"] },
      relatedArticleKeys: [],
      followUpQuestions: ["q1"],
      attachments: [],
      images: [],
      media: [],
      isVIP: false,
      original: true,
      unknownNodeTypes: [],
      demotedHeadings: 0,
    },
  };
  app.get("/api/admin/documents/:id", async () => mockDoc);
  await app.ready();

  const res = await app.inject({ method: "GET", url: `/api/admin/documents/${UUID}` });
  assertOk(res, (b) => {
    const body = b as Record<string, unknown>;
    assert.ok(Array.isArray(body.chunks));
    assert.equal(body.canonicalUrl, "https://example.com/");
    assert.deepEqual(body.duplicates, mockDoc.duplicates);
    const meta = body.metadata as Record<string, unknown>;
    assert.equal(meta.summary, "summary text");
    assert.deepEqual(meta.projectMeta, mockDoc.metadata.projectMeta);
    assert.deepEqual(meta.titleMeta, mockDoc.metadata.titleMeta);
    assert.ok(Array.isArray(meta.followUpQuestions));
  });
  // 历史文档没有该字段，新解析的非项目文章则显式返回 null。
  const metadata = mockDoc.metadata as Partial<typeof mockDoc.metadata>;
  delete metadata.projectMeta;
  delete metadata.titleMeta;
  const legacy = await app.inject({ method: "GET", url: `/api/admin/documents/${UUID}` });
  assertOk(legacy);
  assert.equal(Object.hasOwn(legacy.json().metadata, "projectMeta"), false);
  assert.equal(Object.hasOwn(legacy.json().metadata, "titleMeta"), false);
  Object.assign(metadata, { projectMeta: null, titleMeta: null });
  const regular = await app.inject({ method: "GET", url: `/api/admin/documents/${UUID}` });
  assertOk(regular);
  assert.equal(regular.json().metadata.projectMeta, null);
  assert.equal(regular.json().metadata.titleMeta, null);
});

test("POST /api/chat — response serializer preserves all ChatSuccessResponse fields", async () => {
  const app = buildTestApp();
  app.post("/api/chat", async () => ({
    messageId: UUID,
    answer: "The sky is blue.",
    answerMode: "generated",
    sources: [
      { documentId: UUID, title: "Article", url: "https://example.com", repostSource: "OrigSrc" },
    ],
  }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/chat",
    payload: { question: "Why is the sky blue?" },
  });
  assertOk(res, (b) => {
    const body = b as Record<string, unknown>;
    assert.equal(body.answer, "The sky is blue.");
    assert.equal(body.answerMode, "generated");
    const sources = body.sources as Array<Record<string, unknown>>;
    assert.equal(sources[0].repostSource, "OrigSrc");
  });
});

// ─── Error format uniformity ──────────────────────────────────────────────────

test("error handler normalises { error } for 4xx statusCode errors thrown", async () => {
  const app = buildTestApp();
  app.get("/api/admin/knowledge-bases", async () => {
    const err = new Error("name is required") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  });
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/admin/knowledge-bases" });
  assertError(res, 400);
  const body = res.json() as Record<string, string>;
  assert.equal(body.error, "name is required");
});

// ─── Malformed JSON ───────────────────────────────────────────────────────────

test("malformed JSON body → 400 { error }", async () => {
  const app = buildTestApp();
  app.post("/api/chat", async () => ({ messageId: UUID, answer: "", answerMode: "extractive", sources: [] }));
  await app.ready();

  const res = await app.inject({
    method: "POST", url: "/api/chat",
    payload: "{ not valid json",
    headers: { "content-type": "application/json" },
  });
  assertError(res, 400);
});

test("GET /api/documents/:id — public route accepts non-UUID ids so unknown links get 404", async () => {
  const app = buildTestApp();
  app.get("/api/documents/:id", async (_req, reply) => reply.code(404).send({ error: "document not found" }));
  await app.ready();

  assertError(await app.inject({ method: "GET", url: "/api/documents/not-found" }), 404);
});
