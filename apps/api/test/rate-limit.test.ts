import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { AdmissionError, createRedisAdmissionLimiter, type AdmissionLimiter, type AdmissionRule } from "@nyz-rag/processing";
import { buildApp } from "../src/app.js";
import { digest } from "../src/auth-store.js";
import { configureCommon } from "../src/common.js";
import { configureRateLimits, rateLimitConfig, trustedProxies } from "../src/rate-limit.js";
import { configureUserAuth } from "../src/user-auth.js";
import { memoryAuthStore, memoryUsers, userAuth, userHeaders } from "./auth-helpers.js";

function memoryLimiter() {
  const calls: AdmissionRule[][] = [];
  const counts = new Map<string, number>();
  const active = new Map<string, number>();
  const limiter: AdmissionLimiter = {
    async acquire(rules) {
      calls.push(rules);
      for (const rule of rules) {
        if ((counts.get(rule.key) ?? 0) >= rule.limit || (rule.concurrency && (active.get(rule.key) ?? 0) >= rule.concurrency)) {
          throw new AdmissionError(429, 12, "Too many requests");
        }
      }
      for (const rule of rules) {
        counts.set(rule.key, (counts.get(rule.key) ?? 0) + 1);
        if (rule.concurrency) active.set(rule.key, (active.get(rule.key) ?? 0) + 1);
      }
      let released = false;
      return { async release() {
        if (released) return;
        released = true;
        for (const rule of rules) if (rule.concurrency) active.set(rule.key, active.get(rule.key)! - 1);
      } };
    },
    async close() {},
  };
  return { limiter, calls, active };
}

test("deployment limits are positive integers; proxy trust requires explicit networks", () => {
  assert.equal(rateLimitConfig({}).ip, 120);
  for (const value of ["", "0", "-1", "NaN", "1.5", "Infinity"]) {
    assert.throws(() => rateLimitConfig({ API_IP_RATE_LIMIT_MAX: value }));
  }
  assert.equal(trustedProxies(""), false);
  assert.deepEqual(trustedProxies("127.0.0.1, 172.18.0.0/24,::1"), ["127.0.0.1", "172.18.0.0/24", "::1"]);
  for (const value of ["true", "1", "*", "0.0.0.0/0", "::/00", "127.0.0.1/33", "::1/129", "127.0.0.1/"]) assert.throws(() => trustedProxies(value));
});

test("real app rejects admission before auth/database; health and preflight stay available", async () => {
  const limiter: AdmissionLimiter = {
    async acquire() { throw new AdmissionError(429, 7, "Too many requests"); }, async close() {},
  };
  const app = buildApp({ limiter, authStore: memoryAuthStore(), userAuthStore: memoryAuthStore(), mailer: null });
  try {
    for (const url of ["/api/search", "/api/chat", "/api/chat/sessions/00000000-0000-4000-8000-000000000001/stream", "/api/admin/auth/login"]) {
      const response = await app.inject({ method: "POST", url, headers: { origin: "http://localhost:5175" }, payload: {} });
      assert.equal(response.statusCode, 429, response.body);
      assert.equal(response.headers["retry-after"], "7");
      assert.equal(response.headers["access-control-expose-headers"], "Retry-After");
      assert.deepEqual(response.json(), { error: "Too many requests" });
    }
    assert.equal((await app.inject("/health")).statusCode, 200);
    assert.equal((await app.inject({ method: "OPTIONS", url: "/api/chat", headers: { origin: "https://example.com", "access-control-request-method": "POST" } })).statusCode, 204);
    limiter.acquire = async () => { throw new AdmissionError(503, 1, "Admission service unavailable"); };
    const unavailable = await app.inject({ method: "POST", url: "/api/search", payload: {} });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.headers["retry-after"], "1");
    assert.deepEqual(unavailable.json(), { error: "Admission service unavailable" });
  } finally { await app.close(); }
});

test("IP budgets ignore forged forwarding headers and isolate real peers", async () => {
  const { limiter } = memoryLimiter();
  const app = Fastify();
  configureCommon(app);
  configureRateLimits(app, limiter, { ...rateLimitConfig({}), ip: 1 });
  app.get("/api/probe", async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ url: "/api/probe", remoteAddress: "192.0.2.1", headers: { "x-forwarded-for": "198.51.100.1" } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/probe", remoteAddress: "192.0.2.1", headers: { "x-forwarded-for": "198.51.100.2" } })).statusCode, 429);
    assert.equal((await app.inject({ url: "/api/probe", remoteAddress: "192.0.2.2" })).statusCode, 200);
  } finally { await app.close(); }
});

test("production chat routes acquire chat admission before handler infrastructure", async () => {
  const calls: AdmissionRule[][] = [];
  const limiter: AdmissionLimiter = {
    async acquire(rules) {
      calls.push(rules);
      if (rules.some((rule) => rule.key.startsWith("chat:"))) throw new AdmissionError(429, 2, "Chat busy");
      return { async release() {} };
    },
    async close() {},
  };
  const app = buildApp({ limiter, authStore: memoryAuthStore(), userAuthStore: memoryAuthStore(), mailer: null, users: memoryUsers().repository });
  try {
    for (const url of ["/api/chat", "/api/chat/sessions/00000000-0000-4000-8000-000000000001/stream"]) {
      const response = await app.inject({ method: "POST", url, headers: userHeaders, payload: { question: "test" } });
      assert.equal(response.statusCode, 429, response.body);
      assert.deepEqual(response.json(), { error: "Chat busy" });
    }
    assert.equal(calls.filter((rules) => rules.some((rule) => rule.key === "chat:global")).length, 2);
  } finally { await app.close(); }
});

test("only explicitly trusted proxies can provide the client address", async () => {
  const app = Fastify({ trustProxy: trustedProxies("127.0.0.1") });
  app.get("/ip", async (request) => ({ ip: request.ip }));
  try {
    assert.equal((await app.inject({ url: "/ip", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.1, 192.0.2.1" } })).json().ip, "192.0.2.1");
    assert.equal((await app.inject({ url: "/ip", remoteAddress: "192.0.2.2", headers: { "x-forwarded-for": "203.0.113.1" } })).json().ip, "192.0.2.2");
  } finally { await app.close(); }
});

test("verified user budget follows the account across IPs and sessions", async () => {
  const { limiter, calls } = memoryLimiter();
  const store = memoryAuthStore();
  const users = memoryUsers();
  const user = await users.repository.createUser({ email: "reader@example.com", passwordHash: "unused" });
  const tokens = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  for (const token of tokens) await store.set(`user-session:${digest(token)}`, JSON.stringify({ userId: user!.id, version: 0, expiresAt: new Date(Date.now() + 60000).toISOString() }), 60);
  const app = Fastify();
  configureCommon(app);
  configureRateLimits(app, limiter, { ...rateLimitConfig({}), user: 1 });
  configureUserAuth(app, { config: userAuth, store, mailer: null, users: users.repository });
  try {
    assert.equal((await app.inject({ url: "/api/auth/session", remoteAddress: "192.0.2.1", headers: { cookie: `nyz_user_session=${tokens[0]}` } })).statusCode, 200);
    assert.equal((await app.inject({ url: "/api/auth/session", remoteAddress: "192.0.2.2", headers: { cookie: `nyz_user_session=${tokens[1]}` } })).statusCode, 429);
    assert.equal((await app.inject({ url: "/api/auth/session", remoteAddress: "192.0.2.3", headers: { "x-user-id": user!.id } })).statusCode, 200);
    assert.equal(calls.filter((rules) => rules[0]?.key === `api:user:${digest(user!.id)}`).length, 2);
  } finally { await app.close(); }
});

test("chat concurrency spans single-answer and SSE, releases on error and completed streams", async () => {
  const { limiter, active } = memoryLimiter();
  const app = Fastify();
  configureCommon(app);
  configureRateLimits(app, limiter, { ...rateLimitConfig({}), chatUserConcurrency: 1 });
  configureUserAuth(app, { config: userAuth, store: memoryAuthStore(), mailer: null, users: memoryUsers().repository });
  let start!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  app.post("/api/chat", async () => { start(); await pending; throw new Error("handler failed"); });
  app.post("/api/chat/sessions/:id/stream", async (_request, reply) => { reply.hijack(); reply.raw.end("event: done\ndata: {}\n\n"); });
  const headers = { ...userHeaders, cookie: `nyz_visitor=${"a".repeat(64)}` };
  const stream = () => app.inject({ method: "POST", url: "/api/chat/sessions/00000000-0000-4000-8000-000000000001/stream", headers, payload: { question: "test" } });
  try {
    const first = app.inject({ method: "POST", url: "/api/chat", headers, payload: { question: "test" } }).then((response) => response);
    await started;
    assert.equal((await stream()).statusCode, 429, "blocked before SSE headers are sent");
    finish();
    assert.equal((await first).statusCode, 500);
    assert.equal((await stream()).statusCode, 200);
    assert.ok([...active.values()].every((count) => count === 0));
    assert.equal((await stream()).statusCode, 200);
  } finally { finish(); await app.close(); }
});

test("rotating visitor cookies does not bypass the chat IP budget", async () => {
  const { limiter } = memoryLimiter();
  const app = Fastify();
  configureCommon(app);
  configureRateLimits(app, limiter, { ...rateLimitConfig({}), chatIp: 1 });
  configureUserAuth(app, { config: userAuth, store: memoryAuthStore(), mailer: null, users: memoryUsers().repository });
  app.post("/api/chat", async (_request, reply) => reply.code(204).send());
  try {
    for (const [index, cookie] of ["a", "b"].entries()) {
      const response = await app.inject({ method: "POST", url: "/api/chat", headers: { ...userHeaders, cookie: `nyz_visitor=${cookie.repeat(64)}` }, payload: { question: "test" } });
      assert.equal(response.statusCode, index === 0 ? 204 : 429);
    }
  } finally { await app.close(); }
});

test("global chat concurrency caps distinct clients without consuming their chat budgets", async () => {
  const { limiter } = memoryLimiter();
  const app = Fastify();
  configureCommon(app);
  configureRateLimits(app, limiter, { ...rateLimitConfig({}), chatGlobalConcurrency: 1, chatIp: 1, chatUser: 1 });
  configureUserAuth(app, { config: userAuth, store: memoryAuthStore(), mailer: null, users: memoryUsers().repository });
  let start!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  app.post("/api/chat", async (_request, reply) => { start(); await pending; return reply.code(204).send(); });
  const send = (ip: string, token: string) => app.inject({ method: "POST", url: "/api/chat", remoteAddress: ip, headers: { ...userHeaders, cookie: `nyz_visitor=${token.repeat(64)}` }, payload: { question: "test" } });
  try {
    const first = send("192.0.2.1", "a").then((response) => response);
    await started;
    assert.equal((await send("192.0.2.2", "b")).statusCode, 429);
    finish();
    assert.equal((await first).statusCode, 204);
    assert.equal((await send("192.0.2.2", "b")).statusCode, 204);
  } finally { finish(); await app.close(); }
});

test("disconnecting an SSE client retains concurrency until handler cleanup finishes", async () => {
  const { limiter, active } = memoryLimiter();
  const app = Fastify();
  configureCommon(app);
  configureRateLimits(app, limiter, { ...rateLimitConfig({}), chatUserConcurrency: 1 });
  configureUserAuth(app, { config: userAuth, store: memoryAuthStore(), mailer: null, users: memoryUsers().repository });
  let disconnected!: () => void;
  let finish!: () => void;
  let released!: () => void;
  const closed = new Promise<void>((resolve) => { disconnected = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const cleaned = new Promise<void>((resolve) => { released = resolve; });
  const acquire = limiter.acquire.bind(limiter);
  limiter.acquire = async (...args) => {
    const lease = await acquire(...args);
    return { async release() { await lease.release(); if (args[0].some((rule) => rule.concurrency)) released(); } };
  };
  app.post("/api/chat/sessions/:id/stream", async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    reply.raw.write(": heartbeat\n\n");
    reply.raw.once("close", disconnected);
    await pending;
  });
  app.post("/api/chat", async (_request, reply) => reply.code(204).send());
  const headers = { ...userHeaders, cookie: `nyz_visitor=${"c".repeat(64)}`, "content-type": "application/json" };
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      const client = httpRequest(`${address}/api/chat/sessions/00000000-0000-4000-8000-000000000001/stream`, { method: "POST", headers }, (response) => {
        response.once("data", () => { response.destroy(); resolve(); });
      });
      client.on("error", reject);
      client.end(JSON.stringify({ question: "test" }));
    });
    await closed;
    assert.ok([...active.values()].some((count) => count === 1));
    const blocked = await app.inject({ method: "POST", url: "/api/chat", headers, payload: { question: "test" } });
    assert.equal(blocked.statusCode, 429);
    finish();
    await cleaned;
    assert.ok([...active.values()].every((count) => count === 0));
    assert.equal((await app.inject({ method: "POST", url: "/api/chat", headers, payload: { question: "test" } })).statusCode, 204);
  } finally { finish(); await app.close(); }
});

test("real Redis shares IP admission between API replicas", { skip: process.env.NYZ_RATE_LIMIT_REDIS_TEST !== "1" }, async () => {
  const prefix = `nyz-test-api-admission:${randomBytes(12).toString("hex")}:`;
  const apps = [0, 1].map(() => buildApp({
    limiter: createRedisAdmissionLimiter({ prefix }),
    rateLimits: { ...rateLimitConfig({}), ip: 1, windowMs: 1000 },
    authStore: memoryAuthStore(), userAuthStore: memoryAuthStore(), mailer: null, users: memoryUsers().repository,
  }));
  try {
    assert.equal((await apps[0]!.inject({ url: "/api/auth/session", remoteAddress: "192.0.2.1" })).statusCode, 200);
    const denied = await apps[1]!.inject({ url: "/api/auth/session", remoteAddress: "192.0.2.1" });
    assert.equal(denied.statusCode, 429, denied.body);
    assert.equal(denied.headers["retry-after"], "1");
    assert.equal((await apps[1]!.inject({ url: "/api/auth/session", remoteAddress: "192.0.2.2" })).statusCode, 200);
  } finally { await Promise.all(apps.map((app) => app.close())); }
});
