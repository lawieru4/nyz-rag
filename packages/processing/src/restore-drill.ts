// 备份恢复演练（db:restore-drill，docs/backup-restore.md）的纯逻辑：临时库命名、各表的恢复类别、迁移记录核对与密钥解密检查。
import { randomBytes } from "node:crypto";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";
import { decryptSecret } from "./secrets.js";

/** 演练只创建、删除这种名称的数据库，避免误删业务库。 */
export const RESTORE_DRILL_DATABASE = /^nyzrag_restore_drill_\d{8}t\d{6}_[0-9a-f]{6}$/;

export function drillDatabaseName(now = new Date(), suffix = randomBytes(3).toString("hex")): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15).toLowerCase();
  const name = `nyzrag_restore_drill_${stamp}_${suffix}`;
  if (!RESTORE_DRILL_DATABASE.test(name)) throw new Error(`Invalid drill database name: ${name}`);
  return name;
}

/**
 * 表数据丢失后能否找回，与 docs/backup-restore.md 第一节一致：
 * primary 不能重建；articles 可从文章接口重新同步（上游已删除或无权限的文章找不回）；derived 可由文章重新切片、向量化（Embedding 产生费用）；
 * runtime 为运行记录，丢失只影响历史与进行中的任务。新增表时须在此归类（测试校验）。
 */
export type RecoveryClass = "primary" | "articles" | "derived" | "runtime";

export const RECOVERY_CLASS_LABELS: Record<RecoveryClass, string> = {
  primary: "不能重建",
  articles: "可重新同步",
  derived: "可从文章重建",
  runtime: "运行记录",
};

export const TABLE_RECOVERY: Record<string, RecoveryClass> = {
  admin_accounts: "primary",
  admin_roles: "primary",
  admin_audit_logs: "primary",
  users: "primary",
  chat_sessions: "primary",
  chat_messages: "primary",
  message_sources: "primary",
  message_chunks: "primary",
  knowledge_bases: "primary",
  model_providers: "primary",
  model_settings: "primary",
  secret_settings: "primary",
  data_sources: "primary",
  documents: "articles",
  document_chunks: "derived",
  document_sections: "derived",
  operations: "runtime",
  crawl_tasks: "runtime",
};

/** schema.ts 中定义的全部表名。 */
export function schemaTableNames(): string[] {
  return Object.values(schema).filter((value) => is(value, PgTable)).map((table) => getTableName(table as PgTable)).sort();
}

export type MigrationEntry = { tag: string; folderMillis: number };
export type MigrationCheck = {
  applied: number;
  /** 当前代码有、备份之后才加的迁移：服务启动时会自动执行。 */
  pending: string[];
  /** 早于备份中最后一条、却没有执行过的迁移：drizzle 只比较最后一条的时间，这些迁移永远不会再执行。 */
  missing: string[];
  /** 备份中有、当前代码没有的迁移（created_at）：备份来自更新或分叉的版本，不能用当前代码启动。 */
  unknown: number[];
};

/**
 * 按 created_at（迁移日志的 when）核对迁移记录，与 drizzle migrator 的判断一致。不比较 hash：
 * 它是迁移文件原始字节的 SHA-256，Windows 检出的 CRLF 文件与容器中的 LF 文件不同。
 */
export function compareMigrations(applied: number[], journal: MigrationEntry[]): MigrationCheck {
  const done = new Set(applied);
  const known = new Set(journal.map((entry) => entry.folderMillis));
  const last = applied.length ? Math.max(...applied) : -Infinity;
  return {
    applied: applied.length,
    pending: journal.filter((entry) => entry.folderMillis > last).map((entry) => entry.tag),
    missing: journal.filter((entry) => entry.folderMillis <= last && !done.has(entry.folderMillis)).map((entry) => entry.tag),
    unknown: applied.filter((millis) => !known.has(millis)).sort((a, b) => a - b),
  };
}

export type StoredSecret = { label: string; ciphertext: string; context: string };

/** 用当前 NYZ_SECRET_KEY 逐个解密，只返回是否成功与错误信息，不返回明文。 */
export function checkSecrets(secrets: StoredSecret[]): { label: string; error?: string }[] {
  return secrets.map(({ label, ciphertext, context }) => {
    try {
      decryptSecret(ciphertext, context);
      return { label };
    } catch (error) {
      return { label, error: error instanceof Error ? error.message : "unknown error" };
    }
  });
}
