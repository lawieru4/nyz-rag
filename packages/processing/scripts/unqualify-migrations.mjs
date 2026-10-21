// drizzle-kit 生成的外键写死了 "public" schema，而建表语句不带 schema、跟随 search_path。
// 去掉该前缀，使整套表可以建在任意 schema（集成测试使用临时 schema）。
import { readdir, readFile, writeFile } from "node:fs/promises";

const directory = new URL("../migrations/", import.meta.url);
for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql"))) {
  const path = new URL(file, directory);
  const sql = await readFile(path, "utf8");
  const unqualified = sql.replaceAll('REFERENCES "public".', "REFERENCES ");
  if (unqualified !== sql) await writeFile(path, unqualified);
}
