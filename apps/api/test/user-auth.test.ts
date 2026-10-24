import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { buildTestApp as buildApp } from "./auth-helpers.js";
import { configureCommon } from "../src/common.js";
import { configureUserAuth, requestOwner, userAuthConfig } from "../src/user-auth.js";
import { memoryAuthStore, memoryMailer, memoryUsers, userAuth, userHeaders } from "./auth-helpers.js";

const queue = {
  hasDocumentJob: async () => false,
  enqueueDocument: async () => {}, enqueueSource: async () => {}, close: async () => {},
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const password = "correct horse battery";

/** 带 Cookie 罐的测试客户端：按浏览器规则保存 Set-Cookie（Max-Age=0 即删除）。 */
function browser(app: ReturnType<typeof setup>["app"]) {
  const jar = new Map<string, string>();
  const send = async (method: "GET" | "POST" | "DELETE", url: string, payload?: object, headers: Record<string, string> = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await app.inject({ method, url, payload, headers: { ...userHeaders, ...(cookie ? { cookie } : {}), ...headers } });
    for (const line of [response.headers["set-cookie"] ?? []].flat()) {
      const [pair] = line.split(";");
      const [name, value] = pair!.split("=") as [string, string];
      if (/Max-Age=0\b/.test(line)) jar.delete(name); else jar.set(name, value);
    }
    return response;
  };
  return { jar, send, get: (url: string) => send("GET", url), post: (url: string, payload?: object) => send("POST", url, payload ?? {}) };
}

/** 只装配用户认证与一个回显归属的路由，不需要数据库。 */
function setup(options: { now?: () => number; mailer?: ReturnType<typeof memoryMailer> | null } = {}) {
  const store = memoryAuthStore(options.now);
  const users = memoryUsers();
  const mailer = options.mailer === undefined ? memoryMailer() : options.mailer;
  const app = Fastify();
  configureCommon(app);
  configureUserAuth(app, { config: userAuth, store, mailer, users: users.repository, now: options.now });
  app.get("/api/chat/owner", async (request) => requestOwner(request));
  return { app, store, users, mailer };
}

const lastCode = (mailer: ReturnType<typeof memoryMailer>) => mailer.sent.at(-1)!.text.match(/\d{6}/)![0];

async function register(client: ReturnType<typeof browser>, mailer: ReturnType<typeof memoryMailer>, email = "reader@example.com") {
  assert.equal((await client.post("/api/auth/register/code", { email })).statusCode, 204);
  const response = await client.post("/api/auth/register", { email, code: lastCode(mailer), password });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().user as { id: string; email: string };
}

test("deployment config defaults to secure production cookies and rejects unsafe origins", () => {
  const keys = ["NODE_ENV", "WEB_ORIGINS", "USER_COOKIE_SECURE", "WEB_PORT"];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(userAuthConfig(), { origins: ["http://localhost:5175", "http://127.0.0.1:5175"], secureCookie: false });
    process.env.NODE_ENV = "production";
    assert.equal(userAuthConfig().secureCookie, true);
    for (const [key, value] of [["WEB_ORIGINS", "https://web.example/path"], ["WEB_ORIGINS", "*"], ["USER_COOKIE_SECURE", "yes"]]) {
      process.env[key!] = value;
      assert.throws(() => userAuthConfig());
      delete process.env[key!];
    }
  } finally {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});

test("anonymous visitors get a stable HttpOnly visitor identity; writes require the client header", async () => {
  const { app } = setup();
  try {
    const client = browser(app);
    const first = await client.get("/api/auth/session");
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { user: null });
    assert.equal(first.headers["cache-control"], "no-store");
    assert.match(String(first.headers["set-cookie"]), /^nyz_visitor=[a-f0-9]{64}; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=31536000$/);
    const visitor = client.jar.get("nyz_visitor")!;
    const again = await client.get("/api/chat/owner");
    assert.equal(again.headers["set-cookie"], undefined, "an existing visitor cookie is reused");
    assert.deepEqual(again.json(), { visitorHash: sha256(visitor) }, "only the hash identifies the visitor");
    assert.notDeepEqual((await browser(app).get("/api/chat/owner")).json(), again.json(), "another browser is another visitor");
    const forged = await app.inject({ url: "/api/chat/owner", headers: { cookie: "nyz_visitor=not-a-token" } });
    assert.match(String(forged.headers["set-cookie"]), /^nyz_visitor=[a-f0-9]{64};/);
    const csrf = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: `nyz_visitor=${visitor}` } });
    assert.equal(csrf.statusCode, 403);
    assert.deepEqual(Object.keys(csrf.json()), ["error"]);
  } finally { await app.close(); }
});

test("registration verifies the mailbox first, logs in and claims the visitor's data", async () => {
  const { app, users, mailer } = setup();
  try {
    const client = browser(app);
    await client.get("/api/auth/session");
    const visitorHash = sha256(client.jar.get("nyz_visitor")!);
    assert.equal((await client.post("/api/auth/register/code", { email: "Reader@Example.com" })).statusCode, 204);
    assert.equal(mailer!.sent.length, 1);
    assert.equal(mailer!.sent[0]!.to, "reader@example.com");
    const code = lastCode(mailer!);
    const wrong = await client.post("/api/auth/register", { email: "reader@example.com", code: code === "000000" ? "111111" : "000000", password });
    assert.equal(wrong.statusCode, 400);
    assert.equal(users.accounts.size, 0, "no account exists before the mailbox is verified");
    const registered = await client.post("/api/auth/register", { email: "READER@example.com", code, password });
    assert.equal(registered.statusCode, 201, registered.body);
    const { user } = registered.json();
    assert.deepEqual(Object.keys(user).sort(), ["createdAt", "email", "id"]);
    assert.equal(user.email, "reader@example.com");
    assert.match(String(registered.headers["set-cookie"]), /nyz_user_session=[a-f0-9]{64}; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=2592000/);
    assert.deepEqual(users.claims, [{ visitorHash, userId: user.id }]);
    assert.equal(client.jar.has("nyz_visitor"), false, "the visitor cookie is cleared after its data moved to the account");
    assert.deepEqual((await client.get("/api/auth/session")).json(), { user });
    assert.deepEqual((await client.get("/api/chat/owner")).json(), { userId: user.id });
    assert.notEqual(users.accounts.get(user.id)!.passwordHash, password);
    assert.match(users.accounts.get(user.id)!.passwordHash, /^scrypt\$32768\$8\$1\$/);
    const reused = await browser(app).post("/api/auth/register", { email: "reader@example.com", code, password });
    assert.equal(reused.statusCode, 400, "a code can only be used once");
  } finally { await app.close(); }
});

test("an already registered email gets a notice instead of a code, with an identical response", async () => {
  let clock = Date.now();
  const { app, mailer } = setup({ now: () => clock });
  try {
    await register(browser(app), mailer!);
    clock += 60_000;
    const other = browser(app);
    const response = await other.post("/api/auth/register/code", { email: "reader@example.com" });
    assert.equal(response.statusCode, 204);
    assert.doesNotMatch(mailer!.sent.at(-1)!.text, /\d{6}/);
    assert.match(mailer!.sent.at(-1)!.text, /已经注册/);
  } finally { await app.close(); }
});

test("verification codes allow five attempts and sending is rate limited", async () => {
  let clock = Date.now();
  const { app, mailer } = setup({ now: () => clock });
  try {
    const client = browser(app);
    const email = "limits@example.com";
    assert.equal((await client.post("/api/auth/register/code", { email })).statusCode, 204);
    const cooldown = await client.post("/api/auth/register/code", { email });
    assert.equal(cooldown.statusCode, 429);
    assert.equal(cooldown.headers["retry-after"], "60");
    const code = lastCode(mailer!);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) assert.equal((await client.post("/api/auth/register", { email, code: wrong, password })).statusCode, 400);
    const exhausted = await client.post("/api/auth/register", { email, code, password });
    assert.equal(exhausted.statusCode, 400);
    assert.match(exhausted.json().error, /次数过多/);
    clock += 60_000;
    assert.equal((await client.post("/api/auth/register/code", { email })).statusCode, 204);
    assert.equal((await client.post("/api/auth/register", { email, code: lastCode(mailer!), password })).statusCode, 201, "a new code resets the attempts");
  } finally { await app.close(); }
});

test("login, logout and disabled accounts", async () => {
  const { app, users, mailer } = setup();
  try {
    const user = await register(browser(app), mailer!);
    const client = browser(app);
    await client.get("/api/auth/session");
    for (const credentials of [{ email: "reader@example.com", password: "wrong password" }, { email: "nobody@example.com", password }]) {
      const response = await client.post("/api/auth/login", credentials);
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, "邮箱或密码错误", "unknown emails and wrong passwords look the same");
    }
    const visitorHash = sha256(client.jar.get("nyz_visitor")!);
    const login = await client.post("/api/auth/login", { email: " Reader@example.com ".trim(), password });
    assert.equal(login.statusCode, 200, login.body);
    assert.deepEqual(users.claims.at(-1), { visitorHash, userId: user.id });
    const session = client.jar.get("nyz_user_session")!;
    assert.equal((await client.post("/api/auth/logout")).statusCode, 204);
    assert.equal(client.jar.has("nyz_user_session"), false);
    assert.match(client.jar.get("nyz_visitor") ?? "", /^[a-f0-9]{64}$/, "after logout the browser is a fresh visitor");
    assert.notEqual(sha256(client.jar.get("nyz_visitor")!), visitorHash);
    const replay = await app.inject({ url: "/api/auth/session", headers: { cookie: `nyz_user_session=${session}` } });
    assert.deepEqual(replay.json(), { user: null }, "a logged-out session cannot be replayed");
    assert.match(String(replay.headers["set-cookie"]), /nyz_user_session=; .*Max-Age=0/);

    const active = browser(app);
    assert.equal((await active.post("/api/auth/login", { email: "reader@example.com", password })).statusCode, 200);
    users.accounts.get(user.id)!.disabled = true;
    assert.deepEqual((await active.get("/api/auth/session")).json(), { user: null }, "disabling an account ends its sessions");
    const disabled = await browser(app).post("/api/auth/login", { email: "reader@example.com", password });
    assert.equal(disabled.statusCode, 403);
  } finally { await app.close(); }
});

test("login attempts are limited per email", async () => {
  const { app, mailer } = setup();
  try {
    await register(browser(app), mailer!);
    for (let i = 0; i < 10; i++) {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: `10.0.0.${i}`, headers: userHeaders, payload: { email: "reader@example.com", password: "wrong password" } });
      assert.equal(response.statusCode, 401);
    }
    const limited = await browser(app).post("/api/auth/login", { email: "reader@example.com", password });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["retry-after"], "900");
  } finally { await app.close(); }
});

test("password reset by email code revokes every existing session", async () => {
  const { app, mailer } = setup();
  try {
    const first = browser(app);
    const user = await register(first, mailer!);
    const sent = mailer!.sent.length;
    assert.equal((await browser(app).post("/api/auth/password-reset/code", { email: "nobody@example.com" })).statusCode, 204);
    assert.equal(mailer!.sent.length, sent, "unknown emails receive nothing but get the same response");
    const second = browser(app);
    assert.equal((await second.post("/api/auth/password-reset/code", { email: "reader@example.com" })).statusCode, 204);
    assert.match(mailer!.sent.at(-1)!.subject, /重置/);
    const reset = await second.post("/api/auth/password-reset", { email: "reader@example.com", code: lastCode(mailer!), password: "a brand new password" });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(reset.json().user.id, user.id);
    assert.deepEqual((await first.get("/api/auth/session")).json(), { user: null }, "sessions issued before the reset are revoked");
    assert.equal((await second.get("/api/auth/session")).json().user.id, user.id);
    assert.equal((await browser(app).post("/api/auth/login", { email: "reader@example.com", password })).statusCode, 401);
    assert.equal((await browser(app).post("/api/auth/login", { email: "reader@example.com", password: "a brand new password" })).statusCode, 200);
  } finally { await app.close(); }
});

test("changing the password requires the current one and rotates the session", async () => {
  const { app, mailer } = setup();
  try {
    assert.equal((await browser(app).post("/api/auth/password", { currentPassword: password, password: "another password" })).statusCode, 401);
    const client = browser(app);
    await register(client, mailer!);
    const other = browser(app);
    await other.post("/api/auth/login", { email: "reader@example.com", password });
    const before = client.jar.get("nyz_user_session");
    assert.equal((await client.post("/api/auth/password", { currentPassword: "wrong password", password: "another password" })).statusCode, 400);
    assert.equal((await client.post("/api/auth/password", { currentPassword: password, password: "another password" })).statusCode, 204);
    assert.notEqual(client.jar.get("nyz_user_session"), before);
    assert.notEqual((await client.get("/api/auth/session")).json().user, null);
    assert.deepEqual((await other.get("/api/auth/session")).json(), { user: null }, "other devices are signed out");
  } finally { await app.close(); }
});

test("input is validated and bounded; unknown fields are rejected", async () => {
  const { app } = setup();
  const full = buildApp({ queue, userAuth, userAuthStore: memoryAuthStore(), mailer: memoryMailer(), users: memoryUsers().repository });
  try {
    for (const [url, payload] of [
      ["/api/auth/register/code", { email: "not-an-email" }],
      ["/api/auth/register/code", { email: "reader@example.com", extra: 1 }],
      ["/api/auth/register", { email: "reader@example.com", code: "12345", password }],
      ["/api/auth/register", { email: "reader@example.com", code: "123456", password: "short" }],
      ["/api/auth/register", { email: "reader@example.com", code: "123456", password: " ".repeat(12) }],
      ["/api/auth/register", { email: "reader@example.com", code: "123456", password: "x".repeat(129) }],
      ["/api/auth/login", { email: "reader@example.com" }],
      ["/api/auth/password-reset", { email: "reader@example.com", code: "123456" }],
    ] as const) {
      const response = await full.inject({ method: "POST", url, headers: userHeaders, payload });
      assert.equal(response.statusCode, 400, `${url} ${JSON.stringify(payload)}: ${response.body}`);
      assert.deepEqual(Object.keys(response.json()), ["error"]);
    }
  } finally { await app.close(); await full.close(); }
});

test("missing mail configuration and unavailable session storage fail closed without leaking details", async () => {
  const { app } = setup({ mailer: null });
  try {
    assert.equal((await browser(app).post("/api/auth/register/code", { email: "reader@example.com" })).statusCode, 503);
    assert.equal((await browser(app).post("/api/auth/password-reset/code", { email: "reader@example.com" })).statusCode, 503);
  } finally { await app.close(); }

  const broken = setup();
  try {
    const client = browser(broken.app);
    await register(client, broken.mailer!);
    const unavailable = async (): Promise<never> => { throw new Error("secret redis URL"); };
    broken.store.get = unavailable;
    broken.store.increment = unavailable;
    const response = await client.get("/api/auth/session");
    assert.equal(response.statusCode, 503);
    assert.ok(!response.body.includes("secret"));
    const visitor = await browser(broken.app).get("/api/auth/session");
    assert.equal(visitor.statusCode, 200, "anonymous visitors do not depend on the session store");
    assert.equal((await browser(broken.app).post("/api/auth/login", { email: "reader@example.com", password })).statusCode, 503);
  } finally { await broken.app.close(); }
});

test("user routes allow credentialed CORS only for web origins", async () => {
  const app = buildApp({ queue, userAuth, userAuthStore: memoryAuthStore(), mailer: memoryMailer(), users: memoryUsers().repository });
  try {
    for (const origin of [userAuth.origins[0]!, "https://evil.example"]) {
      const preflight = await app.inject({ method: "OPTIONS", url: "/api/chat/sessions", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-nyz-client" } });
      assert.equal(preflight.statusCode, 204);
      assert.equal(preflight.headers["access-control-allow-credentials"], origin === userAuth.origins[0] ? "true" : undefined);
    }
    const session = await app.inject({ url: "/api/auth/session", headers: { origin: userAuth.origins[0]! } });
    assert.equal(session.headers["access-control-allow-origin"], userAuth.origins[0]);
    assert.equal(session.headers["access-control-allow-credentials"], "true");
  } finally { await app.close(); }
});
