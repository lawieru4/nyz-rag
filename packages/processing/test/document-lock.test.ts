import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, DocumentBusyError, migrate, withDocumentWork, withTransaction } from "../src/db.js";
import { processDocument } from "../src/process.js";
import { createSource, getDocument, upsertDocument } from "../src/repository.js";
import { ARTICLE_LIST_URL, articleDocument } from "./article-fixtures.js";

test("document work locks span transactions, roll back sync conflicts and fence disconnected owners", { skip: process.env.NYZ_INTEGRATION_TEST !== "1", timeout: 30000 }, async () => {
  const previousUrl = process.env.DATABASE_URL;
  const baseUrl = previousUrl ?? "postgresql://nyzrag:nyzrag@localhost:5432/nyzrag";
  const schema = `nyz_lock_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: baseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(baseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  process.env.DATABASE_URL = url.toString();
  try {
    await migrate();
    const source = await createSource({ name: "Lock test", url: ARTICLE_LIST_URL, kind: "文章 API", frequency: "" });
    const input = articleDocument(source.id, "a", "Original", "Original body");
    const id = await withTransaction((tx) => upsertDocument(tx, input));
    let contender: Promise<void> | undefined;
    let entered = false;
    const attempted = Promise.withResolvers<void>();
    await withDocumentWork(async (db, lock) => {
      await lock(id);
      await lock(id); // Reentrant use must not leak an extra session lock.
      await db.transaction((tx) => processDocument(tx, id));
      await assert.rejects(withTransaction((tx) => upsertDocument(tx, { ...input, title: "Stale sync" })), DocumentBusyError);
      assert.equal((await getDocument(id))!.title, "Original", "busy sync rolls back its upsert");
      await assert.rejects(withTransaction((tx) => processDocument(tx, id)), DocumentBusyError);
      contender = withDocumentWork(async (other, acquire) => {
        attempted.resolve();
        await acquire(id);
        entered = true;
        await other.transaction((tx) => processDocument(tx, id));
      });
      await attempted.promise;
      await withDocumentWork(async (_other, acquire) => { await acquire(`${id}-different`); });
      await delay(250);
      assert.equal(entered, false, "same document waits across commits while other documents proceed");
    });
    await contender;
    assert.equal(entered, true);

    const created = await Promise.all([0, 1].map(() => withDocumentWork(async (db, lock) => {
      return db.transaction(async (tx) => {
        const createdId = await upsertDocument(tx, articleDocument(source.id, "new", "Original", "Original body"));
        await lock(createdId);
        await processDocument(tx, createdId);
        return createdId;
      });
    })));
    assert.equal(created[0], created[1], "concurrent first syncs converge on one document identity");

    const body = "Shared document body with enough content for deduplication. ".repeat(4).trim();
    const primary = await withTransaction(async (tx) => {
      const target = await upsertDocument(tx, articleDocument(source.id, "primary", "Original", body));
      await processDocument(tx, target);
      return target;
    });
    const dependent = await withTransaction(async (tx) => {
      const target = await upsertDocument(tx, articleDocument(source.id, "duplicate", "Original", body));
      assert.equal((await processDocument(tx, target)).duplicateOf, primary);
      return target;
    });
    await withDocumentWork(async (db, lock) => {
      await lock(dependent);
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM documents WHERE id = ${dependent} FOR UPDATE`);
        // A dependent already owns its row; the primary must fail fast rather than wait for that row.
        const conflict = withTransaction(async (other) => {
          await upsertDocument(other, articleDocument(source.id, "primary", "Original", "Changed body"));
          await processDocument(other, primary);
        });
        await assert.rejects(conflict, DocumentBusyError);
      });
    });
    assert.equal((await getDocument(primary))!.content, body, "dependent lock contention rolls back primary changes");

    await assert.rejects(withDocumentWork(async (_db, lock) => { await lock(id); throw new Error("processing failed"); }), /processing failed/);
    await withDocumentWork(async (_db, lock) => { await lock(id); });

    // Terminate only this test's backend, never a shared service or another session.
    await withDocumentWork(async (db, lock) => {
      await lock(id);
      const result = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
      const client = db.$client as pg.PoolClient;
      const disconnected = once(client, "error");
      await admin.query("SELECT pg_terminate_backend($1)", [result.rows[0].pid]);
      await disconnected;
      await withDocumentWork(async (_other, acquire) => { await acquire(id); });
      await assert.rejects(db.execute(sql`UPDATE documents SET title = 'stale owner' WHERE id = ${id}`));
    });
    assert.equal((await getDocument(id))!.title, "Original");
  } finally {
    await closeDatabase();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
