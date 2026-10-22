import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AdmissionError, createRedisAdmissionLimiter, type AdmissionRule } from "../src/admission.js";

const denied = (status: number) => (error: unknown) => {
  assert.ok(error instanceof AdmissionError);
  assert.equal(error.statusCode, status);
  assert.ok(error.retryAfter >= 1);
  assert.doesNotMatch(error.message, /127\.0\.0\.1|redis:\/\/|password|secret/);
  return true;
};

test("invalid rules are rejected before connecting; empty rules need no Redis", async () => {
  const limiter = createRedisAdmissionLimiter({ redisUrl: "redis://127.0.0.1:1" });
  const rule = { key: "test", limit: 2, windowMs: 1000 };
  try {
    await (await limiter.acquire([])).release();
    for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(limiter.acquire([{ ...rule, limit: value }]), /positive safe integer/);
      await assert.rejects(limiter.acquire([{ ...rule, windowMs: value }]), /positive safe integer/);
      await assert.rejects(limiter.acquire([{ ...rule, concurrency: value }]), /positive safe integer/);
      await assert.rejects(limiter.acquire([rule], value), /positive safe integer/);
    }
    await assert.rejects(limiter.acquire([rule, rule]), /distinct/);
  } finally { await limiter.close(); }
});

test("Redis failures fail closed, recoverable calls and close stay bounded", async () => {
  const limiter = createRedisAdmissionLimiter({ redisUrl: "redis://127.0.0.1:1", commandTimeoutMs: 100 });
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(limiter.acquire([{ key: "test", limit: 1, windowMs: 1000 }]), denied(503));
  } finally { await limiter.close(); }
  await assert.rejects(limiter.acquire([]), denied(503));
});

const redisTest = { skip: process.env.NYZ_RATE_LIMIT_REDIS_TEST !== "1" };
const prefix = () => `nyz-test-admission:${randomUUID()}:`;

test("real Redis atomically limits simultaneous first requests across replicas", redisTest, async () => {
  const namespace = prefix();
  const replicas = [createRedisAdmissionLimiter({ prefix: namespace }), createRedisAdmissionLimiter({ prefix: namespace })];
  const rule: AdmissionRule = { key: "rate", limit: 5, windowMs: 400 };
  try {
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => replicas[i % 2].acquire([rule])));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
    for (const result of results) {
      if (result.status === "fulfilled") await result.value.release();
      else denied(429)(result.reason);
    }
    await delay(450);
    await (await replicas[0].acquire([rule])).release();
  } finally { await Promise.all(replicas.map((replica) => replica.close())); }
});

test("real Redis rejection is atomic and release is idempotent", redisTest, async () => {
  const limiter = createRedisAdmissionLimiter({ prefix: prefix() });
  const rate: AdmissionRule = { key: "rate", limit: 2, windowMs: 1000 };
  const concurrent: AdmissionRule = { key: "slots", limit: 100, windowMs: 1000, concurrency: 1 };
  try {
    const first = await limiter.acquire([rate, concurrent]);
    for (let i = 0; i < 5; i++) await assert.rejects(limiter.acquire([rate, concurrent]), denied(429));
    await first.release();
    const second = await limiter.acquire([rate, concurrent]);
    await first.release();
    await assert.rejects(limiter.acquire([concurrent]), denied(429));
    await second.release();
    await assert.rejects(limiter.acquire([rate]), denied(429));
    await (await limiter.acquire([concurrent])).release();
  } finally { await limiter.close(); }
});

test("real Redis concurrent admission never exceeds the configured slots", redisTest, async () => {
  const namespace = prefix();
  const replicas = [createRedisAdmissionLimiter({ prefix: namespace }), createRedisAdmissionLimiter({ prefix: namespace })];
  const rule: AdmissionRule = { key: "slots", limit: 100, windowMs: 1000, concurrency: 3 };
  try {
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => replicas[i % 2].acquire([rule])));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 3);
    for (const result of results) {
      if (result.status === "fulfilled") await result.value.release();
      else denied(429)(result.reason);
    }
  } finally { await Promise.all(replicas.map((replica) => replica.close())); }
});

test("real Redis renews active leases and expires abandoned leases after process close", redisTest, async () => {
  const namespace = prefix();
  const first = createRedisAdmissionLimiter({ prefix: namespace });
  const second = createRedisAdmissionLimiter({ prefix: namespace });
  const rule: AdmissionRule = { key: "lease", limit: 100, windowMs: 1000, concurrency: 1 };
  try {
    const stale = await first.acquire([rule], 300);
    await delay(650);
    await assert.rejects(second.acquire([rule], 300), denied(429));
    await first.close();
    await delay(400);
    const current = await second.acquire([rule], 300);
    await stale.release();
    await assert.rejects(second.acquire([rule], 300), denied(429));
    await current.release();
    await (await second.acquire([rule], 300)).release();
  } finally { await first.close(); await second.close(); }
});

test("real Redis shorter leases never truncate another holder's TTL", redisTest, async () => {
  const namespace = prefix();
  const first = createRedisAdmissionLimiter({ prefix: namespace });
  const second = createRedisAdmissionLimiter({ prefix: namespace });
  const rule: AdmissionRule = { key: "lease", limit: 100, windowMs: 1000, concurrency: 2 };
  try {
    await first.acquire([rule], 1000);
    await first.close();
    const short = await second.acquire([rule], 150);
    await delay(300);
    await assert.rejects(second.acquire([rule], 150), denied(429));
    await short.release();
  } finally { await first.close(); await second.close(); }
});
