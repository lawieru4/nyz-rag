// 用法：NYZ_RESTORE_ADMIN_URL=<管理连接> pnpm db:restore-drill --dump=<备份文件> [--pg-restore="<命令>"]
// 恢复演练（docs/backup-restore.md 第三节）：把 pg_dump 自定义格式（-Fc）的备份恢复到新建的临时库 nyzrag_restore_drill_*，
// 核对迁移记录、各表行数、已向量化文档的切片与向量是否齐全，以及当前 NYZ_SECRET_KEY 能否解开备份中加密保存的密钥，最后删除临时库。
// 不连接 DATABASE_URL 指向的业务库。临时库由 NYZ_RESTORE_ADMIN_URL 的账号创建并恢复（需要 CREATEDB 且能创建 vector 扩展，通常为超级用户）。
// pg_restore 从标准输入读取备份，主机、端口、账号与密码经 PGHOST/PGPORT/PGUSER/PGPASSWORD 传入，不出现在命令行；版本不能低于生成备份的 pg_dump。
// 本机没有合适的 pg_restore 时用数据库容器里的：--pg-restore="docker exec -i -e PGUSER -e PGPASSWORD <容器> pg_restore"（容器内经本地套接字连接）。
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { providerSecretContext } from "../secrets.js";
import {
  checkSecrets, compareMigrations, drillDatabaseName, RECOVERY_CLASS_LABELS, RESTORE_DRILL_DATABASE, schemaTableNames, TABLE_RECOVERY,
  type MigrationEntry, type RecoveryClass, type StoredSecret,
} from "../restore-drill.js";

const arg = (name: string, fallback?: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const message = (error: unknown) => error instanceof Error ? error.message : "unknown error";

const dumpArg = arg("dump");
if (!dumpArg) throw new Error("--dump=<backup file> is required (pg_dump --format=custom)");
// pnpm 在包目录中运行脚本，相对路径按调用命令时的目录解析。
const dump = resolve(process.env.INIT_CWD ?? process.cwd(), dumpArg);
const restoreCommand = (arg("pg-restore", "pg_restore") ?? "").trim().split(/\s+/).filter(Boolean);
if (!restoreCommand.length) throw new Error("--pg-restore must not be empty");
const adminUrl = process.env.NYZ_RESTORE_ADMIN_URL?.trim();
if (!adminUrl) throw new Error("NYZ_RESTORE_ADMIN_URL is required: a connection that can CREATE DATABASE and CREATE EXTENSION vector (usually a superuser). DATABASE_URL is never used.");

const migrationsFolder = fileURLToPath(new URL("../../migrations/", import.meta.url));
const failures: string[] = [];
const fail = (text: string) => { failures.push(text); console.error(`✗ ${text}`); };

function databaseUrl(database: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

let child: ChildProcess | undefined;
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
  console.warn("收到中断，停止恢复并删除临时库");
  child?.kill();
});

/** pg_restore 从标准输入读取备份；失败时附上它的最后几行错误输出（不含密码）。 */
function restore(database: string): Promise<void> {
  const url = new URL(adminUrl!);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
  };
  const sslMode = url.searchParams.get("sslmode");
  if (sslMode) env.PGSSLMODE = sslMode;
  const [command, ...prefix] = restoreCommand;
  const args = [...prefix, "--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", `--dbname=${database}`];
  return new Promise((resolve, reject) => {
    const stderr: string[] = [];
    child = spawn(command, args, { env, stdio: ["pipe", "ignore", "pipe"] });
    child.stderr!.on("data", (data: Buffer) => { stderr.push(...data.toString().split(/\r?\n/).filter(Boolean)); stderr.splice(0, Math.max(0, stderr.length - 20)); });
    // pg_restore 提前退出时写入标准输入会报 EPIPE，以退出码为准。
    child.stdin!.on("error", () => undefined);
    const input = createReadStream(dump);
    input.on("error", (error) => { child?.kill(); reject(error); });
    input.pipe(child.stdin!);
    child.on("error", (error) => reject(new Error(`无法运行 ${command}（${message(error)}），用 --pg-restore 指定 pg_restore 命令`)));
    child.on("close", (code) => {
      if (code === 0 && !interrupted) resolve();
      else reject(new Error(interrupted ? "已中断" : `pg_restore 退出码 ${code}${stderr.length ? `：\n${stderr.join("\n")}` : ""}`));
    });
  });
}

async function checkMigrations(db: Pool): Promise<void> {
  const journal = JSON.parse(await readFile(`${migrationsFolder}meta/_journal.json`, "utf8")) as { entries: { tag: string; when: number }[] };
  const entries: MigrationEntry[] = journal.entries.map((entry) => ({ tag: entry.tag, folderMillis: entry.when }));
  const { rows } = await db.query<{ created_at: string }>("SELECT created_at FROM public.__drizzle_migrations ORDER BY created_at");
  const check = compareMigrations(rows.map((row) => Number(row.created_at)), entries);
  const latest = entries.filter((entry) => rows.some((row) => Number(row.created_at) === entry.folderMillis)).at(-1)?.tag ?? "无";
  console.info(`迁移记录：${check.applied} 条，最后一个为 ${latest}，当前代码共 ${entries.length} 个`);
  if (!check.applied) fail("备份中没有迁移记录");
  if (check.unknown.length) fail(`备份中有 ${check.unknown.length} 条当前代码没有的迁移（created_at ${check.unknown.join("、")}），备份来自更新的版本，须用对应版本的代码恢复`);
  if (check.missing.length) fail(`备份缺少早于最后一条记录的迁移：${check.missing.join("、")}，启动时不会再执行`);
  if (check.pending.length) console.info(`  备份之后新增 ${check.pending.length} 个迁移（${check.pending.join("、")}），API/Worker 启动时会自动执行`);
}

async function checkTables(db: Pool): Promise<void> {
  const groups = new Map<RecoveryClass | "unclassified", string[]>();
  for (const table of schemaTableNames()) {
    const recovery = TABLE_RECOVERY[table] ?? "unclassified";
    let line: string;
    try {
      const { rows: [row] } = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM public."${table}"`);
      line = `${table.padEnd(20)} ${row.total}`;
    } catch (error) {
      fail(`读取表 ${table} 失败：${message(error)}`);
      line = `${table.padEnd(20)} 读取失败`;
    }
    groups.set(recovery, [...groups.get(recovery) ?? [], line]);
  }
  console.info("各表行数：");
  for (const recovery of [...Object.keys(RECOVERY_CLASS_LABELS) as RecoveryClass[], "unclassified" as const]) {
    const lines = groups.get(recovery);
    if (!lines) continue;
    console.info(`  ${recovery === "unclassified" ? "未归类" : RECOVERY_CLASS_LABELS[recovery]}`);
    for (const line of lines) console.info(`    ${line}`);
  }
  const { rows: [admins] } = await db.query<{ total: number }>("SELECT count(*)::int AS total FROM public.admin_accounts WHERE is_super");
  if (!admins.total) console.warn("  备份中没有超级管理员：恢复后 API 启动时按 ADMIN_EMAIL/ADMIN_PASSWORD 重新初始化");
}

/** 已向量化的文档须有同样数量的带向量切片；不一致说明备份缺少切片数据（如用 --exclude-table-data 备份），恢复后检索会缺内容。 */
async function checkEmbeddings(db: Pool): Promise<void> {
  const { rows: [row] } = await db.query<{ ready: number; incomplete: number }>(`
    SELECT count(*)::int AS ready, count(*) FILTER (WHERE d.embedding_chunk_count <> (
      SELECT count(*) FROM public.document_chunks c WHERE c.document_id = d.id AND c.embedding IS NOT NULL))::int AS incomplete
    FROM public.documents d WHERE d.embedding_status = 'ready'`);
  if (row.incomplete) fail(`已向量化的 ${row.ready} 篇文档中有 ${row.incomplete} 篇缺少切片或向量`);
  else console.info(`已向量化文档 ${row.ready} 篇，切片与向量齐全`);
}

async function checkStoredSecrets(db: Pool): Promise<void> {
  const [{ rows: providers }, { rows: settings }] = await Promise.all([
    db.query<{ id: string; name: string; ciphertext: string }>("SELECT id, name, api_key_ciphertext AS ciphertext FROM public.model_providers WHERE api_key_ciphertext IS NOT NULL ORDER BY name"),
    db.query<{ name: string; ciphertext: string }>("SELECT name, ciphertext FROM public.secret_settings ORDER BY name"),
  ]);
  const secrets: StoredSecret[] = [
    ...providers.map((row) => ({ label: `模型供应商「${row.name}」`, ciphertext: row.ciphertext, context: providerSecretContext(row.id) })),
    ...settings.map((row) => ({ label: `密钥设置 ${row.name}`, ciphertext: row.ciphertext, context: row.name })),
  ];
  if (!secrets.length) {
    console.info("备份中没有加密保存的密钥");
    return;
  }
  const results = checkSecrets(secrets);
  const broken = results.filter((result) => result.error);
  for (const result of broken) fail(`${result.label}：${result.error}`);
  if (!broken.length) console.info(`加密保存的密钥 ${results.length} 个，均可用当前 NYZ_SECRET_KEY 解密`);
}

const database = drillDatabaseName();
const admin = new Pool({ connectionString: adminUrl, max: 1 });
let created = false;
try {
  const { size } = await stat(dump);
  if (!size) throw new Error(`${dump} is empty`);
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  created = true;
  console.info(`临时库 ${database}：恢复 ${dump}（${(size / 1024 / 1024).toFixed(1)} MB）`);
  const started = performance.now();
  if (interrupted) throw new Error("已中断");
  await restore(database);
  console.info(`恢复完成，用时 ${Math.round((performance.now() - started) / 1000)}s`);

  const db = new Pool({ connectionString: databaseUrl(database), max: 1 });
  try {
    for (const [label, check] of [["迁移记录", checkMigrations], ["表行数", checkTables], ["切片与向量", checkEmbeddings], ["密钥", checkStoredSecrets]] as const) {
      try { await check(db); } catch (error) { fail(`检查${label}失败：${message(error)}`); }
    }
  } finally {
    await db.end();
  }
  if (failures.length) console.error(`演练未通过：${failures.length} 项问题`);
  else console.info("演练通过");
} catch (error) {
  fail(message(error));
} finally {
  if (created) {
    if (!RESTORE_DRILL_DATABASE.test(database)) throw new Error(`Refusing to drop ${database}`);
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      console.info(`已删除临时库 ${database}`);
    } catch (error) {
      fail(`删除临时库失败（${message(error)}），请手动执行 DROP DATABASE "${database}" WITH (FORCE)`);
    }
  }
  await admin.end();
  if (failures.length) process.exitCode = 1;
}
