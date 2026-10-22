// 解析器升级后从已保存的原始 JSON 重新生成清洗结果，无需再次请求接口。
// 用法：node scripts/nyz-articles/reparse.mjs
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArticle, PARSER_VERSION } from "./parse.mjs";

const outDir = resolve(process.env.NYZ_ARTICLE_OUT ?? ".nyz-data/nyz-articles");
const files = (await readdir(join(outDir, "raw"))).filter((file) => file.endsWith(".json"));
for (const file of files) {
  const article = parseArticle(JSON.parse(await readFile(join(outDir, "raw", file), "utf8")));
  await writeFile(join(outDir, "clean", file), JSON.stringify(article, null, 2));
  await writeFile(join(outDir, "markdown", file.replace(/\.json$/, ".md")), `# ${article.title}\n\n${article.markdown}\n`);
}
console.info(`已用解析器 v${PARSER_VERSION} 重新处理 ${files.length} 篇`);
