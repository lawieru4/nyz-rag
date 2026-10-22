import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export interface AdmissionRule {
  key: string;
  limit: number;
  windowMs: number;
  concurrency?: number;
}

export interface AdmissionLease {
  release(): Promise<void>;
}

export interface AdmissionLimiter {
  acquire(rules: AdmissionRule[], leaseMs?: number): Promise<AdmissionLease>;
  close(): Promise<void>;
}

export class AdmissionError extends Error {
  constructor(readonly statusCode: 429 | 503, readonly retryAfter: number, message: string) {
    super(message);
    this.name = "AdmissionError";
  }
}

export interface AdmissionLimiterConfig {
  redisUrl?: string;
  prefix?: string;
  commandTimeoutMs?: number;
}

// Check all buckets before charging any. Redis time avoids replica clock skew.
const ACQUIRE = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local token, lease = ARGV[1], tonumber(ARGV[2])
for i = 1, #KEYS / 2 do
  local rate, slots = KEYS[2*i-1], KEYS[2*i]
  local limit, concurrency = tonumber(ARGV[3*i]), tonumber(ARGV[3*i+2])
  if tonumber(redis.call('GET', rate) or '0') >= limit then
    return {0, math.max(1, math.ceil(redis.call('PTTL', rate) / 1000))}
  end
  if concurrency > 0 then
    redis.call('ZREMRANGEBYSCORE', slots, '-inf', now)
    if redis.call('ZCARD', slots) >= concurrency then
      local oldest = redis.call('ZRANGE', slots, 0, 0, 'WITHSCORES')
      return {0, math.max(1, math.ceil((tonumber(oldest[2]) - now) / 1000))}
    end
  end
end
for i = 1, #KEYS / 2 do
  local rate, slots = KEYS[2*i-1], KEYS[2*i]
  local window, concurrency = tonumber(ARGV[3*i+1]), tonumber(ARGV[3*i+2])
  if redis.call('INCR', rate) == 1 then redis.call('PEXPIRE', rate, window) end
  if concurrency > 0 then
    redis.call('ZADD', slots, now + lease, token)
    local last = redis.call('ZRANGE', slots, -1, -1, 'WITHSCORES')
    redis.call('PEXPIRE', slots, math.max(1, tonumber(last[2]) - now))
  end
end
return {1, 0}
`;

// Never resurrect an expired/released token, even when a renewal arrives late.
const RENEW = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
for _, key in ipairs(KEYS) do
  local score = redis.call('ZSCORE', key, ARGV[1])
  if not score or tonumber(score) <= now then return 0 end
end
for _, key in ipairs(KEYS) do
  redis.call('ZADD', key, 'XX', now + tonumber(ARGV[2]), ARGV[1])
  local last = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
  redis.call('PEXPIRE', key, math.max(1, tonumber(last[2]) - now))
end
return 1
`;

const RELEASE = `
for _, key in ipairs(KEYS) do redis.call('ZREM', key, ARGV[1]) end
return 1
`;

function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
}

export function createRedisAdmissionLimiter(config: AdmissionLimiterConfig = {}): AdmissionLimiter {
  const timeout = config.commandTimeoutMs ?? 2000;
  positive(timeout, "commandTimeoutMs");
  const prefix = config.prefix ?? `${process.env.DOCUMENT_QUEUE_NAME ?? "nyz-rag-document-processing"}:admission:`;
  const redis = new Redis(config.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
    commandTimeout: timeout, connectTimeout: timeout, retryStrategy: () => null,
  });
  redis.on("error", () => {});
  let connecting: Promise<void> | undefined;
  let closed = false;
  const timers = new Set<ReturnType<typeof setInterval>>();
  const unavailable = () => new AdmissionError(503, 5, "The rate limiter is temporarily unavailable. Please try again shortly.");

  async function ready() {
    if (closed) throw unavailable();
    if (redis.status === "ready") return;
    connecting ??= redis.connect().then(() => undefined).finally(() => { connecting = undefined; });
    await connecting;
  }

  return {
    async acquire(rules, leaseMs = 600_000) {
      positive(leaseMs, "leaseMs");
      const seen = new Set<string>();
      for (const rule of rules) {
        if (!rule.key || seen.has(rule.key)) throw new Error("Admission rules require distinct non-empty keys");
        seen.add(rule.key);
        positive(rule.limit, "limit");
        positive(rule.windowMs, "windowMs");
        if (rule.concurrency !== undefined) positive(rule.concurrency, "concurrency");
      }
      if (closed) throw unavailable();
      if (!rules.length) return { async release() {} };
      const pairs = rules.map((rule) => {
        const key = createHash("sha256").update(rule.key).digest("hex");
        return [`${prefix}rate:${key}`, `${prefix}slots:${key}`];
      });
      const keys = pairs.flat();
      const slots = pairs.filter((_, index) => rules[index].concurrency !== undefined).map((pair) => pair[1]);
      const token = randomUUID();
      let result: [number, number];
      try {
        await ready();
        result = await redis.eval(ACQUIRE, keys.length, ...keys, token, leaseMs,
          ...rules.flatMap((rule) => [rule.limit, rule.windowMs, rule.concurrency ?? 0])) as [number, number];
      } catch { throw unavailable(); }
      if (result[0] !== 1) throw new AdmissionError(429, result[1], "Too many requests or concurrent operations. Please try again later.");
      let released = false;
      let renewing = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const stopRenewal = () => { if (timer) { clearInterval(timer); timers.delete(timer); } };
      if (slots.length) {
        timer = setInterval(() => {
          if (renewing || released || closed) return;
          renewing = true;
          void redis.eval(RENEW, slots.length, ...slots, token, leaseMs)
            .then((renewed) => { if (renewed !== 1) stopRenewal(); })
            .catch(() => { /* Keep the original expiry on failure; subsequent admissions fail closed. */ })
            .finally(() => { renewing = false; });
        }, Math.max(1, Math.floor(leaseMs / 3)));
        timer.unref();
        timers.add(timer);
      }
      return { async release() {
        if (released) return;
        released = true;
        stopRenewal();
        if (!slots.length || closed) return;
        try {
          await ready();
          await redis.eval(RELEASE, slots.length, ...slots, token);
        } catch { /* Crash/outage recovery uses the lease TTL; never mask the original result. */ }
      } };
    },
    async close() {
      closed = true;
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      redis.disconnect();
    },
  };
}
