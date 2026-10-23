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
 */

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { buildTestApp as buildApp } from "./auth-helpers.js";
import { adminAuth, adminHeaders, memoryAdmins, memoryAuthStore } from "./auth-helpers.js";
import { hashPassword } from "../src/passwords.js";
import type { AdminCredentials } from "@nyz-rag/processing";

const queue = {
  hasDocumentJob: async () => false, hasSourceJob: async () => false,
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

async function makeAccount(override: Partial<AdminCredentials> = {}): Promise<AdminCredentials> {
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
  const regularAccount: AdminCredentials = {
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
