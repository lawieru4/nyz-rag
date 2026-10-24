/**
 * admin-access.test.ts — 管理路由的访问矩阵与凭据出口（不需要数据库/Redis）。
 *
 * 覆盖：
 *  - 每条 /api/admin/* 路由声明的访问级别与下方矩阵一致（新增路由必须在此登记）；漏写声明的路由启动失败
 *  - 无角色、每个单项权限、角色停用、超级管理员各自能访问的路由，且拒绝发生在请求体校验与数据库访问之前
 *  - credentialEnv 只能引用 NYZ_MODEL_CREDENTIAL_ENVS 中的环境变量，报错不泄露变量是否存在
 */

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ADMIN_PERMISSIONS, normalizeAdminPermissions } from "@nyz-rag/processing";
import type { AdminPermission } from "@nyz-rag/types";
import type { AdminAccess } from "../src/admin-auth.js";
import { adminAuth, adminHeaders, buildTestApp, memoryAdmins, memoryAuthStore, type MemoryAdminInput } from "./auth-helpers.js";
import { hashPassword } from "../src/passwords.js";

const queue = {
  hasDocumentJob: async () => false, hasSourceJob: async () => false,
  enqueueDocument: async () => {}, enqueueSource: async () => {}, close: async () => {},
};

const PASSWORD = "test-only-password-not-for-deployment";
const UUID = "00000000-0000-4000-8000-000000000001";
const PASSED = 299;

const ROUTE_ACCESS: Record<string, AdminAccess> = {
  "POST /api/admin/auth/login": "public",
  "GET /api/admin/auth/session": "session",
  "POST /api/admin/auth/logout": "session",
  "PATCH /api/admin/auth/profile": "session",
  "POST /api/admin/auth/password": "session",

  "GET /api/admin/admins": "super",
  "POST /api/admin/admins": "super",
  "PATCH /api/admin/admins/:id": "super",
  "GET /api/admin/roles": "super",
  "POST /api/admin/roles": "super",
  "PATCH /api/admin/roles/:id": "super",
  "DELETE /api/admin/roles/:id": "super",

  "GET /api/admin/knowledge": ["sources:view", "documents:view"],
  "GET /api/admin/knowledge/events": ["sources:view", "documents:view"],
  "GET /api/admin/settings/article-token": "sources:view",
  "PUT /api/admin/settings/article-token": "sources:manage",
  "DELETE /api/admin/settings/article-token": "sources:manage",
  "POST /api/admin/sources": "sources:manage",
  "PATCH /api/admin/sources/:id": "sources:manage",
  "POST /api/admin/sources/:id/sync": "sources:manage",

  "GET /api/admin/documents": "documents:view",
  "GET /api/admin/documents/:id": "documents:view",
  "POST /api/admin/documents/:id/reprocess": "documents:manage",
  "POST /api/admin/documents/:id/embed": "documents:manage",
  "DELETE /api/admin/documents/:id": "documents:manage",

  "GET /api/admin/knowledge-bases": "knowledge-bases:view",
  "POST /api/admin/knowledge-bases": "knowledge-bases:manage",
  "PATCH /api/admin/knowledge-bases/:id": "knowledge-bases:manage",

  "GET /api/admin/chat-logs": "chat-logs:view",
  "GET /api/admin/audit-logs": "audit-logs:view",

  "GET /api/admin/users": "users:view",
  "PATCH /api/admin/users/:id": "users:manage",

  "GET /api/admin/model-providers": "models:view",
  "GET /api/admin/model-settings": "models:view",
  "POST /api/admin/model-providers": "models:manage",
  "PATCH /api/admin/model-providers/:id": "models:manage",
  "DELETE /api/admin/model-providers/:id": "models:manage",
  "POST /api/admin/model-providers/models": "models:manage",
  "GET /api/admin/model-providers/:id/models": "models:manage",
  "PUT /api/admin/model-settings/:capability": "models:manage",
  "DELETE /api/admin/model-settings/:capability": "models:manage",
};

const normalizeAccess = (access: AdminAccess | undefined) => [access ?? []].flat().sort();

async function account(email: string, isSuper: boolean): Promise<MemoryAdminInput> {
  const now = new Date().toISOString();
  return { id: randomUUID(), email, nickname: email, passwordHash: await hashPassword(PASSWORD), isSuper, sessionVersion: 0, disabled: false, createdAt: now, updatedAt: now };
}

async function setup() {
  const admins = memoryAdmins([await account("super@example.com", true), await account("regular@example.com", false)]);
  const app = buildTestApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: admins.repository });
  const loginAs = async (email: string) => {
    const result = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password: PASSWORD } });
    assert.equal(result.statusCode, 200, result.body);
    return { ...adminHeaders, cookie: String(result.headers["set-cookie"]).split(";")[0]! };
  };
  return { app, loginAs, ...admins };
}

test("every admin route declares the access level in the matrix", async () => {
  const app = buildTestApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: memoryAdmins().repository });
  const declared: Record<string, string[]> = {};
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/admin/")) return;
    // Fastify 为 GET 自动生成的 HEAD 路由沿用同一 config。
    for (const method of [route.method].flat()) if (method !== "HEAD") declared[`${method} ${route.url}`] = normalizeAccess(route.config?.adminAccess);
  });
  try {
    await app.ready();
    assert.deepEqual(declared, Object.fromEntries(Object.entries(ROUTE_ACCESS).map(([key, access]) => [key, normalizeAccess(access)])));
  } finally { await app.close(); }
});

test("admin routes without an access declaration fail at startup", async () => {
  const app = buildTestApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: memoryAdmins().repository });
  app.register(async (instance) => { instance.get("/api/admin/undeclared", async () => ({})); });
  try {
    await assert.rejects(app.ready(), /GET \/api\/admin\/undeclared must declare config\.adminAccess/);
  } finally { await app.close(); }
});

test("role permissions decide access before validation and take effect immediately", async () => {
  const { app, loginAs, repository, accounts } = await setup();
  // 通过鉴权的请求在校验与处理之前截停，不访问数据库。
  app.addHook("preValidation", async (request, reply) => {
    if (request.routeOptions.config.adminAccess !== "public") return reply.code(PASSED).send({ error: "passed" });
  });
  const regular = [...accounts.values()].find((item) => !item.isSuper)!;
  const check = async (headers: Record<string, string>, label: string, allowed: (access: AdminAccess) => boolean) => {
    for (const [route, access] of Object.entries(ROUTE_ACCESS)) {
      if (access === "public") continue;
      const [method, path] = route.split(" ") as [string, string];
      const url = path.replace(":id", UUID).replace(":capability", "chat");
      const result = await app.inject({ method: method as "GET", url, headers, ...(["GET", "DELETE"].includes(method) ? {} : { payload: {} }) });
      assert.equal(result.statusCode, allowed(access) ? PASSED : 403, `${label} → ${route}: ${result.body}`);
      if (result.statusCode === 403) {
        assert.deepEqual(result.json(), { error: access === "super" ? "仅超级管理员可执行此操作" : "当前角色没有执行此操作的权限" });
      }
    }
  };
  const grants = (permissions: AdminPermission[]) => (access: AdminAccess) =>
    access === "session" || (access !== "super" && [access].flat().some((permission) => permissions.includes(permission as AdminPermission)));
  try {
    const regularHeaders = await loginAs("regular@example.com");
    await check(regularHeaders, "no role", grants([]));

    const role = await repository.createAdminRole({ name: "测试", description: "", permissions: [] });
    await repository.updateAdminAccount(regular.id, { roleId: role.id });
    for (const permission of ADMIN_PERMISSIONS) {
      await repository.updateAdminRole(role.id, { permissions: [permission] });
      await check(regularHeaders, permission, grants(normalizeAdminPermissions([permission])));
    }

    await repository.updateAdminRole(role.id, { permissions: [...ADMIN_PERMISSIONS], disabled: true });
    await check(regularHeaders, "disabled role", grants([]));

    await check(await loginAs("super@example.com"), "super admin", () => true);
  } finally { await app.close(); }
});

test("credentialEnv must be allow-listed and the error does not reveal whether the variable exists", async (context) => {
  const previous = process.env.NYZ_MODEL_CREDENTIAL_ENVS;
  context.after(() => {
    if (previous === undefined) delete process.env.NYZ_MODEL_CREDENTIAL_ENVS;
    else process.env.NYZ_MODEL_CREDENTIAL_ENVS = previous;
  });
  process.env.NYZ_MODEL_CREDENTIAL_ENVS = "OPENAI_API_KEY";
  const { app, loginAs } = await setup();
  try {
    const headers = await loginAs("super@example.com");
    const endpoint = { provider: "openai", baseUrl: "https://attacker.example/v1" };
    for (const credentialEnv of ["NYZ_SECRET_KEY", "PATH", "DEFINITELY_NOT_SET_ANYWHERE"]) {
      const listed = await app.inject({ method: "POST", url: "/api/admin/model-providers/models", headers, payload: { ...endpoint, credentialEnv } });
      assert.equal(listed.statusCode, 400, listed.body);
      assert.equal(listed.json().error, `环境变量 ${credentialEnv} 不在 NYZ_MODEL_CREDENTIAL_ENVS 允许列表中`);
      const created = await app.inject({ method: "POST", url: "/api/admin/model-providers", headers, payload: { name: "x", ...endpoint, credentialEnv, enabled: true } });
      assert.equal(created.statusCode, 400, created.body);
      assert.equal(created.json().error, `环境变量 ${credentialEnv} 不在 NYZ_MODEL_CREDENTIAL_ENVS 允许列表中`);
    }
  } finally { await app.close(); }
});
