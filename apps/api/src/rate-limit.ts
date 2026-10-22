import { isIP } from "node:net";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { type AdmissionLimiter, type AdmissionRule } from "@nyz-rag/processing";
import { digest } from "./auth-store.js";
import { requestOwner, requestUserId } from "./user-auth.js";

export function rateLimitConfig(env = process.env) {
  const positive = (name: string, fallback: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  return {
    windowMs: positive("RATE_LIMIT_WINDOW_MS", 60_000),
    ip: positive("API_IP_RATE_LIMIT_MAX", 120),
    user: positive("API_USER_RATE_LIMIT_MAX", 60),
    chatIp: positive("CHAT_IP_RATE_LIMIT_MAX", 20),
    chatUser: positive("CHAT_USER_RATE_LIMIT_MAX", 10),
    chatIpConcurrency: positive("CHAT_IP_CONCURRENCY_LIMIT", 4),
    chatUserConcurrency: positive("CHAT_USER_CONCURRENCY_LIMIT", 2),
    chatGlobalConcurrency: positive("CHAT_GLOBAL_CONCURRENCY_LIMIT", 32),
  };
}

// Never trust arbitrary forwarded headers or a hop count on a directly reachable API.
export function trustedProxies(value = process.env.TRUSTED_PROXIES): FastifyServerOptions["trustProxy"] {
  if (!value?.trim()) return false;
  const addresses = value.split(",").map((address) => address.trim());
  for (const address of addresses) {
    const [ip, prefix, extra] = address.split("/");
    const family = isIP(ip!);
    if (!family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error("TRUSTED_PROXIES must contain explicit IP addresses or CIDRs");
    }
    if (prefix !== undefined && Number(prefix) === 0) throw new Error("TRUSTED_PROXIES must not trust every address");
  }
  return addresses;
}

export function configureRateLimits(app: FastifyInstance, limiter: AdmissionLimiter, config = rateLimitConfig()) {
  const rule = (key: string, limit: number, concurrency?: number): AdmissionRule => ({ key, limit, windowMs: config.windowMs, concurrency });
  app.addHook("onClose", () => limiter.close());
  app.addHook("onRequest", async (request) => {
    const path = request.routeOptions.url ?? request.url.split("?")[0]!;
    if (request.method === "OPTIONS" || !path.startsWith("/api/")) return;
    const lease = await limiter.acquire([rule(`api:ip:${digest(request.ip)}`, config.ip)]);
    await lease.release();
  });
  // Authentication runs in onRequest, before this hook; never accept a client-supplied user ID.
  app.addHook("preValidation", async (request) => {
    if (request.method === "OPTIONS") return;
    const userId = requestUserId(request);
    if (!userId) return;
    const lease = await limiter.acquire([rule(`api:user:${digest(userId)}`, config.user)]);
    await lease.release();
  });
  app.addHook("onRoute", (route) => {
    if (route.method !== "POST" || !["/api/chat", "/api/chat/sessions/:id/stream"].includes(route.url)) return;
    const handler = route.handler;
    route.handler = async function (request, reply) {
      const owner = requestOwner(request);
      const identity = owner.userId !== undefined ? `user:${digest(owner.userId)}` : `visitor:${owner.visitorHash}`;
      const lease = await limiter.acquire([
        rule(`chat:ip:${digest(request.ip)}`, config.chatIp, config.chatIpConcurrency),
        rule(`chat:${identity}`, config.chatUser, config.chatUserConcurrency),
        rule("chat:global", Number.MAX_SAFE_INTEGER, config.chatGlobalConcurrency),
      ]);
      try {
        return await handler.call(this, request, reply);
      } finally {
        // Keep slots until the work actually stops, including hijacked SSE/disconnected clients.
        await lease.release().catch(() => request.log.warn("Failed to release request admission lease"));
      }
    };
  });
}
