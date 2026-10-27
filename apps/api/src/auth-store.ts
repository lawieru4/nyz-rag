import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Redis } from "ioredis";

/** 管理员与用户端共用的会话、验证码与限流存储；生产环境为 Redis，测试注入内存实现。 */
export interface AuthStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  /** 就绪检查用；连接不可用时抛出。 */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** 键前缀为 `<DOCUMENT_QUEUE_NAME>:<scope>:`，与共享 Redis 上的其他应用隔离。 */
export function createAuthStore(scope: string): AuthStore {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 3000,
  });
  // Requests receive a sanitized 503; never print connection URLs or credentials.
  redis.on("error", () => {});
  const prefix = `${process.env.DOCUMENT_QUEUE_NAME ?? "nyz-rag-document-processing"}:${scope}:`;
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
    async ping() { await redis.ping(); },
    async close() { redis.disconnect(); },
  };
}

/** 读取恰好出现一次且格式为 64 位十六进制的 Cookie；重复或格式不符时视为没有。 */
export function cookieToken(request: FastifyRequest, name: string): string | undefined {
  const values = (request.headers.cookie ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const token = values[0]!.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
