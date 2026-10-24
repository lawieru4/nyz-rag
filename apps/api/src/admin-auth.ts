import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AdminLoginRequest, AdminPermission, AdminSession, AdminAccount, ChangeAdminPasswordRequest, UpdateAdminProfileRequest } from "@nyz-rag/types";
import {
  getAdminCredentials, updateAdminPassword, updateAdminProfile, createAdminAccount, listAdminAccounts, updateAdminAccount,
  listAdminRoles, createAdminRole, updateAdminRole, deleteAdminRole, recordAdminAudit, listAdminAuditLogs,
  type AdminAuditInput, type AdminCredentials,
} from "@nyz-rag/processing";
import { cookieToken, createAuthStore, digest, type AuthStore } from "./auth-store.js";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./passwords.js";

/**
 * 管理路由的访问级别，每条 /api/admin/* 路由必须声明（未声明的在注册时报错）：
 * public 无需登录（仅登录接口）；session 任何已登录管理员；super 仅超级管理员；
 * 权限码（或数组，满足其一即可）由角色授予，超级管理员拥有全部权限。
 */
export type AdminAccess = "public" | "session" | "super" | AdminPermission | AdminPermission[];

declare module "fastify" {
  interface FastifyContextConfig {
    /** 由 configureAdminAuth 的 onRequest 钩子统一检查。 */
    adminAccess?: AdminAccess;
  }
}

/** 路由选项：仅超级管理员可访问（管理员账号与角色）。 */
export const superAdminOnly = { config: { adminAccess: "super" as AdminAccess } };
/** 路由选项：任何已登录管理员可访问（当前账号的自助操作）。 */
export const signedIn = { config: { adminAccess: "session" as AdminAccess } };
/** 路由选项：需具备其中任一权限。 */
export const requires = (...permissions: AdminPermission[]) => ({ config: { adminAccess: permissions as AdminAccess } });

function accessAllowed(access: AdminAccess | undefined, admin: AdminCredentials): boolean {
  if (!access || access === "public") return false;
  if (access === "session" || admin.isSuper) return true;
  return access !== "super" && [access].flat().some((permission) => admin.permissions.includes(permission));
}

const toAdminAccount = (admin: AdminCredentials): AdminAccount => ({
  id: admin.id, email: admin.email, nickname: admin.nickname, isSuper: admin.isSuper, disabled: admin.disabled,
  roleId: admin.roleId, roleName: admin.roleName, createdAt: admin.createdAt, updatedAt: admin.updatedAt,
});

const COOKIE = "nyz_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;

export interface AdminAuthConfig {
  /** Legacy login alias for the initial super administrator. */
  legacyUsername: string;
  bootstrapEmail?: string;
  origins: string[];
  secureCookie: boolean;
}

export type AdminAuthStore = AuthStore;

export interface AdminRepository {
  getAdminCredentials(by: { id: string } | { email: string }): Promise<AdminCredentials | null>;
  updateAdminPassword(id: string, passwordHash: string): Promise<number | null>;
  updateAdminProfile(id: string, input: { email: string; nickname: string }): Promise<AdminAccount | null>;
  createAdminAccount: typeof createAdminAccount;
  listAdminAccounts: typeof listAdminAccounts;
  updateAdminAccount: typeof updateAdminAccount;
  listAdminRoles: typeof listAdminRoles;
  createAdminRole: typeof createAdminRole;
  updateAdminRole: typeof updateAdminRole;
  deleteAdminRole: typeof deleteAdminRole;
  recordAdminAudit(entry: AdminAuditInput): Promise<void>;
  listAdminAuditLogs(filter: Parameters<typeof listAdminAuditLogs>[0]): ReturnType<typeof listAdminAuditLogs>;
}

export const databaseAdmins: AdminRepository = {
  getAdminCredentials: (by) => getAdminCredentials(by),
  updateAdminPassword: (id, hash) => updateAdminPassword(id, hash),
  updateAdminProfile: (id, input) => updateAdminProfile(id, input),
  createAdminAccount,
  listAdminAccounts,
  updateAdminAccount,
  listAdminRoles: () => listAdminRoles(),
  createAdminRole: (input) => createAdminRole(input),
  updateAdminRole: (id, input) => updateAdminRole(id, input),
  deleteAdminRole: (id) => deleteAdminRole(id),
  recordAdminAudit: (entry) => recordAdminAudit(entry),
  listAdminAuditLogs: (filter) => listAdminAuditLogs(filter),
};

export function adminAuthConfig(): AdminAuthConfig {
  const origins = (process.env.ADMIN_ORIGINS ?? `http://localhost:${process.env.ADMIN_PORT ?? "5176"},http://127.0.0.1:${process.env.ADMIN_PORT ?? "5176"}`)
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("ADMIN_ORIGINS must contain exact http(s) origins without paths");
    }
  }
  // Legacy env username alias (kept for deployments that predate DB-persisted admins).
  const legacyUsername = process.env.ADMIN_USERNAME ?? "admin";
  if (!legacyUsername.trim() || legacyUsername.length > 128) {
    throw new Error("ADMIN_USERNAME must contain 1 to 128 characters and cannot be blank");
  }
  // ADMIN_PASSWORD is still validated if set — it seeds the initial super admin.
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (password && (password.length < 16 || password.length > 1024)) {
    throw new Error("ADMIN_PASSWORD must contain 16 to 1024 characters");
  }
  const secure = process.env.ADMIN_COOKIE_SECURE;
  if (secure !== undefined && secure !== "true" && secure !== "false") {
    throw new Error("ADMIN_COOKIE_SECURE must be true or false");
  }
  return {
    legacyUsername,
    bootstrapEmail: (process.env.ADMIN_EMAIL ?? "admin@example.com").trim().toLowerCase(),
    origins,
    secureCookie: secure === undefined ? process.env.NODE_ENV === "production" : secure === "true",
  };
}

export const createAdminAuthStore = (): AuthStore => createAuthStore("admin-auth");

const sessionToken = (request: FastifyRequest) => cookieToken(request, COOKIE);

/** 存储在 Redis 中的会话结构。 */
interface StoredAdminSession {
  adminId: string;
  version: number;
  expiresAt: string;
}

const sessions = new WeakMap<FastifyRequest, AdminSession>();

export function configureAdminAuth(
  app: FastifyInstance,
  config: AdminAuthConfig,
  store: AdminAuthStore,
  admins: AdminRepository,
  now = Date.now,
): void {
  const sessionKey = (token: string) => `admin-session:${digest(token)}`;
  const cookie = (token: string, maxAge: number) =>
    `${COOKIE}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookie ? "; Secure" : ""}`;

  app.addHook("onClose", async () => store.close());

  // 默认拒绝：管理路由漏写访问级别时启动失败，而不是对所有已登录管理员开放。
  app.addHook("onRoute", (route) => {
    if (route.url.startsWith("/api/admin/") && !route.config?.adminAccess) {
      throw new Error(`Admin route ${[route.method].flat().join(",")} ${route.url} must declare config.adminAccess`);
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.routeOptions.url ?? "";
    if (!path.startsWith("/api/admin/") || request.method === "OPTIONS") return;
    const access = request.routeOptions.config.adminAccess;
    reply.header("Cache-Control", "no-store");
    if (request.headers.origin && !config.origins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: "不允许的管理端来源" });
    }
    if (!["GET", "HEAD"].includes(request.method) && request.headers["x-nyz-admin"] !== "1") {
      return reply.code(403).send({ error: "缺少管理请求校验头" });
    }
    try {
      if (access === "public") {
        if (path !== "/api/admin/auth/login") return;
        const ipAttempts = await store.increment(`login:ip:${digest(request.ip)}`, LOGIN_WINDOW_SECONDS);
        if (ipAttempts > 10) {
          return reply.header("Retry-After", LOGIN_WINDOW_SECONDS).code(429).send({ error: "登录尝试过于频繁，请稍后重试" });
        }
        const totalAttempts = await store.increment("login:global", LOGIN_WINDOW_SECONDS);
        if (totalAttempts > 100) {
          return reply.header("Retry-After", LOGIN_WINDOW_SECONDS).code(429).send({ error: "登录尝试过于频繁，请稍后重试" });
        }
        return;
      }
      const token = sessionToken(request);
      const value = token ? await store.get(sessionKey(token)) : null;
      const stored: StoredAdminSession | null = value ? JSON.parse(value) : null;
      if (!stored || !(Date.parse(stored.expiresAt) > now())) {
        return reply.header("Set-Cookie", cookie("", 0)).code(401).send({ error: "请先登录管理员账号" });
      }
      // 每次请求校验账号状态与会话版本，防止停用或密码修改后会话继续有效。
      let admin: AdminCredentials | null;
      try { admin = await admins.getAdminCredentials({ id: stored.adminId }); }
      catch { return reply.code(503).send({ error: "认证服务暂不可用，请稍后重试" }); }
      if (!admin || admin.disabled || admin.sessionVersion !== stored.version) {
        return reply.header("Set-Cookie", cookie("", 0)).code(401).send({ error: "请先登录管理员账号" });
      }
      const session: AdminSession = { username: admin.email, expiresAt: stored.expiresAt, admin: toAdminAccount(admin), permissions: admin.permissions };
      sessions.set(request, session);
      // 角色与权限每次请求重新读取，修改角色后立即生效。
      if (!accessAllowed(access, admin)) {
        return reply.code(403).send({ error: access === "super" ? "仅超级管理员可执行此操作" : "当前角色没有执行此操作的权限" });
      }
    } catch {
      return reply.code(503).send({ error: "认证服务暂不可用，请稍后重试" });
    }
  });

  // 审计：管理端的写操作（含登录、退出）和被拒绝（403）的访问各记一条，只记操作者、动作、资源与结果，
  // 不记请求体、密钥或上游错误正文。全部写入进程日志；入库的只有已登录管理员的操作与登录尝试（受登录限流约束），
  // 其余匿名请求不入库，避免被刷库。写库失败只记日志，不影响已发出的响应。
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "";
    if (!route.startsWith("/api/admin/") || request.method === "OPTIONS") return;
    const status = reply.statusCode;
    if (["GET", "HEAD"].includes(request.method) && status !== 403) return;
    const params = (request.params ?? {}) as { id?: string; capability?: string };
    const audit: AdminAuditInput = {
      adminId: sessions.get(request)?.admin.id ?? null,
      method: request.method,
      route,
      resourceId: params.id ?? params.capability ?? null,
      statusCode: status,
      result: status < 400 ? "success" : status === 401 || status === 403 ? "denied" : "failed",
      requestId: request.id,
      ip: request.ip,
    };
    request.log.info({ audit }, "admin audit");
    if (audit.adminId === null && !(route === "/api/admin/auth/login" && status !== 429)) return;
    try { await admins.recordAdminAudit(audit); }
    catch (error) { request.log.error(error, "Failed to record admin audit log"); }
  });

  /**
   * 登录：用户名字段同时接受 email 和 ADMIN_USERNAME 别名（向后兼容旧部署）。
   * 旧别名仅映射到初始化邮箱的超级管理员，不能映射到普通管理员。
   */
  app.post<{ Body: AdminLoginRequest }>("/api/admin/auth/login", { config: { adminAccess: "public" } }, async (request, reply) => {
    const { username, password } = request.body;
    let admin: AdminCredentials | null = null;
    try {
      // 先按 email 查（规范形式）；如果输入恰好等于 legacyUsername（旧 env 别名），再按 legacyUsername 对应的邮箱查。
      admin = await admins.getAdminCredentials({ email: username.trim().toLowerCase() });
      if (!admin && username.trim() === config.legacyUsername) {
        const initial = await admins.getAdminCredentials({ email: config.bootstrapEmail ?? "admin@example.com" });
        if (initial?.isSuper) admin = initial;
      }
    } catch {
      return reply.code(503).send({ error: "认证服务暂不可用，请稍后重试" });
    }
    const hash = admin?.passwordHash ?? await dummyPasswordHash();
    const valid = await verifyPassword(password, hash);
    if (!admin || !valid) return reply.code(401).send({ error: "账号或密码错误" });
    if (admin.disabled) return reply.code(403).send({ error: "账号已停用，请联系超级管理员" });

    const token = randomBytes(32).toString("hex");
    const stored: StoredAdminSession = {
      adminId: admin.id,
      version: admin.sessionVersion,
      expiresAt: new Date(now() + SESSION_SECONDS * 1000).toISOString(),
    };
    try {
      const previous = sessionToken(request);
      if (previous) await store.delete(sessionKey(previous));
      await store.set(sessionKey(token), JSON.stringify(stored), SESSION_SECONDS);
    } catch {
      return reply.code(503).send({ error: "认证服务暂不可用，请稍后重试" });
    }
    const session: AdminSession = { username: admin.email, expiresAt: stored.expiresAt, admin: toAdminAccount(admin), permissions: admin.permissions };
    sessions.set(request, session);
    return reply.header("Set-Cookie", cookie(token, SESSION_SECONDS)).send(session);
  });

  app.get("/api/admin/auth/session", signedIn, async (request) => sessions.get(request)!);

  app.post("/api/admin/auth/logout", signedIn, async (request, reply) => {
    try {
      const token = sessionToken(request);
      if (token) await store.delete(sessionKey(token));
    } catch {
      return reply.code(503).send({ error: "退出失败，请稍后重试" });
    }
    return reply.header("Set-Cookie", cookie("", 0)).code(204).send();
  });

  // ---- 当前管理员自助操作 ----

  app.patch<{ Body: UpdateAdminProfileRequest }>("/api/admin/auth/profile", signedIn, async (request, reply) => {
    const session = sessions.get(request)!;
    const email = request.body.email.trim().toLowerCase();
    const nickname = request.body.nickname.trim();
    if (!email || !nickname) return reply.code(400).send({ error: "邮箱与昵称不能为空" });
    let updated: AdminAccount | null;
    try {
      updated = await admins.updateAdminProfile(session.admin.id, { email, nickname });
    } catch {
      return reply.code(503).send({ error: "服务暂不可用，请稍后重试" });
    }
    if (!updated) return reply.code(409).send({ error: "邮箱已被其他账号使用" });
    const newSession: AdminSession = { ...session, username: updated.email, admin: updated };
    return newSession;
  });

  app.post<{ Body: ChangeAdminPasswordRequest }>("/api/admin/auth/password", signedIn, async (request, reply) => {
    const session = sessions.get(request)!;
    let current: AdminCredentials | null;
    try { current = await admins.getAdminCredentials({ id: session.admin.id }); }
    catch { return reply.code(503).send({ error: "服务暂不可用，请稍后重试" }); }
    if (!current) return reply.code(401).send({ error: "账号不存在" });
    if (!await verifyPassword(request.body.currentPassword, current.passwordHash)) {
      return reply.code(400).send({ error: "当前密码错误" });
    }
    const newHash = await hashPassword(request.body.newPassword);
    try { await admins.updateAdminPassword(current.id, newHash); }
    catch { return reply.code(503).send({ error: "服务暂不可用，请稍后重试" }); }
    // 使所有已签发会话失效（包括当前会话），要求重新登录。
    const token = sessionToken(request);
    if (token) {
      try { await store.delete(sessionKey(token)); } catch { /* non-critical */ }
    }
    return reply.header("Set-Cookie", cookie("", 0)).code(204).send();
  });
}

/** 从请求对象取出当前管理员会话（仅在认证路由后可用）。 */
export function getAdminSession(request: FastifyRequest): AdminSession | undefined {
  return sessions.get(request);
}
