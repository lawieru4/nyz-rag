import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { closeDatabase, migrate } from "../src/db.js";
import { createChatMessage, getChatStats } from "../src/repository.js";

const MINUTE = 60_000;

test("chat stats bucket by the requested time zone, fill empty days and summarize fallbacks, latency and tokens", { skip: process.env.NYZ_INTEGRATION_TEST !== "1", timeout: 60000 }, async () => {
  const previous = process.env.DATABASE_URL;
  const connectionString = previous ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag";
  const admin = new pg.Pool({ connectionString });
  const schema = `nyz_stats_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  try {
    await migrate();
    // 上海今天 0 点前后各几分钟：按上海时区分属昨天与今天，按 UTC（16:00 前后）属同一天。
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    const midnight = Date.parse(`${today}T00:00:00+08:00`);
    const at = (offset: number) => new Date(midnight + offset).toISOString();
    const message = (id: string, offset: number, extra: Partial<Parameters<typeof createChatMessage>[0]>) =>
      createChatMessage({ id, question: id, answer: id, sources: [], createdAt: at(offset), ...extra });
    await message("generated", 1 * MINUTE, { answerMode: "generated", model: "m", totalMs: 100, firstTokenMs: 50, promptTokens: 10, completionTokens: 5, rewritePromptTokens: 3, rewriteCompletionTokens: 2 });
    await message("failed", 2 * MINUTE, { answerMode: "extractive", fallbackReason: "model_error", totalMs: 300, promptTokens: 7, rating: "negative" });
    await message("legacy", 3 * MINUTE, { answerMode: "extractive" });
    await message("rejected", -1 * MINUTE, { answerMode: "extractive", fallbackReason: "citation_rejected", totalMs: 1000, firstTokenMs: 400 });
    await message("old", -20 * 24 * 60 * MINUTE, { answerMode: "extractive", fallbackReason: "no_context", totalMs: 5 });
    await assert.rejects(message("invalid", 0, { answerMode: "generated", fallbackReason: "model_error" }), (error: Error) => (error.cause as { constraint?: string }).constraint === "chat_messages_fallback_reason_check");

    const stats = await getChatStats(2, "Asia/Shanghai");
    assert.equal(stats.timeZone, "Asia/Shanghai");
    assert.deepEqual(stats.days.map((day) => day.date), [new Date(midnight - 12 * 60 * MINUTE).toISOString().slice(0, 10), today]);
    const [yesterday, current] = stats.days;
    assert.equal(current.questions, 3);
    assert.equal(current.extractive, 2);
    assert.deepEqual(current.fallbacks, { no_chat_model: 0, no_context: 0, model_error: 1, citation_rejected: 0, empty_answer: 0 });
    assert.equal(current.negative, 1);
    // percentile_cont 在 [100, 300] 之间插值；没有耗时的历史问答不参与。
    assert.equal(current.totalMsP50, 200);
    assert.equal(current.totalMsP95, 290);
    assert.equal(current.firstTokenMsP50, 50);
    assert.deepEqual([current.promptTokens, current.completionTokens, current.rewritePromptTokens, current.rewriteCompletionTokens], [17, 5, 3, 2]);
    assert.equal(yesterday.questions, 1);
    assert.equal(yesterday.fallbacks.citation_rejected, 1);
    assert.equal(stats.total.questions, 4, "the 20-day-old message is outside the range");
    assert.equal(stats.total.extractive, 3);
    assert.equal(stats.total.fallbacks.no_context, 0);
    assert.equal(stats.total.totalMsP50, 300);

    const utc = await getChatStats(3, "UTC");
    assert.ok(utc.days.some((day) => day.questions === 4), "all four fall on the same UTC day");

    const empty = await getChatStats(5, "Asia/Shanghai");
    assert.equal(empty.days.length, 5);
    assert.deepEqual(empty.days.slice(0, 3).map((day) => [day.questions, day.totalMsP50, day.promptTokens]), [[0, null, 0], [0, null, 0], [0, null, 0]]);
  } finally {
    await closeDatabase();
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
