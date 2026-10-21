import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;
/** 数据库或事务对象；需要多步一致性的 repository 函数接收事务内的执行器。 */
export type Executor = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;
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

const migrationsFolder = fileURLToPath(new URL("../migrations/", import.meta.url));
// API、Worker 与命令行可能同时启动，用会话级咨询锁串行执行迁移。
const MIGRATION_LOCK = 4_637_201;

export async function migrate(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    // 迁移记录表放在当前 schema，使临时 schema（集成测试）拥有独立的迁移历史。
    const { rows: [{ current }] } = await client.query<{ current: string }>("SELECT current_schema() AS current");
    await runMigrations(drizzle(client, { casing: "snake_case" }), { migrationsFolder, migrationsSchema: current, migrationsTable: "__drizzle_migrations" });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

export async function closeDatabase(): Promise<void> {
  const currentPool = pool;
  pool = undefined;
  database = undefined;
  if (currentPool) await currentPool.end();
}
