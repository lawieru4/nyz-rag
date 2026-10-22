/**
 * Shared lazy admission limiter for model calls.
 * One instance per process, created on first use and closed on shutdown.
 *
 * Env vars:
 *   MODEL_RATE_LIMIT_MAX     – requests per window (default 120)
 *   MODEL_CONCURRENCY_LIMIT  – max concurrent requests (default 8)
 *   RATE_LIMIT_WINDOW_MS     – window duration in ms (default 60000)
 *
 * Bucket key = SHA-256( provider.id ":" kind ":" model ).slice(0,40)
 * No credentials or URLs in the bucket key.
 */

import { createHash } from "node:crypto";
import { createRedisAdmissionLimiter, type AdmissionLease, type AdmissionLimiter, type AdmissionRule } from "./admission.js";
export type { AdmissionLimiter } from "./admission.js";

// ─── Env config ───────────────────────────────────────────────────────────────

function readEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive safe integer`);
  return n;
}

export function modelAdmissionConfig(): { rateLimit: number; windowMs: number; concurrency: number } {
  return {
    rateLimit: readEnvInt("MODEL_RATE_LIMIT_MAX", 120),
    windowMs: readEnvInt("RATE_LIMIT_WINDOW_MS", 60_000),
    concurrency: readEnvInt("MODEL_CONCURRENCY_LIMIT", 8),
  };
}

// ─── Lazy shared limiter ──────────────────────────────────────────────────────

let sharedLimiter: AdmissionLimiter | undefined;

export function getModelAdmissionLimiter(): AdmissionLimiter {
  if (!sharedLimiter) {
    sharedLimiter = createRedisAdmissionLimiter();
  }
  return sharedLimiter;
}

/**
 * Shutdown hook for API/worker lifecycle.
 * Closes the shared Redis connection if it was ever created.
 */
export async function closeModelAdmissionLimiter(): Promise<void> {
  if (sharedLimiter) {
    const l = sharedLimiter;
    sharedLimiter = undefined;
    await l.close();
  }
}

// ─── Bucket key ───────────────────────────────────────────────────────────────

/**
 * Deterministic, credential-free bucket key for a provider + model kind + model name.
 */
export function modelBucketKey(providerId: string, kind: string, model: string): string {
  return createHash("sha256")
    .update(`${providerId}:${kind}:${model}`)
    .digest("hex")
    .slice(0, 40);
}

// ─── Acquire helper ───────────────────────────────────────────────────────────

/**
 * Build admission rules and acquire a lease for a single model request.
 * Uses the injected limiter if provided, otherwise the shared lazy limiter.
 */
export async function acquireModelLease(
  providerId: string,
  kind: string,
  model: string,
  limiter?: AdmissionLimiter,
): Promise<AdmissionLease> {
  const cfg = modelAdmissionConfig();
  const bucketKey = modelBucketKey(providerId, kind, model);
  const rules: AdmissionRule[] = [
    {
      key: bucketKey,
      limit: cfg.rateLimit,
      windowMs: cfg.windowMs,
      concurrency: cfg.concurrency,
    },
  ];
  const l = limiter ?? getModelAdmissionLimiter();
  return l.acquire(rules);
}
