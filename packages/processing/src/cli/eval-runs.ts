// 检索评估运行记录的定位与读取，evaluate:compare 与 evaluate:adjudicate 共用；不连接数据库。
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_SCHEMA_VERSION, type RunRecord } from "../evaluation-run.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const runsDir = join(repoRoot, ".nyz-data/eval-runs");

/** ref 为运行名（取 .nyz-data/eval-runs/ 中该名称最新的一次）或运行记录的路径。 */
export async function loadRunRecord(ref: string): Promise<{ path: string; run: RunRecord }> {
  // pnpm 在包目录运行脚本，相对路径按调用命令时的目录解析。
  const direct = resolve(process.env.INIT_CWD ?? process.cwd(), ref);
  let path = ref.endsWith(".json") && existsSync(direct) ? direct : undefined;
  if (!path) {
    const matches = existsSync(runsDir) ? (await readdir(runsDir)).filter((file) => file.match(/^\d{8}-\d{6}-(.+)\.json$/)?.[1] === ref).sort() : [];
    if (!matches.length) throw new Error(`Run not found: ${ref} (expected a run name in .nyz-data/eval-runs or a path to a run record)`);
    path = join(runsDir, matches.at(-1)!);
  }
  const run = JSON.parse(await readFile(path, "utf8")) as RunRecord;
  if (run.schemaVersion !== RUN_SCHEMA_VERSION) throw new Error(`Unsupported run record schemaVersion ${String(run.schemaVersion)}: ${path}`);
  return { path, run };
}
