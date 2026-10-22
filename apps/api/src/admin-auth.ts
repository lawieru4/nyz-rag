import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import type { AdminLoginRequest, AdminSession } from "@nyz-rag/types";

const COOKIE = "nyz_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface AdminAuthConfig {
  username: string;
  password: string;
  origins: string[];
  secureCookie: boolean;
}

export interface AdminAuthStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  close(): Promise<void>;
}

export function adminAuthConfig(): AdminAuthConfig {
  const origins = (process.env.ADMIN_ORIGINS ?? `http://localhost:${process.env.ADMIN_PORT ?? "5176"},http://127.0.0.1:${process.env.ADMIN_PORT ?? "5176"}`)
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("ADMIN_ORIGINS must contain exact http(s) origins without paths");
    }
  }
  const password = process.env.ADMIN_PASSWORD ?? "";
  const username = process.env.ADMIN_USERNAME ?? "admin";
  if (!username.trim() || username.length > 128) {
    throw new Error("ADMIN_USERNAME must contain 1 to 128 characters and cannot be blank");
  }
  if (password && (password.length < 16 || password.length > 1024)) {
    throw new Error("ADMIN_PASSWORD must contain 16 to 1024 characters");
  }
  const secure = process.env.ADMIN_COOKIE_SECURE;
  if (secure !== undefined && secure !== "true" && secure !== "false") {
    throw new Error("ADMIN_COOKIE_SECURE must be true or false");
  }
  return {
    username,
    password,
    origins,
    secureCookie: secure === undefined ? process.env.NODE_ENV === "production" : secure === "true",
  };
}

export function createAdminAuthStore(): AdminAuthStore {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000,
  });
  // Requests receive a sanitized 503; never print connection URLs or credentials.
  redis.on("error", () => {});
  const prefix = `${process.env.DOCUMENT_QUEUE_NAME ?? "nyz-rag-document-processing"}:admin-auth:`;
  return {
    get: (key) => redis.get(prefix + key),
    async set(key, value, ttl) { await redis.set(prefix + key, value, "EX", ttl); },
    async delete(key) { await redis.del(prefix + key); },
    async increment(key, ttl) {
      // INCR + expiry must be atomic across API replicas, including their first request.
      return Number(await redis.eval(
        "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n",
        1, prefix + key, ttl,
      ));
    },
    async close() { redis.disconnect(); },
  };
}

function sessionToken(request: FastifyRequest): string | undefined {
  const values = (request.headers.cookie ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return undefined;
  const token = values[0]!.slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

export function configureAdminAuth(app: FastifyInstance, config: AdminAuthConfig, store: AdminAuthStore, now = Date.now): void {
  const credentialVersion = digest(JSON.stringify([config.username, config.password]));
  const sessionKey = (token: string) => `session:${credentialVersion}:${digest(token)}`;
  const cookie = (token: string, maxAge: number) => `${COOKIE}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookie ? "; Secure" : ""}`;
  const sessions = new WeakMap<FastifyRequest, AdminSession>();
  app.addHook("onClose", async () => store.close());

  app.addHook("onRequest", async (request, reply) => {
    const path = request.routeOptions.url ?? "";
    if (!path.startsWith("/api/admin/") || request.method === "OPTIONS") return;
    reply.header("Cache-Control", "no-store");
    if (request.headers.origin && !config.origins.includes(request.headers.origin)) {
      return reply.code(403).send({ error: "不允许的管理端来源" });
    }
    // A required non-simple header prevents CSRF even from same-site sibling origins.
    if (!["GET", "HEAD"].includes(request.method) && request.headers["x-nyz-admin"] !== "1") {
      return reply.code(403).send({ error: "缺少管理请求校验头" });
    }
    if (!config.password || !config.username) {
      return reply.code(503).send({ error: "管理员认证尚未配置" });
    }
    try {
      if (path === "/api/admin/auth/login" && request.method === "POST") {
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
      const session: AdminSession | null = value ? JSON.parse(value) : null;
      if (!session || session.username !== config.username || !(Date.parse(session.expiresAt) > now())) {
        return reply.header("Set-Cookie", cookie("", 0)).code(401).send({ error: "请先登录管理员账号" });
      }
      sessions.set(request, session);
    } catch {
      return reply.code(503).send({ error: "认证服务暂不可用，请稍后重试" });
    }
  });

  app.post<{ Body: AdminLoginRequest }>("/api/admin/auth/login", async (request, reply) => {
    const usernameMatches = timingSafeEqual(Buffer.from(digest(request.body.username)), Buffer.from(digest(config.username)));
    const passwordMatches = timingSafeEqual(Buffer.from(digest(request.body.password)), Buffer.from(digest(config.password)));
    if (!usernameMatches || !passwordMatches) return reply.code(401).send({ error: "账号或密码错误" });
    const token = randomBytes(32).toString("hex");
    const session: AdminSession = { username: config.username, expiresAt: new Date(now() + SESSION_SECONDS * 1000).toISOString() };
    try {
      const previous = sessionToken(request);
      if (previous) await store.delete(sessionKey(previous));
      await store.set(sessionKey(token), JSON.stringify(session), SESSION_SECONDS);
    } catch {
      return reply.code(503).send({ error: "认证服务暂不可用，请稍后重试" });
    }
    return reply.header("Set-Cookie", cookie(token, SESSION_SECONDS)).send(session);
  });
  app.get("/api/admin/auth/session", async (request) => sessions.get(request)!);
  app.post("/api/admin/auth/logout", async (request, reply) => {
    try {
      await store.delete(sessionKey(sessionToken(request)!));
    } catch {
      return reply.code(503).send({ error: "退出失败，请稍后重试" });
    }
    return reply.header("Set-Cookie", cookie("", 0)).code(204).send();
  });
}
