import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
/** 数据库或事务对象；需要多步一致性的 repository 函数接收事务内的执行器。 */
export type Executor = Pick<Database, "select" | "selectDistinctOn" | "insert" | "update" | "delete" | "execute">;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

let pool: Pool | undefined;
let database: Database | undefined;

export function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  if (!pool) {
    pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    pool.on("error", () => console.error("Database idle connection failed"));
  }
  return pool;
}

export function getDb(): Database {
  database ??= drizzle(getPool(), { schema, casing: "snake_case" });
  return database;
}

export function withTransaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
  return getDb().transaction(run);
}

export class DocumentBusyError extends Error {
  constructor() { super("Document is being processed; retry later"); }
}

/** Nonblocking acquisition avoids deadlocks when deduplication touches several documents. */
export async function lockDocumentWork(tx: Executor, id: string): Promise<void> {
  const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`nyz-rag:document:${id}`}, 0)) AS locked`);
  if (!result.rows[0]?.locked) throw new DocumentBusyError();
}

/**
 * Keep the document lock across short transactions and model calls, without an open transaction.
 * All writes must use this connection: losing it also prevents a former owner from writing.
 * Acquire session locks before committing any changes; busy attempts must be safe to retry.
 */
export async function withDocumentWork<T>(run: (db: Database, lock: (id: string) => Promise<void>) => Promise<T>): Promise<T> {
  for (;;) {
    const client = await getPool().connect();
    const keys = new Set<string>();
    let broken = false;
    const onError = () => { broken = true; };
    client.on("error", onError);
    try {
      const db = drizzle(client, { schema, casing: "snake_case" });
      return await run(db, async (id) => {
        const key = `nyz-rag:document:${id}`;
        if (keys.has(key)) return;
        const { rows: [row] } = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [key]);
        if (!row.locked) throw new DocumentBusyError();
        keys.add(key);
      });
    } catch (error) {
      if (!(error instanceof DocumentBusyError) || broken) throw error;
    } finally {
      try {
        for (const key of keys) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } catch { broken = true; }
      client.removeListener("error", onError);
      client.release(broken);
    }
    // Wait outside the pool so contenders cannot starve the lock holder of connections.
    await delay(100 + Math.floor(Math.random() * 100));
  }
}

const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
// API、Worker 与命令行可能同时启动，用会话级咨询锁串行执行迁移。
const MIGRATION_LOCK = 4_637_201;

export async function migrate(): Promise<void> {
  const client = await getPool().connect();
  try {
    // HNSW builds can exceed the normal 10s query budget on an existing corpus.
    await client.query("SET statement_timeout = 0");
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    // 迁移记录表放在当前 schema，使临时 schema（集成测试）拥有独立的迁移历史。
    const { rows: [{ current }] } = await client.query<{ current: string }>("SELECT current_schema() AS current");
    await runMigrations(drizzle(client, { casing: "snake_case" }), { migrationsFolder, migrationsSchema: current, migrationsTable: "__drizzle_migrations" });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    await client.query("RESET statement_timeout").catch(() => undefined);
    client.release();
  }
}

export async function closeDatabase(): Promise<void> {
  const currentPool = pool;
  pool = undefined;
  database = undefined;
  if (currentPool) await currentPool.end();
}
