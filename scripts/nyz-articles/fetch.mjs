// 逐篇获取 nyzdata 文章：列表分页 → 单篇详情 → 立即清洗并保存。已保存的文章跳过，可断点续跑。
// 用法：NYZ_ARTICLE_TOKEN=... node scripts/nyz-articles/fetch.mjs [数量=100]
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArticle } from "./parse.mjs";

const token = process.env.NYZ_ARTICLE_TOKEN?.trim();
if (!token) throw new Error("NYZ_ARTICLE_TOKEN is required");
const limit = Number.parseInt(process.argv[2] ?? "100", 10);
const tagKey = process.env.NYZ_ARTICLE_TAG_KEY ?? "9302258412";
const perPage = 10;
const delayMs = Number.parseInt(process.env.NYZ_ARTICLE_DELAY_MS ?? "1500", 10);
const baseUrl = "https://nyzdata.nenghe.com/nyzfoxx";
const outDir = resolve(process.env.NYZ_ARTICLE_OUT ?? ".nyz-data/nyz-articles");
const dirs = { raw: join(outDir, "raw"), clean: join(outDir, "clean"), markdown: join(outDir, "markdown") };

async function getJson(path, params) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries({ token, ...params })) url.searchParams.set(key, String(value));
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: "application/json" } });
  // 错误信息不包含 URL，避免 token 泄露到日志。
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  const body = await response.json();
  if (body.status !== 200) throw new Error(`API status ${body.status} (${body.msg}) for ${path}`);
  return body.data;
}

const exists = (path) => access(path).then(() => true, () => false);

await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
const indexPath = join(outDir, "index.json");
const index = await readFile(indexPath, "utf8").then(JSON.parse, () => ({ articles: [], failures: [] }));
const done = new Set(index.articles.map((item) => item.articleKey));

let page = 1;
let listed = 0;
while (index.articles.length < limit) {
  const list = await getJson("/article", { tagKey, type: 2, sort: "desc", curPage: page, perPage });
  if (page === 1) index.total = list.total;
  if (!list.list?.length) break;
  for (const item of list.list) {
    if (index.articles.length >= limit) break;
    listed += 1;
    const key = item._key;
    if (done.has(key) && await exists(join(dirs.clean, `${key}.json`))) continue;
    await delay(delayMs);
    try {
      const detail = await getJson("/article/articleDetail", { articleKey: key });
      if (detail.invalidToken) throw new Error("invalidToken=true");
      await writeFile(join(dirs.raw, `${key}.json`), JSON.stringify(detail, null, 2));
      const article = parseArticle(detail);
      await writeFile(join(dirs.clean, `${key}.json`), JSON.stringify(article, null, 2));
      await writeFile(join(dirs.markdown, `${key}.md`), `# ${article.title}\n\n${article.markdown}\n`);
      index.articles.push({ articleKey: key, title: article.title, listPage: page, chars: article.plainText.length, blocks: article.blocks.length, unknownNodeTypes: article.unknownNodeTypes });
      index.failures = index.failures.filter((failure) => failure.articleKey !== key);
      done.add(key);
      console.info(`[${index.articles.length}/${limit}] ${key} ${article.title.slice(0, 40)} (${article.plainText.length} 字, ${article.blocks.length} 块${article.unknownNodeTypes.length ? `, 未知节点 ${article.unknownNodeTypes.join(",")}` : ""})`);
    } catch (error) {
      index.failures = [...index.failures.filter((failure) => failure.articleKey !== key), { articleKey: key, title: item.title, error: error.message }];
      console.error(`失败 ${key} ${item.title?.slice(0, 40)}: ${error.message}`);
    }
    await writeFile(indexPath, JSON.stringify(index, null, 2));
  }
  page += 1;
  await delay(delayMs);
}
index.finishedAt = new Date().toISOString();
await writeFile(indexPath, JSON.stringify(index, null, 2));
console.info(`完成：成功 ${index.articles.length} 篇，失败 ${index.failures.length} 篇，浏览列表 ${listed} 条，标签下共 ${index.total} 篇`);
