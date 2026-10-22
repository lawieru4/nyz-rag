import assert from "node:assert/strict";
import test from "node:test";
import { buildTestApp as buildApp } from "./auth-helpers.js";
import type { DocumentQueue } from "../src/queue.js";
import { routeSchemas } from "../src/schemas.js";
import { adminAuth, adminHeaders, memoryAuthStore, memoryMailer, memoryUsers, userAuth, userHeaders } from "./auth-helpers.js";

test("the application registers all domains and rejects bad requests before accessing infrastructure", async () => {
  let closed = false;
  const unexpected = async (): Promise<never> => { throw new Error("unexpected queue access"); };
  const queue: DocumentQueue = {
    hasDocumentJob: unexpected, hasSourceJob: unexpected, enqueueDocument: unexpected, enqueueSource: unexpected,
    close: async () => { closed = true; },
  };
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), userAuth, userAuthStore: memoryAuthStore(), mailer: memoryMailer(), users: memoryUsers().repository });
  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().service, "nyz-rag-api");
    for (const [method, url] of [
      ["POST", "/api/chat"], ["POST", "/api/search"], ["GET", "/api/documents/:id"],
      ["GET", "/api/admin/documents"], ["POST", "/api/admin/sources"], ["POST", "/api/admin/sources/:id/sync"],
      ["GET", "/api/admin/knowledge-bases"], ["GET", "/api/admin/model-providers"], ["GET", "/api/admin/chat-logs"],
    ] as const) assert.ok(app.hasRoute({ method, url }), `${method} ${url}`);

    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: adminAuth.username, password: adminAuth.password } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    for (const url of ["/api/chat", "/api/search", "/api/admin/sources", "/api/admin/knowledge-bases", "/api/admin/model-providers", "/api/chat/sessions/session/stream"]) {
      const result = await app.inject({ method: "POST", url, headers: { ...adminHeaders, ...userHeaders, cookie }, payload: { question: 42, query: [], name: 23 } });
      assert.equal(result.statusCode, 400, `${url}: ${result.body}`);
      assert.deepEqual(Object.keys(result.json()), ["error"]);
    }
    const notFound = await app.inject({ method: "GET", url: "/missing" });
    assert.equal(notFound.statusCode, 404);
    assert.deepEqual(Object.keys(notFound.json()), ["error"]);
    const cors = await app.inject({ method: "OPTIONS", url: "/api/search", headers: { origin: "http://localhost:5175", "access-control-request-method": "POST" } });
    assert.equal(cors.statusCode, 204);
    assert.equal(cors.headers["access-control-allow-origin"], "http://localhost:5175");
  } finally {
    await app.close();
  }
  assert.equal(closed, true);
});

test("every application route has a schema entry and every schema entry has a route", async () => {
  const queue: DocumentQueue = {
    hasDocumentJob: async () => false, hasSourceJob: async () => false, enqueueDocument: async () => {}, enqueueSource: async () => {}, close: async () => {},
  };
  const app = buildApp({ queue });
  const routes = new Set<string>();
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) if (method !== "HEAD" && method !== "OPTIONS") routes.add(`${method} ${route.url}`);
  });
  try {
    await app.ready();
    assert.deepEqual([...routes].sort(), Object.keys(routeSchemas).sort());
  } finally {
    await app.close();
  }
});
