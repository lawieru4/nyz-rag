import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { claimVisitorData, createUser, getUserCredentials, recordUserLogin, updateUserPassword, type ChatOwner, type UserCredentials } from "@nyz-rag/processing";
import type { ChangePasswordRequest, EmailCodeRequest, RegisterRequest, ResetPasswordRequest, UserAccount, UserLoginRequest, UserSessionResponse } from "@nyz-rag/types";
import { cookieToken, digest, type AuthStore } from "./auth-store.js";
import type { MailMessage, Mailer } from "./mailer.js";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./passwords.js";

const USER_COOKIE = "nyz_user_session";
const VISITOR_COOKIE = "nyz_visitor";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const VISITOR_SECONDS = 365 * 24 * 60 * 60;
const WINDOW_SECONDS = 15 * 60;
const CODE_SECONDS = 10 * 60;
const CODE_COOLDOWN_SECONDS = 60;
const CODE_DAILY_LIMIT = 10;
const CODE_MAX_ATTEMPTS = 5;
const UNAVAILABLE = "认证服务暂不可用，请稍后重试";
// 读写访客/账号 Cookie 的用户端路由；/api/search 与公开文章接口不涉及归属，保持无状态。
const USER_ROUTE = /^\/api\/(chat|messages|auth)(\/|$)/;

export interface UserAuthConfig {
  /** 允许携带 Cookie 跨域访问用户端接口的前端来源（开发环境 web 与 API 端口不同）。 */
  origins: string[];
  secureCookie: boolean;
}

export function userAuthConfig(): UserAuthConfig {
  const port = process.env.WEB_PORT ?? "5175";
  const origins = (process.env.WEB_ORIGINS ?? `http://localhost:${port},http://127.0.0.1:${port}`)
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("WEB_ORIGINS must contain exact http(s) origins without paths");
    }
  }
  const secure = process.env.USER_COOKIE_SECURE;
  if (secure !== undefined && secure !== "true" && secure !== "false") {
    throw new Error("USER_COOKIE_SECURE must be true or false");
  }
  return { origins, secureCookie: secure === undefined ? process.env.NODE_ENV === "production" : secure === "true" };
}

/** 账号数据访问；测试注入内存实现，不需要数据库。 */
export interface UserRepository {
  getUserCredentials(by: { id: string } | { email: string }): Promise<UserCredentials | null>;
  createUser(input: { email: string; passwordHash: string }): Promise<UserCredentials | null>;
  updateUserPassword(id: string, passwordHash: string): Promise<number | null>;
  recordUserLogin(id: string): Promise<void>;
  claimVisitorData(visitorHash: string, userId: string): Promise<void>;
}

export const databaseUsers: UserRepository = {
  getUserCredentials: (by) => getUserCredentials(by),
  createUser: (input) => createUser(input),
  updateUserPassword: (id, hash) => updateUserPassword(id, hash),
  recordUserLogin: (id) => recordUserLogin(id),
  claimVisitorData: (visitorHash, userId) => claimVisitorData(visitorHash, userId),
};

interface Principal {
  user?: UserAccount;
  userToken?: string;
  /** 未登录时的访客 Cookie；数据库只保存其 SHA-256。 */
  visitorToken?: string;
}

interface StoredSession {
  userId: string;
  version: number;
  expiresAt: string;
}

const principals = new WeakMap<FastifyRequest, Principal>();

export function requestUserId(request: FastifyRequest): string | undefined {
  return principals.get(request)?.user?.id;
}

/** 当前请求的问答归属：已登录为账号，否则为本浏览器的匿名访客。 */
export function requestOwner(request: FastifyRequest): ChatOwner {
  const principal = principals.get(request);
  if (principal?.user) return { userId: principal.user.id };
  if (principal?.visitorToken) return { visitorHash: digest(principal.visitorToken) };
  throw new Error("The route is not covered by user authentication");
}

class AuthUnavailableError extends Error {}

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const account = (user: UserCredentials): UserAccount => ({ id: user.id, email: user.email, createdAt: user.createdAt });
const newToken = () => randomBytes(32).toString("hex");

const MAIL = {
  register: (code: string) => ({
    subject: "NYZ 知识问答注册验证码",
    text: `您的注册验证码为 ${code}，10 分钟内有效。\n\n如非本人操作，请忽略本邮件。`,
  }),
  registered: () => ({
    subject: "NYZ 知识问答账号提醒",
    text: "有人使用此邮箱申请注册 NYZ 知识问答，但该邮箱已经注册。您可以直接登录；如忘记密码，请在登录页选择「忘记密码」重置。\n\n如非本人操作，请忽略本邮件。",
  }),
  reset: (code: string) => ({
    subject: "NYZ 知识问答密码重置验证码",
    text: `您的密码重置验证码为 ${code}，10 分钟内有效。重置后，其他设备上的登录将失效。\n\n如非本人操作，请忽略本邮件，您的密码不会改变。`,
  }),
};

type CodePurpose = "register" | "reset";

export function configureUserAuth(app: FastifyInstance, options: {
  config: UserAuthConfig; store: AuthStore; mailer: Mailer | null; users: UserRepository; now?: () => number;
}): void {
  const { config, mailer, users } = options;
  const now = options.now ?? Date.now;
  // 存储故障统一转为 503，不泄露连接信息；按调用时取方法，测试可在运行中替换。
  const call = async <T>(operation: () => Promise<T>) => {
    try { return await operation(); } catch { throw new AuthUnavailableError(); }
  };
  const store = {
    get: (key: string) => call(() => options.store.get(key)),
    set: (key: string, value: string, ttl: number) => call(() => options.store.set(key, value, ttl)),
    delete: (key: string) => call(() => options.store.delete(key)),
    increment: (key: string, ttl: number) => call(() => options.store.increment(key, ttl)),
  };
  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.secureCookie ? "; Secure" : ""}`;
  const sessionKey = (token: string) => `user-session:${digest(token)}`;
  const codeKey = (purpose: CodePurpose, email: string) => `user-code:${purpose}:${digest(email)}`;
  app.addHook("onClose", async () => {
    await options.store.close();
    mailer?.close?.();
  });

  type Handler<R extends FastifyRequest> = (request: R, reply: FastifyReply) => Promise<unknown>;
  const route = <R extends FastifyRequest>(handler: Handler<R>): Handler<R> => async (request, reply) => {
    try { return await handler(request, reply); }
    catch (error) {
      if (error instanceof AuthUnavailableError) return reply.code(503).send({ error: UNAVAILABLE });
      throw error;
    }
  };

  /** 超过次数时回复 429 并返回 true。 */
  async function throttled(reply: FastifyReply, key: string, limit: number, windowSeconds: number) {
    if (await store.increment(key, windowSeconds) <= limit) return false;
    reply.header("Retry-After", windowSeconds).code(429).send({ error: "操作过于频繁，请稍后重试" });
    return true;
  }

  async function sessionUser(token: string): Promise<UserCredentials | null> {
    const value = await store.get(sessionKey(token));
    const session: StoredSession | null = value ? JSON.parse(value) : null;
    if (!session || !(Date.parse(session.expiresAt) > now())) return null;
    const user = await users.getUserCredentials({ id: session.userId });
    // 修改密码、重置密码或停用账号会提升 sessionVersion，使旧会话失效。
    return user && !user.disabled && user.sessionVersion === session.version ? user : null;
  }

  /** 签发登录会话（替换本浏览器原有会话），并把本浏览器访客的会话与问答归入账号。 */
  async function startSession(request: FastifyRequest, reply: FastifyReply, user: UserCredentials, version = user.sessionVersion) {
    const principal = principals.get(request)!;
    if (principal.visitorToken) await users.claimVisitorData(digest(principal.visitorToken), user.id);
    if (principal.userToken) await store.delete(sessionKey(principal.userToken));
    const token = newToken();
    const session: StoredSession = { userId: user.id, version, expiresAt: new Date(now() + SESSION_SECONDS * 1000).toISOString() };
    await store.set(sessionKey(token), JSON.stringify(session), SESSION_SECONDS);
    await users.recordUserLogin(user.id);
    reply.header("Set-Cookie", cookie(USER_COOKIE, token, SESSION_SECONDS));
    if (principal.visitorToken) reply.header("Set-Cookie", cookie(VISITOR_COOKIE, "", 0));
  }

  /** 发送频率：每个 IP 每小时 10 封；同一邮箱同一用途 60 秒 1 封、每天 10 封。 */
  async function codeThrottled(request: FastifyRequest, reply: FastifyReply, purpose: CodePurpose, email: string) {
    return await throttled(reply, `user-code-send:ip:${digest(request.ip)}`, 10, 60 * 60)
      || await throttled(reply, `user-code-send:cooldown:${purpose}:${digest(email)}`, 1, CODE_COOLDOWN_SECONDS)
      || await throttled(reply, `user-code-send:daily:${purpose}:${digest(email)}`, CODE_DAILY_LIMIT, 24 * 60 * 60);
  }

  async function issueCode(purpose: CodePurpose, email: string) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await store.set(codeKey(purpose, email), digest(code), CODE_SECONDS);
    await store.delete(`${codeKey(purpose, email)}:attempts`);
    return code;
  }

  /** 校验并消耗验证码，每个验证码最多尝试 5 次；失败时回复 400 并返回 false。 */
  async function consumeCode(reply: FastifyReply, purpose: CodePurpose, email: string, code: string) {
    const key = codeKey(purpose, email);
    if (await store.increment(`${key}:attempts`, CODE_SECONDS) > CODE_MAX_ATTEMPTS) {
      await store.delete(key);
      reply.code(400).send({ error: "验证码错误次数过多，请重新获取" });
      return false;
    }
    const stored = Buffer.from(await store.get(key) ?? "");
    const expected = Buffer.from(digest(code));
    if (stored.length !== expected.length || !timingSafeEqual(stored, expected)) {
      reply.code(400).send({ error: "验证码错误或已过期" });
      return false;
    }
    await store.delete(key);
    await store.delete(`${key}:attempts`);
    return true;
  }

  // 不等待发送完成：邮箱是否已注册、发送耗时都不应从响应中看出；失败只记日志。
  function deliver(request: FastifyRequest, message: MailMessage) {
    mailer!.send(message).catch((error: unknown) => {
      request.log.error(`Failed to send email: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  }

  app.addHook("onRequest", async (request, reply) => {
    const path = request.routeOptions.url ?? "";
    if (!USER_ROUTE.test(path) || request.method === "OPTIONS") return;
    reply.header("Cache-Control", "no-store");
    // 必需的自定义请求头触发 CORS 预检，未列入 WEB_ORIGINS 的来源无法带着 Cookie 发起写操作（防 CSRF）。
    if (!["GET", "HEAD"].includes(request.method) && request.headers["x-nyz-client"] !== "1") {
      return reply.code(403).send({ error: "缺少请求校验头" });
    }
    const principal: Principal = {};
    const userToken = cookieToken(request, USER_COOKIE);
    if (userToken) {
      let user: UserCredentials | null;
      try { user = await sessionUser(userToken); }
      catch (error) {
        if (error instanceof AuthUnavailableError) return reply.code(503).send({ error: UNAVAILABLE });
        throw error;
      }
      if (user) Object.assign(principal, { user: account(user), userToken });
      else reply.header("Set-Cookie", cookie(USER_COOKIE, "", 0));
    }
    if (!principal.user) {
      principal.visitorToken = cookieToken(request, VISITOR_COOKIE);
      if (!principal.visitorToken) {
        principal.visitorToken = newToken();
        reply.header("Set-Cookie", cookie(VISITOR_COOKIE, principal.visitorToken, VISITOR_SECONDS));
      }
    }
    principals.set(request, principal);
  });

  app.get("/api/auth/session", async (request): Promise<UserSessionResponse> => ({ user: principals.get(request)!.user ?? null }));

  app.post<{ Body: EmailCodeRequest }>("/api/auth/register/code", route(async (request, reply) => {
    if (!mailer) return reply.code(503).send({ error: "邮件服务尚未配置" });
    const email = normalizeEmail(request.body.email);
    if (await codeThrottled(request, reply, "register", email)) return;
    // 已注册的邮箱改发提醒邮件，响应相同，不暴露邮箱是否已注册。
    const registered = await users.getUserCredentials({ email });
    deliver(request, { to: email, ...(registered ? MAIL.registered() : MAIL.register(await issueCode("register", email))) });
    return reply.code(204).send();
  }));

  // 先验证邮箱再创建账号，避免他人抢先用别人的邮箱注册并设定密码。
  app.post<{ Body: RegisterRequest }>("/api/auth/register", route(async (request, reply) => {
    const email = normalizeEmail(request.body.email);
    if (await throttled(reply, `user-verify:ip:${digest(request.ip)}`, 30, WINDOW_SECONDS)) return;
    if (!await consumeCode(reply, "register", email, request.body.code)) return;
    const user = await users.createUser({ email, passwordHash: await hashPassword(request.body.password) });
    if (!user) return reply.code(409).send({ error: "该邮箱已注册，请直接登录" });
    await startSession(request, reply, user);
    return reply.code(201).send({ user: account(user) });
  }));

  app.post<{ Body: UserLoginRequest }>("/api/auth/login", route(async (request, reply) => {
    const email = normalizeEmail(request.body.email);
    if (await throttled(reply, `user-login:ip:${digest(request.ip)}`, 20, WINDOW_SECONDS)) return;
    if (await throttled(reply, `user-login:email:${digest(email)}`, 10, WINDOW_SECONDS)) return;
    const user = await users.getUserCredentials({ email });
    const valid = await verifyPassword(request.body.password, user?.passwordHash ?? await dummyPasswordHash());
    if (!user || !valid) return reply.code(401).send({ error: "邮箱或密码错误" });
    if (user.disabled) return reply.code(403).send({ error: "账号已停用，请联系管理员" });
    await startSession(request, reply, user);
    return { user: account(user) };
  }));

  app.post("/api/auth/logout", route(async (request, reply) => {
    const principal = principals.get(request)!;
    if (principal.user) {
      await store.delete(sessionKey(principal.userToken!));
      reply.header("Set-Cookie", cookie(USER_COOKIE, "", 0));
      // 退出后本浏览器成为新的访客，看不到账号中的会话。
      reply.header("Set-Cookie", cookie(VISITOR_COOKIE, newToken(), VISITOR_SECONDS));
    }
    return reply.code(204).send();
  }));

  app.post<{ Body: EmailCodeRequest }>("/api/auth/password-reset/code", route(async (request, reply) => {
    if (!mailer) return reply.code(503).send({ error: "邮件服务尚未配置" });
    const email = normalizeEmail(request.body.email);
    if (await codeThrottled(request, reply, "reset", email)) return;
    const user = await users.getUserCredentials({ email });
    if (user && !user.disabled) deliver(request, { to: email, ...MAIL.reset(await issueCode("reset", email)) });
    return reply.code(204).send();
  }));

  app.post<{ Body: ResetPasswordRequest }>("/api/auth/password-reset", route(async (request, reply) => {
    const email = normalizeEmail(request.body.email);
    if (await throttled(reply, `user-verify:ip:${digest(request.ip)}`, 30, WINDOW_SECONDS)) return;
    if (!await consumeCode(reply, "reset", email, request.body.code)) return;
    const user = await users.getUserCredentials({ email });
    const version = user && !user.disabled ? await users.updateUserPassword(user.id, await hashPassword(request.body.password)) : null;
    if (!user || version === null) return reply.code(400).send({ error: "验证码错误或已过期" });
    await startSession(request, reply, user, version);
    return { user: account(user) };
  }));

  app.post<{ Body: ChangePasswordRequest }>("/api/auth/password", route(async (request, reply) => {
    const current = principals.get(request)!.user;
    if (!current) return reply.code(401).send({ error: "请先登录" });
    if (await throttled(reply, `user-login:email:${digest(current.email)}`, 10, WINDOW_SECONDS)) return;
    const user = await users.getUserCredentials({ id: current.id });
    if (!user || !await verifyPassword(request.body.currentPassword, user.passwordHash)) return reply.code(400).send({ error: "当前密码错误" });
    const version = await users.updateUserPassword(user.id, await hashPassword(request.body.password));
    // 其他设备上的会话随版本提升失效，当前浏览器换发新会话。
    await startSession(request, reply, user, version!);
    return reply.code(204).send();
  }));
}
