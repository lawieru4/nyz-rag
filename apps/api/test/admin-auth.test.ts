import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import Fastify, { type HTTPMethods } from "fastify";
import { buildApp } from "../src/app.js";
import { adminAuthConfig, configureAdminAuth, createAdminAuthStore } from "../src/admin-auth.js";
import { configureCommon } from "../src/common.js";
import { routeSchemas } from "../src/schemas.js";
import { adminAuth, adminHeaders, memoryAuthStore } from "./auth-helpers.js";

const queue = {
  hasDocumentJob: async () => false, hasSourceJob: async () => false,
  enqueueDocument: async () => {}, enqueueSource: async () => {}, close: async () => {},
};
const credentials = { username: adminAuth.username, password: adminAuth.password };
const login = (app: ReturnType<typeof buildApp>, cookie?: string) => app.inject({
  method: "POST", url: "/api/admin/auth/login", headers: { ...adminHeaders, ...(cookie ? { cookie } : {}) }, payload: credentials,
});
const getCookie = (response: { headers: Record<string, unknown> }) => String(response.headers["set-cookie"]).split(";")[0]!;

test("deployment config defaults to secure production cookies and rejects unsafe input", () => {
  const keys = ["NODE_ENV", "ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_ORIGINS", "ADMIN_COOKIE_SECURE"];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.NODE_ENV = "production";
    assert.equal(adminAuthConfig().secureCookie, true);
    assert.equal(adminAuthConfig().password, "");
    process.env.ADMIN_COOKIE_SECURE = "false";
    assert.equal(adminAuthConfig().secureCookie, false);
    for (const [key, value] of [["ADMIN_PASSWORD", "short"], ["ADMIN_USERNAME", " "], ["ADMIN_ORIGINS", "https://admin.example/path"], ["ADMIN_ORIGINS", "*"], ["ADMIN_COOKIE_SECURE", "invalid"]]) {
      const old = process.env[key!];
      process.env[key!] = value;
      assert.throws(() => adminAuthConfig());
      if (old === undefined) delete process.env[key!]; else process.env[key!] = old;
    }
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test("every admin domain is guarded before validation and infrastructure; public routes remain open", async () => {
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore() });
  try {
    for (const key of Object.keys(routeSchemas).filter((key) => key.includes(" /api/admin/") && !key.endsWith("/login"))) {
      const [method, path] = key.split(" ");
      const response = await app.inject({ method: method as HTTPMethods, url: path!.replace(":id", "invalid"), headers: adminHeaders });
      assert.equal(response.statusCode, 401, `${key}: ${response.body}`);
      assert.deepEqual(Object.keys(response.json()), ["error"]);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    assert.equal((await app.inject("/health")).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/search", payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: "HEAD", url: "/api/admin/documents" })).statusCode, 401);
  } finally { await app.close(); }
});

test("login restores a session, rotates previous cookies, and logout revokes replay across replicas", async () => {
  const store = memoryAuthStore();
  const app = buildApp({ queue, adminAuth: { ...adminAuth, secureCookie: true }, authStore: store });
  const replica = buildApp({ queue, adminAuth, authStore: store });
  try {
    const bad = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { ...credentials, password: "incorrect" } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.headers["set-cookie"], undefined);
    const result = await login(app);
    assert.equal(result.statusCode, 200, result.body);
    const cookie = getCookie(result);
    assert.match(String(result.headers["set-cookie"]), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
    assert.deepEqual(Object.keys(result.json()).sort(), ["expiresAt", "username"]);
    assert.equal((await replica.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 200);
    const rotated = await login(app, cookie);
    const newCookie = getCookie(rotated);
    assert.notEqual(newCookie, cookie);
    assert.equal((await replica.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 401);
    const authorized = await app.inject({ method: "POST", url: "/api/admin/sources", headers: { ...adminHeaders, cookie: newCookie }, payload: {} });
    assert.equal(authorized.statusCode, 400);
    const logout = await app.inject({ method: "POST", url: "/api/admin/auth/logout", headers: { ...adminHeaders, cookie: newCookie } });
    assert.equal(logout.statusCode, 204);
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await replica.inject({ url: "/api/admin/auth/session", headers: { cookie: newCookie } })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie: "nyz_admin_session=forged" } })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie: `${newCookie}; ${newCookie}` } })).statusCode, 401);
  } finally { await app.close(); await replica.close(); }
});

test("CSRF header and exact origins are enforced, including login; admin CORS is credentialed only for allowed origins", async () => {
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore() });
  try {
    for (const headers of [{}, { ...adminHeaders, origin: "https://evil.example" }, { ...adminHeaders, origin: "null" }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/admin/auth/login", headers, payload: credentials })).statusCode, 403);
    }
    const result = await login(app);
    const cookie = getCookie(result);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/auth/logout", headers: { cookie } })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie, origin: "https://evil.example" } })).statusCode, 403);
    for (const origin of [adminAuth.origins[0]!, "https://evil.example"]) {
      const preflight = await app.inject({ method: "OPTIONS", url: "/api/admin/documents", headers: { origin, "access-control-request-method": "DELETE", "access-control-request-headers": "x-nyz-admin" } });
      assert.equal(preflight.statusCode, 204);
      assert.equal(preflight.headers["access-control-allow-origin"], origin === adminAuth.origins[0] ? origin : undefined);
    }
    assert.equal(result.headers["access-control-allow-credentials"], "true");
    const publicResult = await app.inject({ url: "/health", headers: { origin: "https://evil.example" } });
    assert.equal(publicResult.headers["access-control-allow-credentials"], undefined);
  } finally { await app.close(); }
});

test("sessions expire and changed credentials invalidate stored sessions", async () => {
  let clock = Date.now();
  const store = memoryAuthStore(() => clock);
  const app = Fastify();
  configureCommon(app);
  configureAdminAuth(app, adminAuth, store, () => clock);
  const changed = buildApp({ queue, adminAuth: { ...adminAuth, password: "a-different-test-password" }, authStore: store });
  try {
    const result = await login(app);
    const cookie = getCookie(result);
    assert.equal((await changed.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 401);
    clock += 8 * 60 * 60 * 1000;
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 401);
  } finally { await app.close(); await changed.close(); }
});

test("login throttling is shared between replicas and expires", async () => {
  let clock = Date.now();
  const store = memoryAuthStore(() => clock);
  const app = buildApp({ queue, adminAuth, authStore: store });
  const replica = buildApp({ queue, adminAuth, authStore: store });
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal((await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { ...credentials, password: "bad" } })).statusCode, 401);
    }
    const limited = await login(replica);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["retry-after"], "900");
    clock += 900_000;
    assert.equal((await login(replica)).statusCode, 200);
  } finally { await app.close(); await replica.close(); }
});

test("blocked IPs cannot consume the remaining global login budget", async () => {
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore() });
  try {
    for (let i = 0; i < 105; i++) {
      const response = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { ...credentials, password: "bad" } });
      assert.equal(response.statusCode, i < 10 ? 401 : 429);
    }
    const response = await app.inject({ method: "POST", url: "/api/admin/auth/login", remoteAddress: "127.0.0.2", headers: adminHeaders, payload: credentials });
    assert.equal(response.statusCode, 200);
  } finally { await app.close(); }
});

test("login input is bounded and unknown fields are rejected", async () => {
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore() });
  try {
    for (const payload of [{}, { ...credentials, password: 123 }, { ...credentials, password: "x".repeat(1025) }, { ...credentials, role: "admin" }]) {
      const response = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload });
      assert.equal(response.statusCode, 400);
      assert.equal(response.headers["set-cookie"], undefined);
    }
  } finally { await app.close(); }
});

test("missing configuration and unavailable session storage fail closed", async () => {
  const missing = buildApp({ queue, adminAuth: { ...adminAuth, password: "" }, authStore: memoryAuthStore() });
  const unavailable = async (): Promise<never> => { throw new Error("secret redis URL"); };
  const store = memoryAuthStore();
  const broken = buildApp({ queue, adminAuth, authStore: store });
  try {
    assert.equal((await login(missing)).statusCode, 503);
    assert.equal((await missing.inject("/api/admin/documents")).statusCode, 503);
    const cookie = getCookie(await login(broken));
    store.delete = unavailable;
    const logout = await broken.inject({ method: "POST", url: "/api/admin/auth/logout", headers: { ...adminHeaders, cookie } });
    assert.equal(logout.statusCode, 503);
    assert.equal(logout.headers["set-cookie"], undefined);
    store.get = unavailable;
    const response = await broken.inject({ url: "/api/admin/auth/session", headers: { cookie } });
    assert.equal(response.statusCode, 503);
    assert.ok(!response.body.includes("secret"));
    store.increment = unavailable;
    assert.equal((await login(broken)).statusCode, 503);
  } finally { await missing.close(); await broken.close(); }
});

test("public overview serialization excludes source URLs and task errors", async () => {
  const app = Fastify();
  configureCommon(app);
  app.get("/api/knowledge", async () => ({ sources: [{ url: "private" }], tasks: [{ error: "private" }], stats: { documents: 1, sources: 1, processingTasks: 0 } }));
  try { assert.deepEqual(Object.keys((await app.inject("/api/knowledge")).json()), ["stats"]); }
  finally { await app.close(); }
});

test("real Redis shares and revokes sessions across API instances", { skip: process.env.NYZ_AUTH_REDIS_TEST !== "1" }, async () => {
  const previous = process.env.DOCUMENT_QUEUE_NAME;
  process.env.DOCUMENT_QUEUE_NAME = `nyz-rag-auth-test-${randomUUID()}`;
  const store = createAdminAuthStore();
  const replicaStore = createAdminAuthStore();
  if (previous === undefined) delete process.env.DOCUMENT_QUEUE_NAME;
  else process.env.DOCUMENT_QUEUE_NAME = previous;
  const app = buildApp({ queue, adminAuth, authStore: store });
  const replica = buildApp({ queue, adminAuth, authStore: replicaStore });
  try {
    const result = await login(app);
    assert.equal(result.statusCode, 200, result.body);
    const cookie = getCookie(result);
    assert.equal((await replica.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 200);
    assert.equal((await replica.inject({ method: "POST", url: "/api/admin/auth/logout", headers: { ...adminHeaders, cookie } })).statusCode, 204);
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 401);
  } finally {
    await store.delete("login:global");
    await store.delete(`login:ip:${createHash("sha256").update("127.0.0.1").digest("hex")}`);
    await app.close();
    await replica.close();
  }
});
