/**
 * admin-accounts.test.ts — Tests for super-admin-only admin account management.
 *
 * Covers:
 *  - GET /api/admin/admins (super only)
 *  - POST /api/admin/admins (super only, create regular admin)
 *  - PATCH /api/admin/admins/:id (super only, disable/enable)
 *  - Forbid disabling super admin
 *  - Non-super access forbidden
 *  - Duplicate email rejected
 *  - Session version invalidation on disable
 *  - Roles: create/edit/disable/delete, assignment to admins, permissions in the session
 *  - Audit log entries for admin writes and denied access
 */

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { buildTestApp as buildApp } from "./auth-helpers.js";
import { adminAuth, adminHeaders, memoryAdmins, memoryAuthStore } from "./auth-helpers.js";
import { hashPassword } from "../src/passwords.js";
import type { MemoryAdminInput } from "./auth-helpers.js";

const queue = {
  hasDocumentJob: async () => false,
  enqueueDocument: async () => {}, enqueueSource: async () => {}, close: async () => {},
};

const SUPER_EMAIL = "super@example.com";
const REGULAR_EMAIL = "regular@example.com";
const PASSWORD = "test-only-password-not-for-deployment";

test("legacy login alias is restricted to the bootstrap super administrator", async () => {
  const account = await makeAccount({ email: "admin@example.com" });
  const { accounts, repository } = memoryAdmins([account]);
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    await loginAs(app, "admin");
    accounts.get(account.id)!.isSuper = false;
    const denied = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: "admin", password: PASSWORD } });
    assert.equal(denied.statusCode, 401);
  } finally { await app.close(); }
});

async function makeAccount(override: Partial<MemoryAdminInput> = {}): Promise<MemoryAdminInput> {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    email: SUPER_EMAIL,
    nickname: "super",
    passwordHash: await hashPassword(PASSWORD),
    isSuper: true,
    sessionVersion: 0,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    ...override,
  };
}

async function loginAs(app: ReturnType<typeof buildApp>, email: string) {
  const result = await app.inject({
    method: "POST", url: "/api/admin/auth/login", headers: adminHeaders,
    payload: { username: email, password: PASSWORD },
  });
  assert.equal(result.statusCode, 200, `login as ${email}: ${result.body}`);
  return String(result.headers["set-cookie"]).split(";")[0]!;
}

test("GET /api/admin/admins returns list; only accessible by super admin", async () => {
  const superAccount = await makeAccount({ id: randomUUID(), email: SUPER_EMAIL, isSuper: true });
  const regularAccount = await makeAccount({ id: randomUUID(), email: REGULAR_EMAIL, isSuper: false });
  const { repository } = memoryAdmins([superAccount, regularAccount]);
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const cookie = await loginAs(app, SUPER_EMAIL);
    const result = await app.inject({ url: "/api/admin/admins", headers: { cookie } });
    assert.equal(result.statusCode, 200, result.body);
    const list = result.json();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 2);
    // Every record must have required AdminAccount fields
    for (const item of list) {
      assert.equal(typeof item.id, "string");
      assert.equal(typeof item.email, "string");
      assert.equal(typeof item.nickname, "string");
      assert.equal(typeof item.isSuper, "boolean");
      assert.equal(typeof item.disabled, "boolean");
      assert.equal(typeof item.createdAt, "string");
      assert.equal(typeof item.updatedAt, "string");
      // Must NOT contain passwordHash or sessionVersion
      assert.ok(!Object.hasOwn(item, "passwordHash"));
      assert.ok(!Object.hasOwn(item, "sessionVersion"));
    }

    // Regular admin gets 403
    const regularCookie = await loginAs(app, REGULAR_EMAIL);
    const denied = await app.inject({ url: "/api/admin/admins", headers: { cookie: regularCookie } });
    assert.equal(denied.statusCode, 403);
  } finally { await app.close(); }
});

test("POST /api/admin/admins creates a regular admin; duplicate email returns 409", async () => {
  const superAccount = await makeAccount({ id: randomUUID(), email: SUPER_EMAIL, isSuper: true });
  const { repository } = memoryAdmins([superAccount]);
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const cookie = await loginAs(app, SUPER_EMAIL);
    const newEmail = "newadmin@example.com";
    const create = await app.inject({
      method: "POST", url: "/api/admin/admins",
      headers: { ...adminHeaders, cookie },
      payload: { email: newEmail, nickname: "New Admin", password: "secure-password-123" },
    });
    assert.equal(create.statusCode, 201, create.body);
    const account = create.json();
    assert.equal(account.email, newEmail);
    assert.equal(account.isSuper, false);
    assert.equal(account.disabled, false);
    assert.ok(!Object.hasOwn(account, "passwordHash"));

    // Duplicate email
    const dup = await app.inject({
      method: "POST", url: "/api/admin/admins",
      headers: { ...adminHeaders, cookie },
      payload: { email: newEmail, nickname: "Dup", password: "secure-password-123" },
    });
    assert.equal(dup.statusCode, 409);
  } finally { await app.close(); }
});

test("POST /api/admin/admins rejects short password, blank nickname, invalid email", async () => {
  const superAccount = await makeAccount({ id: randomUUID(), email: SUPER_EMAIL, isSuper: true });
  const { repository } = memoryAdmins([superAccount]);
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const cookie = await loginAs(app, SUPER_EMAIL);
    for (const payload of [
      { email: "a@b.com", nickname: "x", password: "short" }, // < 8 chars
      { email: "a@b.com", nickname: "   ", password: "long-enough-password" }, // blank nickname
      { email: "not-an-email", nickname: "x", password: "long-enough-password" }, // bad email
      { email: "a@b.com", nickname: "x" }, // missing password
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/admin/admins", headers: { ...adminHeaders, cookie }, payload });
      assert.equal(response.statusCode, 400, `payload ${JSON.stringify(payload)}: ${response.body}`);
    }
  } finally { await app.close(); }
});

test("PATCH /api/admin/admins/:id can disable and re-enable a regular admin; session version invalidated", async () => {
  const now = new Date().toISOString();
  const regularPw = PASSWORD;
  const superAccount = await makeAccount({ id: randomUUID(), email: SUPER_EMAIL, isSuper: true });
  const regularAccount: MemoryAdminInput = {
    id: randomUUID(), email: REGULAR_EMAIL, nickname: "regular",
    passwordHash: await hashPassword(regularPw),
    isSuper: false, sessionVersion: 0, disabled: false, createdAt: now, updatedAt: now,
  };
  const { repository } = memoryAdmins([superAccount, regularAccount]);
  const store = memoryAuthStore();
  const app = buildApp({ queue, adminAuth, authStore: store, admins: repository });
  try {
    const superCookie = await loginAs(app, SUPER_EMAIL);
    // Regular admin logs in
    const regularCookie = await loginAs(app, REGULAR_EMAIL);
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie: regularCookie } })).statusCode, 200);

    // Disable regular admin
    const disable = await app.inject({
      method: "PATCH", url: `/api/admin/admins/${regularAccount.id}`,
      headers: { ...adminHeaders, cookie: superCookie },
      payload: { disabled: true },
    });
    assert.equal(disable.statusCode, 200, disable.body);
    assert.equal(disable.json().disabled, true);

    // Regular admin's session is now invalid (session version bumped)
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie: regularCookie } })).statusCode, 401);

    // Re-enable
    const enable = await app.inject({
      method: "PATCH", url: `/api/admin/admins/${regularAccount.id}`,
      headers: { ...adminHeaders, cookie: superCookie },
      payload: { disabled: false },
    });
    assert.equal(enable.statusCode, 200, enable.body);
    assert.equal(enable.json().disabled, false);
    assert.equal((await app.inject({ url: "/api/admin/auth/session", headers: { cookie: regularCookie } })).statusCode, 401);
  } finally { await app.close(); }
});

test("PATCH /api/admin/admins/:id forbids disabling the super admin", async () => {
  const superAccount = await makeAccount({ id: randomUUID(), email: SUPER_EMAIL, isSuper: true });
  const { repository } = memoryAdmins([superAccount]);
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const cookie = await loginAs(app, SUPER_EMAIL);
    const disable = await app.inject({
      method: "PATCH", url: `/api/admin/admins/${superAccount.id}`,
      headers: { ...adminHeaders, cookie },
      payload: { disabled: true },
    });
    assert.equal(disable.statusCode, 403);
    assert.match(disable.json().error, /超级管理员/);
  } finally { await app.close(); }
});

test("PATCH /api/admin/admins/:id returns 404 for non-existent admin", async () => {
  const superAccount = await makeAccount({ id: randomUUID(), email: SUPER_EMAIL, isSuper: true });
  const { repository } = memoryAdmins([superAccount]);
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const cookie = await loginAs(app, SUPER_EMAIL);
    const result = await app.inject({
      method: "PATCH", url: `/api/admin/admins/${randomUUID()}`,
      headers: { ...adminHeaders, cookie },
      payload: { disabled: true },
    });
    assert.equal(result.statusCode, 404);
  } finally { await app.close(); }
});

test("regular admin is forbidden from all admin-management routes", async () => {
  const superAccount = await makeAccount({ id: randomUUID(), email: SUPER_EMAIL, isSuper: true });
  const regularAccount = await makeAccount({ id: randomUUID(), email: REGULAR_EMAIL, isSuper: false });
  const { repository } = memoryAdmins([superAccount, regularAccount]);
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const cookie = await loginAs(app, REGULAR_EMAIL);
    assert.equal((await app.inject({ url: "/api/admin/admins", headers: { cookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/admins", headers: { ...adminHeaders, cookie }, payload: { email: "x@y.com", nickname: "x", password: "password123" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/admins/${randomUUID()}`, headers: { ...adminHeaders, cookie }, payload: { disabled: true } })).statusCode, 403);
  } finally { await app.close(); }
});

test("roles: create, edit, disable and delete; assignment drives the admin's permissions", async () => {
  const superAccount = await makeAccount({ id: randomUUID(), email: SUPER_EMAIL, isSuper: true });
  const regularAccount = await makeAccount({ id: randomUUID(), email: REGULAR_EMAIL, isSuper: false });
  const { repository } = memoryAdmins([superAccount, regularAccount]);
  const app = buildApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  try {
    const headers = { ...adminHeaders, cookie: await loginAs(app, SUPER_EMAIL) };
    const regularHeaders = { ...adminHeaders, cookie: await loginAs(app, REGULAR_EMAIL) };
    const session = async () => (await app.inject({ url: "/api/admin/auth/session", headers: regularHeaders })).json();
    assert.deepEqual((await session()).permissions, []);

    // 创建：管理包含查看，名称去空白后不可重复，未知权限被拒绝。
    const created = await app.inject({ method: "POST", url: "/api/admin/roles", headers, payload: { name: " 运营 ", description: "日常运营", permissions: ["documents:manage", "chat-logs:view"] } });
    assert.equal(created.statusCode, 201, created.body);
    const role = created.json();
    assert.equal(role.name, "运营");
    assert.deepEqual(role.permissions, ["documents:view", "documents:manage", "chat-logs:view"]);
    assert.equal(role.adminCount, 0);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/roles", headers, payload: { name: "运营", description: "", permissions: [] } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/roles", headers, payload: { name: "x", description: "", permissions: ["admins:manage"] } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/admin/roles", headers, payload: { name: "  ", description: "", permissions: [] } })).statusCode, 400);

    // 分配角色：会话立即带上权限；超级管理员不能分配角色，角色必须存在。
    const assigned = await app.inject({ method: "PATCH", url: `/api/admin/admins/${regularAccount.id}`, headers, payload: { roleId: role.id } });
    assert.equal(assigned.statusCode, 200, assigned.body);
    assert.equal(assigned.json().roleName, "运营");
    assert.deepEqual((await session()).permissions, role.permissions);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/admins/${superAccount.id}`, headers, payload: { roleId: role.id } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/admins/${regularAccount.id}`, headers, payload: { roleId: randomUUID() } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/admins/${regularAccount.id}`, headers, payload: {} })).statusCode, 400);
    const withRole = await app.inject({ method: "POST", url: "/api/admin/admins", headers, payload: { email: "ops@example.com", nickname: "ops", password: "password123", roleId: role.id } });
    assert.equal(withRole.statusCode, 201, withRole.body);
    assert.equal(withRole.json().roleId, role.id);

    // 编辑与停用：权限随之变化，会话不失效。
    const edited = await app.inject({ method: "PATCH", url: `/api/admin/roles/${role.id}`, headers, payload: { permissions: ["users:view"] } });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().adminCount, 2);
    assert.deepEqual((await session()).permissions, ["users:view"]);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/roles/${role.id}`, headers, payload: { disabled: true } })).json().disabled, true);
    assert.deepEqual((await session()).permissions, []);
    assert.equal((await app.inject({ url: "/api/admin/users", headers: regularHeaders })).statusCode, 403);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/roles/${role.id}`, headers, payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/roles/${randomUUID()}`, headers, payload: { disabled: false } })).statusCode, 404);

    // 删除：有管理员使用时 409，解除后 204。
    const inUse = await app.inject({ method: "DELETE", url: `/api/admin/roles/${role.id}`, headers });
    assert.equal(inUse.statusCode, 409);
    assert.match(inUse.json().error, /更换角色/);
    for (const admin of (await app.inject({ url: "/api/admin/admins", headers })).json()) {
      if (admin.roleId) assert.equal((await app.inject({ method: "PATCH", url: `/api/admin/admins/${admin.id}`, headers, payload: { roleId: null } })).statusCode, 200);
    }
    assert.equal((await app.inject({ method: "DELETE", url: `/api/admin/roles/${role.id}`, headers })).statusCode, 204);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/admin/roles/${role.id}`, headers })).statusCode, 404);
    assert.deepEqual((await app.inject({ url: "/api/admin/roles", headers })).json(), []);
  } finally { await app.close(); }
});

test("audit log records admin writes and denied access without request bodies", async () => {
  const superAccount = await makeAccount({ id: randomUUID(), email: SUPER_EMAIL, isSuper: true });
  const regularAccount = await makeAccount({ id: randomUUID(), email: REGULAR_EMAIL, isSuper: false });
  const { audits, repository } = memoryAdmins([superAccount, regularAccount]);
  const lines: string[] = [];
  const app = buildApp({
    queue, adminAuth, authStore: memoryAuthStore(), admins: repository,
    logger: { level: "info", stream: { write: (line: string) => { lines.push(line); } } },
  });
  try {
    const failed = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: SUPER_EMAIL, password: "wrong-password-value" } });
    assert.equal(failed.statusCode, 401);
    const headers = { ...adminHeaders, cookie: await loginAs(app, SUPER_EMAIL) };
    const regularCookie = await loginAs(app, REGULAR_EMAIL);
    const created = await app.inject({ method: "POST", url: "/api/admin/roles", headers, payload: { name: "审计", description: "", permissions: [] } });
    const roleId = created.json().id as string;
    await app.inject({ method: "PATCH", url: `/api/admin/roles/${roleId}`, headers, payload: { disabled: true } });
    await app.inject({ url: "/api/admin/roles", headers });
    await app.inject({ url: "/api/admin/roles", headers: { cookie: regularCookie } });
    // 未登录的写请求只写进程日志，不入库（防止匿名刷库）。
    await app.inject({ method: "POST", url: "/api/admin/roles", headers: adminHeaders, payload: { name: "x", description: "", permissions: [] } });

    const pick = ({ adminId, method, route, resourceId, statusCode, result }: (typeof audits)[number]) => ({ adminId, method, route, resourceId, statusCode, result });
    assert.deepEqual(audits.map(pick), [
      { adminId: null, method: "POST", route: "/api/admin/auth/login", resourceId: null, statusCode: 401, result: "denied" },
      { adminId: superAccount.id, method: "POST", route: "/api/admin/auth/login", resourceId: null, statusCode: 200, result: "success" },
      { adminId: regularAccount.id, method: "POST", route: "/api/admin/auth/login", resourceId: null, statusCode: 200, result: "success" },
      { adminId: superAccount.id, method: "POST", route: "/api/admin/roles", resourceId: null, statusCode: 201, result: "success" },
      { adminId: superAccount.id, method: "PATCH", route: "/api/admin/roles/:id", resourceId: roleId, statusCode: 200, result: "success" },
      // 成功的读取不记，被拒绝的读取要记。
      { adminId: regularAccount.id, method: "GET", route: "/api/admin/roles", resourceId: null, statusCode: 403, result: "denied" },
    ]);
    assert.ok(audits.every((entry) => entry.requestId && entry.ip));
    const logged = lines.map((line) => JSON.parse(line)).filter((entry) => entry.audit);
    assert.equal(logged.length, audits.length + 1);
    assert.ok(logged.every((entry) => entry.audit.requestId === entry.reqId));
    assert.doesNotMatch(lines.join("\n"), /wrong-password-value|test-only-password/);

    // 查看需「操作日志 · 查看」权限；按时间倒序，可按结果与关键词筛选。
    const regularHeaders = { ...adminHeaders, cookie: regularCookie };
    assert.equal((await app.inject({ url: "/api/admin/audit-logs", headers: regularHeaders })).statusCode, 403);
    const auditor = await app.inject({ method: "POST", url: "/api/admin/roles", headers, payload: { name: "审计员", description: "", permissions: ["audit-logs:view"] } });
    await app.inject({ method: "PATCH", url: `/api/admin/admins/${regularAccount.id}`, headers, payload: { roleId: auditor.json().id } });
    const list = await app.inject({ url: "/api/admin/audit-logs?pageSize=2", headers: regularHeaders });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().total, audits.length);
    assert.deepEqual(list.json().logs.map((log: { route: string }) => log.route), ["/api/admin/admins/:id", "/api/admin/roles"]);
    assert.equal(list.json().logs[0].adminNickname, "super");
    const denied = (await app.inject({ url: "/api/admin/audit-logs?result=denied&query=regular@", headers: regularHeaders })).json();
    assert.deepEqual(denied.logs.map((log: { route: string }) => log.route), ["/api/admin/audit-logs", "/api/admin/roles"]);
    assert.equal((await app.inject({ url: "/api/admin/audit-logs?result=bad", headers: regularHeaders })).statusCode, 400);
  } finally { await app.close(); }
});
