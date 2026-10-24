import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import Fastify, { type HTTPMethods } from "fastify";
import { buildTestApp as buildApp } from "./auth-helpers.js";
import { adminAuthConfig, configureAdminAuth, createAdminAuthStore } from "../src/admin-auth.js";
import { configureCommon } from "../src/common.js";
import { routeSchemas } from "../src/schemas.js";
import { adminAuth, adminHeaders, memoryAuthStore, memoryAdmins, userAuth } from "./auth-helpers.js";
import { hashPassword } from "../src/passwords.js";

const queue = {
  hasDocumentJob: async () => false, hasSourceJob: async () => false,
  enqueueDocument: async () => {}, enqueueSource: async () => {}, close: async () => {},
};

async function makeAdmins(options: { email?: string; password?: string; isSuper?: boolean; disabled?: boolean } = {}) {
  const email = options.email ?? "admin@example.com";
  const password = options.password ?? "test-only-password-not-for-deployment";
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const { repository } = memoryAdmins([{
    id: randomUUID(),
    email,
    nickname: "admin",
    passwordHash,
    isSuper: options.isSuper ?? true,
    sessionVersion: 0,
    disabled: options.disabled ?? false,
    createdAt: now,
    updatedAt: now,
  }]);
  return { repository, email, password };
}

const getCookie = (response: { headers: Record<string, unknown> }) => String(response.headers["set-cookie"]).split(";")[0]!;

test("deployment config defaults to secure production cookies and rejects unsafe input", () => {
  const keys = ["NODE_ENV", "ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_ORIGINS", "ADMIN_COOKIE_SECURE"];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) delete process.env[key];
    process.env.NODE_ENV = "production";
    assert.equal(adminAuthConfig().secureCookie, true);
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
  const { repository } = await makeAdmins();
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    for (const key of Object.keys(routeSchemas).filter((key) => key.includes(" /api/admin/") && !key.endsWith("/login"))) {
      const [method, path] = key.split(" ");
      const response = await app.inject({ method: method as HTTPMethods, url: path!.replace(":id", randomUUID()), headers: adminHeaders });
      assert.equal(response.statusCode, 401, `${key}: ${response.body}`);
      assert.deepEqual(Object.keys(response.json()), ["error"]);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    assert.equal((await app.inject("/health")).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/search", payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: "HEAD", url: "/api/admin/documents" })).statusCode, 401);
  } finally { await app.close(); }
});

test("login with email succeeds and session contains AdminAccount; login with wrong password fails", async () => {
  const { repository, email, password } = await makeAdmins();
  const store = memoryAuthStore();
  const app = buildApp({ queue, adminAuth: { ...adminAuth, secureCookie: true }, authStore: store, admins: repository });
  try {
    const bad = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password: "wrong" } });
    assert.equal(bad.statusCode, 401);

    const result = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    assert.equal(result.statusCode, 200, result.body);
    const session = result.json();
    assert.match(String(result.headers["set-cookie"]), /HttpOnly; SameSite=Strict; Max-Age=28800; Secure/);
    // Session must include username, expiresAt, and admin object
    assert.equal(typeof session.username, "string");
    assert.equal(typeof session.expiresAt, "string");
    assert.ok(session.admin);
    assert.equal(session.admin.email, email);
    assert.equal(typeof session.admin.isSuper, "boolean");
    assert.equal(typeof session.admin.disabled, "boolean");
    assert.equal(typeof session.admin.createdAt, "string");
    assert.equal(typeof session.admin.updatedAt, "string");
    assert.equal(Object.keys(session).sort().join(","), "admin,expiresAt,permissions,username");
    assert.equal(session.permissions.length, 12, "super admin has every permission");
    assert.equal(session.admin.roleId, null);
  } finally { await app.close(); }
});

test("login rotates cookie; session returns updated state; logout revokes across replicas", async () => {
  const { repository, email, password } = await makeAdmins();
  const store = memoryAuthStore();
  const app = buildApp({ queue, adminAuth, authStore: store, admins: repository });
  const replica = buildApp({ queue, adminAuth, authStore: store, admins: repository });
  try {
    const login1 = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    const cookie1 = getCookie(login1);
    assert.equal(login1.statusCode, 200);
    assert.equal((await replica.inject({ url: "/api/admin/auth/session", headers: { cookie: cookie1 } })).statusCode, 200);

    const login2 = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: { ...adminHeaders, cookie: cookie1 }, payload: { username: email, password } });
    const cookie2 = getCookie(login2);
    assert.notEqual(cookie2, cookie1);
    assert.equal((await replica.inject({ url: "/api/admin/auth/session", headers: { cookie: cookie1 } })).statusCode, 401);

    const logout = await app.inject({ method: "POST", url: "/api/admin/auth/logout", headers: { ...adminHeaders, cookie: cookie2 } });
    assert.equal(logout.statusCode, 204);
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);
    assert.equal((await replica.inject({ url: "/api/admin/auth/session", headers: { cookie: cookie2 } })).statusCode, 401);
  } finally { await app.close(); await replica.close(); }
});

test("CSRF header and exact origins are enforced on admin routes", async () => {
  const { repository, email, password } = await makeAdmins();
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    // Missing x-nyz-admin header
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: {}, payload: { username: email, password } })).statusCode, 403);
    // Wrong origin
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: { ...adminHeaders, origin: "https://evil.example" }, payload: { username: email, password } })).statusCode, 403);
    // null origin
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: { ...adminHeaders, origin: "null" }, payload: { username: email, password } })).statusCode, 403);
  } finally { await app.close(); }
});

test("CORS preflight allows every method used by admin and credentialed user routes", async () => {
  const { repository } = await makeAdmins();
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository, userAuth });
  try {
    for (const key of Object.keys(routeSchemas)) {
      const [method, path] = key.split(" ") as [string, string];
      const origin = path.startsWith("/api/admin/") ? adminAuth.origins[0]!
        : /^\/api\/(chat|messages|auth)(\/|$)/.test(path) ? userAuth.origins[0]! : null;
      if (!origin) continue;
      const preflight = await app.inject({ method: "OPTIONS", url: path.replace(":id", randomUUID()), headers: { origin, "access-control-request-method": method } });
      assert.equal(preflight.statusCode, 204, `${key}: ${preflight.body}`);
      assert.ok(String(preflight.headers["access-control-allow-methods"]).split(/,\s*/).includes(method), `${key}: ${preflight.headers["access-control-allow-methods"]}`);
    }
  } finally { await app.close(); }
});

test("sessions expire and per-request DB check invalidates sessions of disabled admins", async () => {
  const { repository, email, password } = await makeAdmins();
  let clock = Date.now();
  const store = memoryAuthStore(() => clock);
  const app = buildApp({ queue, adminAuth, authStore: store, admins: repository });
  try {
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    const cookie = getCookie(login);
    assert.equal(login.statusCode, 200);
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 200);

    // Disable the account via the mutable in-memory store
    const stored = [...repository._accounts.values()][0]!;
    stored.disabled = true;
    stored.sessionVersion += 1; // simulate disabledAt → version bump
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 401);

    // Re-enable
    stored.disabled = false;
    stored.sessionVersion -= 1;
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 200);

    // Session expiry
    clock += 8 * 60 * 60 * 1000 + 1;
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 401);
  } finally { await app.close(); }
});

test("login throttling is shared between replicas and expires", async () => {
  let clock = Date.now();
  const { repository, email } = await makeAdmins();
  const store = memoryAuthStore(() => clock);
  const app = buildApp({ queue, adminAuth, authStore: store, admins: repository });
  const replica = buildApp({ queue, adminAuth, authStore: store, admins: repository });
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal((await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password: "bad" } })).statusCode, 401);
    }
    const limited = await replica.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password: "bad" } });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["retry-after"], "900");
    clock += 900_000;
    const { password } = await makeAdmins({ email });
    // After window expires, login should succeed (requires re-creating proper store state)
    const fresh = await replica.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    assert.equal(fresh.statusCode, 200);
  } finally { await app.close(); await replica.close(); }
});

test("blocked IPs cannot consume the remaining global login budget", async () => {
  const { repository, email, password } = await makeAdmins();
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    for (let i = 0; i < 105; i++) {
      const response = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password: "bad" } });
      assert.equal(response.statusCode, i < 10 ? 401 : 429);
    }
    const response = await app.inject({ method: "POST", url: "/api/admin/auth/login", remoteAddress: "127.0.0.2", headers: adminHeaders, payload: { username: email, password } });
    assert.equal(response.statusCode, 200);
  } finally { await app.close(); }
});

test("login input is bounded and unknown fields are rejected", async () => {
  const { repository, email, password } = await makeAdmins();
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    for (const payload of [
      {},
      { username: email, password: 123 },
      { username: email, password: "x".repeat(1025) },
      { username: email, password, role: "admin" },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload });
      assert.equal(response.statusCode, 400, `payload: ${JSON.stringify(payload)}`);
      assert.equal(response.headers["set-cookie"], undefined);
    }
  } finally { await app.close(); }
});

test("missing auth store availability fails closed", async () => {
  const { repository, email, password } = await makeAdmins();
  const store = memoryAuthStore();
  const app = buildApp({ queue, adminAuth, authStore: store, admins: repository });
  try {
    const cookie = getCookie(await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } }));
    const unavailable = async (): Promise<never> => { throw new Error("secret redis URL"); };
    store.get = unavailable;
    const response = await app.inject({ url: "/api/admin/auth/session", headers: { cookie } });
    assert.equal(response.statusCode, 503);
    assert.ok(!response.body.includes("secret"));
    store.increment = unavailable;
    const limited = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    assert.equal(limited.statusCode, 503);
  } finally { await app.close(); }
});

test("PATCH /api/admin/auth/profile updates email and nickname; returns new session with admin object", async () => {
  const { repository, email, password } = await makeAdmins();
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    const cookie = getCookie(login);
    const patch = await app.inject({
      method: "PATCH", url: "/api/admin/auth/profile",
      headers: { ...adminHeaders, cookie },
      payload: { email: "newemail@example.com", nickname: "New Name" },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const session = patch.json();
    assert.equal(session.admin.email, "newemail@example.com");
    assert.equal(session.admin.nickname, "New Name");
    assert.equal(session.username, "newemail@example.com");
  } finally { await app.close(); }
});

test("PATCH /api/admin/auth/profile rejects missing or invalid fields", async () => {
  const { repository, email, password } = await makeAdmins();
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    const cookie = getCookie(login);
    for (const payload of [
      {},
      { email: "not-an-email", nickname: "a" },
      { email: "a@b.com" }, // missing nickname
      { email: "a@b.com", nickname: "" }, // blank nickname
    ]) {
      const response = await app.inject({ method: "PATCH", url: "/api/admin/auth/profile", headers: { ...adminHeaders, cookie }, payload });
      assert.equal(response.statusCode, 400, `payload: ${JSON.stringify(payload)}: ${response.body}`);
    }
  } finally { await app.close(); }
});

test("POST /api/admin/auth/password changes password, revokes session, requires re-login", async () => {
  const { repository, email, password } = await makeAdmins();
  const store = memoryAuthStore();
  const app = buildApp({ queue, adminAuth, authStore: store, admins: repository });
  try {
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    const cookie = getCookie(login);
    // Wrong current password
    const wrongPw = await app.inject({
      method: "POST", url: "/api/admin/auth/password",
      headers: { ...adminHeaders, cookie },
      payload: { currentPassword: "wrong-password", newPassword: "a-brand-new-password" },
    });
    assert.equal(wrongPw.statusCode, 400, wrongPw.body);
    // Correct change
    const newPassword = "a-brand-new-password-xyz";
    const change = await app.inject({
      method: "POST", url: "/api/admin/auth/password",
      headers: { ...adminHeaders, cookie },
      payload: { currentPassword: password, newPassword },
    });
    assert.equal(change.statusCode, 204, change.body);
    assert.match(String(change.headers["set-cookie"]), /Max-Age=0/);
    // Old session is revoked
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 401);
    // New password works
    const newLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password: newPassword } });
    assert.equal(newLogin.statusCode, 200, newLogin.body);
    // Old password no longer works
    const oldLogin = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    assert.equal(oldLogin.statusCode, 401);
  } finally { await app.close(); }
});

test("POST /api/admin/auth/password rejects short or blank new passwords", async () => {
  const { repository, email, password } = await makeAdmins();
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const login = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    const cookie = getCookie(login);
    for (const payload of [
      { currentPassword: password, newPassword: "short" }, // < 8 chars
      { currentPassword: password, newPassword: " ".repeat(12) }, // blank pattern
      { currentPassword: password, newPassword: "x".repeat(1025) }, // too long
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/admin/auth/password", headers: { ...adminHeaders, cookie }, payload });
      assert.equal(response.statusCode, 400, `payload: ${JSON.stringify(payload)}: ${response.body}`);
    }
  } finally { await app.close(); }
});

test("disabled admin cannot log in", async () => {
  const { repository, email, password } = await makeAdmins({ disabled: true });
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const response = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    assert.equal(response.statusCode, 403);
  } finally { await app.close(); }
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
  const { repository, email, password } = await makeAdmins();
  const app = buildApp({ queue, adminAuth, authStore: store, admins: repository });
  const replica = buildApp({ queue, adminAuth, authStore: replicaStore, admins: repository });
  try {
    const result = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password } });
    assert.equal(result.statusCode, 200, result.body);
    const cookie = getCookie(result);
    assert.equal((await replica.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 200);
    assert.equal((await replica.inject({ method: "POST", url: "/api/admin/auth/logout", headers: { ...adminHeaders, cookie } })).statusCode, 204);
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie } })).statusCode, 401);
  } finally {
    await app.close();
    await replica.close();
  }
});
