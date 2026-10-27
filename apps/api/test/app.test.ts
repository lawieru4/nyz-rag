import assert from "node:assert/strict";
import test from "node:test";
import { buildTestApp as buildApp } from "./auth-helpers.js";
import { routeSchemas } from "../src/schemas.js";
import { adminAuth, adminHeaders, memoryAdmins, memoryAuthStore, memoryMailer, memoryUsers, userAuth, userHeaders } from "./auth-helpers.js";
import { hashPassword } from "../src/passwords.js";
import { randomUUID } from "node:crypto";

const TEST_EMAIL = "admin@example.com";
const TEST_PASSWORD = "test-only-password-not-for-deployment";

async function makeTestAdmins() {
  const now = new Date().toISOString();
  const { repository } = memoryAdmins([{
    id: randomUUID(), email: TEST_EMAIL, nickname: "admin",
    passwordHash: await hashPassword(TEST_PASSWORD),
    isSuper: true, sessionVersion: 0, disabled: false,
    createdAt: now, updatedAt: now,
  }]);
  return repository;
}

test("the application registers all domains and rejects bad requests before accessing infrastructure", async () => {
  const admins = await makeTestAdmins();
  const app = buildApp({ adminAuth, authStore: memoryAuthStore(), admins, userAuth, userAuthStore: memoryAuthStore(), mailer: memoryMailer(), users: memoryUsers().repository });
  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().service, "nyz-rag-api");
    for (const [method, url] of [
      ["POST", "/api/chat"], ["POST", "/api/search"], ["GET", "/api/documents/:id"],
      ["GET", "/api/admin/documents"], ["POST", "/api/admin/sources"], ["POST", "/api/admin/sources/:id/sync"],
      ["GET", "/api/admin/knowledge-bases"], ["GET", "/api/admin/model-providers"], ["GET", "/api/admin/chat-logs"],
    ] as const) assert.ok(app.hasRoute({ method, url }), `${method} ${url}`);

    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: TEST_EMAIL, password: TEST_PASSWORD } });
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
});

test("readiness reports failed dependencies without exposing their errors", async () => {
  const healthy = { database: async () => {}, redis: async () => {} };
  const app = buildApp({ adminAuth, authStore: memoryAuthStore(), userAuth, userAuthStore: memoryAuthStore(), mailer: memoryMailer(), readiness: healthy });
  try {
    const ready = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: "ready", checks: { database: "ok", redis: "ok" } });
  } finally {
    await app.close();
  }

  const broken = buildApp({
    adminAuth, authStore: memoryAuthStore(), userAuth, userAuthStore: memoryAuthStore(), mailer: memoryMailer(),
    readiness: { database: async () => {}, redis: async () => { throw new Error("connect ECONNREFUSED redis://secret@10.0.0.1:6379"); } },
  });
  try {
    const result = await broken.inject({ method: "GET", url: "/ready" });
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.json(), { error: "Not ready: redis" });
    // 存活检查不受依赖影响。
    assert.equal((await broken.inject("/health")).statusCode, 200);
  } finally {
    await broken.close();
  }
});

test("every route schema declares the shared error responses", () => {
  // 错误响应（含权限不足的 403）只输出 { error }，不能把其他字段带给客户端。
  for (const [route, schema] of Object.entries(routeSchemas) as [string, { response?: Record<string, { properties?: object }> }][]) {
    for (const status of ["400", "401", "403", "404", "409", "429", "500", "503"]) {
      assert.deepEqual(schema.response?.[status]?.properties, { error: { type: "string" } }, `${route} ${status}`);
    }
  }
});

test("every application route has a schema entry and every schema entry has a route", async () => {
  const app = buildApp({ admins: memoryAdmins().repository });
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
