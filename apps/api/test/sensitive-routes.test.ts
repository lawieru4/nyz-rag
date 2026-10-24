/**
 * sensitive-routes.test.ts — 敏感配置路由的权限与凭据出口（不需要数据库/Redis）。
 *
 * 覆盖：
 *  - 仅超级管理员可访问的路由清单（防止新增/修改路由时漏掉标记）
 *  - 普通管理员访问这些路由一律 403，且在请求体校验与数据库访问之前拒绝
 *  - credentialEnv 只能引用 NYZ_MODEL_CREDENTIAL_ENVS 中的环境变量，报错不泄露变量是否存在
 */

import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { AdminCredentials } from "@nyz-rag/processing";
import { adminAuth, adminHeaders, buildTestApp, memoryAdmins, memoryAuthStore } from "./auth-helpers.js";
import { hashPassword } from "../src/passwords.js";

const queue = {
  hasDocumentJob: async () => false, hasSourceJob: async () => false,
  enqueueDocument: async () => {}, enqueueSource: async () => {}, close: async () => {},
};

const PASSWORD = "test-only-password-not-for-deployment";
const UUID = "00000000-0000-4000-8000-000000000001";

const SUPER_ADMIN_ROUTES = [
  "DELETE /api/admin/model-providers/:id",
  "DELETE /api/admin/model-settings/:capability",
  "DELETE /api/admin/settings/article-token",
  "GET /api/admin/admins",
  "GET /api/admin/model-providers/:id/models",
  "PATCH /api/admin/admins/:id",
  "PATCH /api/admin/model-providers/:id",
  "POST /api/admin/admins",
  "POST /api/admin/model-providers",
  "POST /api/admin/model-providers/models",
  "POST /api/admin/sources",
  "PUT /api/admin/model-settings/:capability",
  "PUT /api/admin/settings/article-token",
];

async function account(email: string, isSuper: boolean): Promise<AdminCredentials> {
  const now = new Date().toISOString();
  return { id: randomUUID(), email, nickname: email, passwordHash: await hashPassword(PASSWORD), isSuper, sessionVersion: 0, disabled: false, createdAt: now, updatedAt: now };
}

async function setup() {
  const { repository } = memoryAdmins([await account("super@example.com", true), await account("regular@example.com", false)]);
  const app = buildTestApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: repository });
  const loginAs = async (email: string) => {
    const result = await app.inject({ method: "POST", url: "/api/admin/auth/login", headers: adminHeaders, payload: { username: email, password: PASSWORD } });
    assert.equal(result.statusCode, 200, result.body);
    return { ...adminHeaders, cookie: String(result.headers["set-cookie"]).split(";")[0]! };
  };
  return { app, loginAs };
}

test("super-admin-only routes match the permission matrix", async () => {
  const app = buildTestApp({ queue, adminAuth, authStore: memoryAuthStore(), admins: memoryAdmins().repository });
  const flagged: string[] = [];
  app.addHook("onRoute", (route) => {
    if (!route.config?.superAdminOnly) return;
    // Fastify 为 GET 自动生成的 HEAD 路由沿用同一 config，同样受保护。
    for (const method of [route.method].flat()) if (method !== "HEAD") flagged.push(`${method} ${route.url}`);
  });
  try {
    await app.ready();
    assert.deepEqual(flagged.sort(), SUPER_ADMIN_ROUTES);
  } finally { await app.close(); }
});

test("regular admins are rejected from every sensitive route before validation or database access", async () => {
  const { app, loginAs } = await setup();
  try {
    const headers = await loginAs("regular@example.com");
    for (const route of SUPER_ADMIN_ROUTES) {
      const [method, path] = route.split(" ") as [string, string];
      const url = path.replace(":id", UUID).replace(":capability", "chat");
      // 请求体故意不合法：权限检查必须先于 schema 校验。
      const result = await app.inject({ method: method as "GET", url, headers, ...(["GET", "DELETE"].includes(method) ? {} : { payload: {} }) });
      assert.equal(result.statusCode, 403, `${route}: ${result.body}`);
      assert.deepEqual(result.json(), { error: "仅超级管理员可执行此操作" });
    }
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
