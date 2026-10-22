// 基于已清洗文章评估现有 RAG 管线：语料特征、切片策略对比、关键词检索代理测试。
// 用法：node scripts/nyz-articles/analyze.mjs [--pages=11-20]（按列表页筛选，报告写入 report-pages-11-20.json）
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const outDir = resolve(process.env.NYZ_ARTICLE_OUT ?? ".nyz-data/nyz-articles");
const pages = process.argv.find((arg) => arg.startsWith("--pages="))?.slice(8).split("-").map(Number);
const index = JSON.parse(await readFile(join(outDir, "index.json"), "utf8"));
const selected = pages ? new Set(index.articles.filter((item) => item.listPage >= pages[0] && item.listPage <= (pages[1] ?? pages[0])).map((item) => `${item.articleKey}.json`)) : null;
const files = (await readdir(join(outDir, "clean"))).filter((file) => file.endsWith(".json") && (!selected || selected.has(file)));
const articles = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(outDir, "clean", file), "utf8"))));
const raws = new Map(await Promise.all(files.map(async (file) => [file.replace(".json", ""), JSON.parse(await readFile(join(outDir, "raw", file), "utf8"))])));

const quantiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
  return { min: sorted[0] ?? 0, p10: at(0.1), p50: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? 0, mean: Math.round(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)) };
};
const count = (values) => values.reduce((map, value) => { map[value] = (map[value] ?? 0) + 1; return map; }, {});
const top = (map, n = 15) => Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n));
const pct = (part, whole) => whole ? `${(part / whole * 100).toFixed(1)}%` : "0%";
const sentenceEnd = /[。！？!?；;…」”）)\]】]$/;

// ---------- 语料特征 ----------
const lengths = articles.map((article) => article.plainText.length);
const textBlocks = (article) => article.blocks.filter((block) => block.type !== "image" && block.type !== "media");
// 参与检索的块：排除相关阅读与链接/参考章节。
const ragBlocks = (article) => textBlocks(article).filter((block) => block.role === "content" || block.role === "questions");
const headingFrequency = count(articles.flatMap((article) => [...new Set(article.blocks.filter((block) => block.type === "heading").map((block) => block.text))]));
const headingCounts = articles.map((article) => article.blocks.filter((block) => block.type === "heading").length);
const hashGroups = Object.values(articles.reduce((map, article) => { (map[article.contentHash] ??= []).push(article.articleKey); return map; }, {})).filter((group) => group.length > 1);
const titleGroups = Object.values(articles.reduce((map, article) => { (map[article.title] ??= []).push(article.articleKey); return map; }, {})).filter((group) => group.length > 1);
const thin = articles.filter((article) => article.plainText.length < 300);
const corpus = {
  articles: articles.length,
  plainTextChars: { total: lengths.reduce((a, b) => a + b, 0), ...quantiles(lengths) },
  blockTypes: count(articles.flatMap((article) => article.blocks.map((block) => block.type))),
  headingsPerArticle: quantiles(headingCounts),
  articlesWithoutHeadings: headingCounts.filter((value) => value === 0).length,
  headingLevels: count(articles.flatMap((article) => article.blocks.filter((block) => block.type === "heading").map((block) => `h${block.level}`))),
  maxSectionDepth: Math.max(0, ...articles.flatMap((article) => article.blocks.map((block) => block.sectionPath.length))),
  blockChars: quantiles(articles.flatMap((article) => textBlocks(article).map((block) => block.text.length))),
  images: { total: articles.reduce((sum, article) => sum + article.images.length, 0), perArticle: quantiles(articles.map((article) => article.images.length)), withCaption: articles.reduce((sum, article) => sum + article.images.filter((image) => image.caption).length, 0) },
  imageHeavy: articles.filter((article) => article.images.length >= 3 && article.plainText.length / article.images.length < 200).map((article) => ({ key: article.articleKey, title: article.title, chars: article.plainText.length, images: article.images.length })),
  thinArticles: thin.map((article) => ({ key: article.articleKey, title: article.title, chars: article.plainText.length, images: article.images.length, attachments: article.attachments.length })),
  attachments: { articlesWithAttachments: articles.filter((article) => article.attachments.length).length, total: articles.reduce((sum, article) => sum + article.attachments.length, 0), extensions: count(articles.flatMap((article) => article.attachments.map((item) => (item.originalName?.split(".").pop() ?? "?").toLowerCase()))) },
  media: count(articles.flatMap((article) => article.media.map((item) => item.fileType ?? "?"))),
  sectionRoleChars: articles.reduce((map, article) => { for (const block of textBlocks(article)) map[block.role] = (map[block.role] ?? 0) + block.text.length; return map; }, {}),
  articlesWithRole: Object.fromEntries(["related", "reference", "questions"].map((role) => [role, articles.filter((article) => article.blocks.some((block) => block.role === role)).length])),
  templatedHeadings: Object.fromEntries(Object.entries(headingFrequency).filter(([, value]) => value >= 3).sort((a, b) => b[1] - a[1])),
  demotedHeadings: articles.reduce((sum, article) => sum + article.demotedHeadings, 0),
  doi: articles.filter((article) => article.doi).length,
  relatedLinks: { total: articles.reduce((sum, article) => sum + article.relatedArticleKeys.length, 0), inCorpus: articles.reduce((sum, article) => sum + article.relatedArticleKeys.filter((key) => articles.some((other) => other.articleKey === key)).length, 0) },
  vip: articles.filter((article) => article.isVIP).length,
  original: articles.filter((article) => article.original).length,
  unknownNodeTypes: count(articles.flatMap((article) => article.unknownNodeTypes)),
  unknownMarkTypes: count(articles.flatMap((article) => article.unknownMarkTypes)),
  skipped: articles.reduce((sum, article) => sum + article.skipped.length, 0),
  duplicateContent: hashGroups,
  duplicateTitles: titleGroups,
  categories: top(count(articles.map((article) => article.category ?? "无"))),
  tags: top(count(articles.flatMap((article) => article.tags))),
  authors: top(count(articles.map((article) => article.author ?? "无")), 10),
  publishedRange: [articles.map((article) => article.publishedAt).sort()[0], articles.map((article) => article.publishedAt).sort().at(-1)],
  // 本解析器纯文本与接口自带字段的长度比，用于确认解析无明显丢失。
  sourceMeta: {
    articles: articles.filter((article) => article.sourceMeta).length,
    generators: count(articles.map((article) => article.sourceMeta?.generator).filter(Boolean)),
    repostSources: top(count(articles.map((article) => article.sourceMeta?.repostSource).filter(Boolean)), 10),
    keywords: { total: articles.reduce((sum, article) => sum + (article.sourceMeta?.keywords.length ?? 0), 0), unique: new Set(articles.flatMap((article) => article.sourceMeta?.keywords ?? [])).size, top: top(count(articles.flatMap((article) => article.sourceMeta?.keywords ?? [])), 12) },
    scenarios: top(count(articles.flatMap((article) => article.sourceMeta?.scenarios ?? [])), 12),
  },
  projectDigests: articles.filter((article) => /^项目名称：/.test(article.blocks.find((block) => block.text)?.text ?? "")).length,
  // 现有 /api/chat 回答取正文前 180 字；统计其中以元信息开头的比例。
  currentAnswerStartsWithMeta: pct(articles.filter((article) => { const head = article.blocks.filter((block) => block.type !== "image" && block.type !== "media").map((block) => block.text).join(" ").slice(0, 180); return /^(作者|项目名称)：/.test(head); }).length, articles.length),
  latinCharShare: quantiles(articles.map((article) => Math.round((article.plainText.match(/[A-Za-z]/g)?.length ?? 0) / article.plainText.length * 100))),
  parsedVsApiText: quantiles(articles.map((article) => { const raw = raws.get(article.articleKey); return raw?.text?.length ? Math.round(article.plainText.length / raw.text.length * 100) : 0; })),
  apiTextHasNoSeparators: articles.filter((article) => { const raw = raws.get(article.articleKey); return raw?.text && !/\n/.test(raw.text) && article.blocks.length > 3; }).length,
};

// 近似重复：正文 5 字片段集合的 Jaccard 相似度。
const shingles = articles.map((article) => {
  const text = ragBlocks(article).map((block) => block.text).join("").replace(/\s+/g, "");
  const set = new Set();
  for (let index = 0; index + 5 <= text.length; index += 1) set.add(text.slice(index, index + 5));
  return set;
});
corpus.nearDuplicates = [];
for (let left = 0; left < articles.length; left += 1) {
  for (let right = left + 1; right < articles.length; right += 1) {
    const [small, large] = shingles[left].size < shingles[right].size ? [shingles[left], shingles[right]] : [shingles[right], shingles[left]];
    let shared = 0;
    for (const item of small) if (large.has(item)) shared += 1;
    const jaccard = shared / (small.size + large.size - shared || 1);
    if (jaccard >= 0.2) corpus.nearDuplicates.push({ jaccard: Number(jaccard.toFixed(2)), articles: [articles[left], articles[right]].map((article) => ({ key: article.articleKey, title: article.title.slice(0, 40), publishedAt: article.publishedAt?.slice(0, 10) })) });
  }
}
corpus.nearDuplicates.sort((a, b) => b.jaccard - a.jaccard);

// ---------- 切片对比 ----------
// A：现有 Worker 逻辑——正文空白折叠为单个空格后，按 800 字符窗口、120 重叠切分，无标题上下文。
function currentChunks(article) {
  const spans = [];
  let content = "";
  for (const block of textBlocks(article)) {
    const text = block.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (content) content += " ";
    spans.push({ start: content.length, end: content.length + text.length, block });
    content += text;
  }
  const chunks = [];
  for (let start = 0; start < content.length; start += 800 - 120) {
    const value = content.slice(start, start + 800).trim();
    if (!value) continue;
    const end = Math.min(content.length, start + 800);
    const covered = spans.filter((span) => span.end > start && span.start < end);
    chunks.push({
      chars: value.length,
      sections: new Set(covered.map((span) => span.block.sectionPath.join(" > "))).size,
      startsMidSentence: start > 0 && !sentenceEnd.test(content.slice(0, start).trimEnd()),
      endsMidSentence: end < content.length && !sentenceEnd.test(value),
      noise: covered.some((span) => span.block.role === "related" || span.block.role === "reference"),
      questions: covered.some((span) => span.block.role === "questions"),
      splitsTable: covered.some((span) => span.block.type === "table" && (span.start < start || span.end > end)),
      hasTitle: value.includes(article.title.slice(0, 12)),
    });
  }
  return chunks;
}

// B：结构化切片——同章节内按块累积至约 800 字，超长块按句切分，前缀文章标题与章节路径。
function structuredChunks(article, target = 800, minimum = 200) {
  const chunks = [];
  let buffer = [];
  let section = null;
  const flush = () => {
    if (!buffer.length) return;
    const body = buffer.join("\n");
    const prefix = `文章标题：${article.title}\n${section ? `章节：${section}\n` : ""}`;
    chunks.push({ chars: body.length, contextChars: prefix.length + body.length, section, text: `${prefix}${body}` });
    buffer = [];
  };
  for (const block of ragBlocks(article)) {
    const path = block.sectionPath.join(" > ") || null;
    if (path !== section) {
      // 过短的上一节合并到下一节，避免碎片。
      if (buffer.join("\n").length >= minimum) flush();
      section = path;
    }
    // 标题也计入正文：部分章节下只有图片，标题是唯一的文字信息。
    const pieces = block.text.length > target ? block.text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [block.text] : [block.text];
    for (const piece of pieces) {
      if (buffer.join("\n").length + piece.length > target && buffer.length) flush();
      buffer.push(piece);
    }
  }
  flush();
  return chunks;
}

const current = articles.map((article) => ({ article, chunks: currentChunks(article) }));
const structured = articles.map((article) => ({ article, chunks: structuredChunks(article) }));
const flatCurrent = current.flatMap((item) => item.chunks);
const flatStructured = structured.flatMap((item) => item.chunks);
const chunking = {
  current: {
    strategy: "空白折叠 + 800 字符窗口 / 120 重叠，无上下文前缀",
    chunks: flatCurrent.length,
    perArticle: quantiles(current.map((item) => item.chunks.length)),
    chars: quantiles(flatCurrent.map((chunk) => chunk.chars)),
    crossSection: pct(flatCurrent.filter((chunk) => chunk.sections > 1).length, flatCurrent.length),
    startsMidSentence: pct(flatCurrent.filter((chunk) => chunk.startsMidSentence).length, flatCurrent.length),
    endsMidSentence: pct(flatCurrent.filter((chunk) => chunk.endsMidSentence).length, flatCurrent.length),
    containsTitle: pct(flatCurrent.filter((chunk) => chunk.hasTitle).length, flatCurrent.length),
    splitsTable: flatCurrent.filter((chunk) => chunk.splitsTable).length,
    containsRelatedOrReference: pct(flatCurrent.filter((chunk) => chunk.noise).length, flatCurrent.length),
    containsEditorQuestions: pct(flatCurrent.filter((chunk) => chunk.questions).length, flatCurrent.length),
    under200: flatCurrent.filter((chunk) => chunk.chars < 200).length,
    singleChunkArticles: current.filter((item) => item.chunks.length <= 1).length,
  },
  structured: {
    strategy: "排除相关阅读/本文链接；同章节累积至约 800 字，过短章节并入下一节，超长段按句切分，前缀标题与章节",
    chunks: flatStructured.length,
    perArticle: quantiles(structured.map((item) => item.chunks.length)),
    chars: quantiles(flatStructured.map((chunk) => chunk.chars)),
    contextChars: quantiles(flatStructured.map((chunk) => chunk.contextChars)),
    under200: flatStructured.filter((chunk) => chunk.chars < 200).length,
    withSection: pct(flatStructured.filter((chunk) => chunk.section).length, flatStructured.length),
  },
  // 粗略估算：中文约 1 字 ≈ 1～1.5 token。
  embeddingInputChars: { current: flatCurrent.reduce((sum, chunk) => sum + chunk.chars, 0), structured: flatStructured.reduce((sum, chunk) => sum + chunk.contextChars, 0) },
};

// ---------- 检索代理测试 ----------
// 现有 /api/chat：非重叠中文二元组 + 英文数字词；文档级“包含即 +1”计分；稳定排序取前 3。
const currentTerms = (value) => value.toLowerCase().match(/[a-z0-9]+|[一-鿿]{2}/gi) ?? [];
function currentRank(query) {
  const terms = currentTerms(query);
  return articles.map((article) => {
    const haystack = `${article.title} ${article.plainText}`.toLowerCase();
    return { key: article.articleKey, score: terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0) };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).map((item) => item.key);
}

// 对照：重叠二元组 + BM25，在结构化切片上检索，按文章去重。
const bigrams = (value) => {
  const lower = value.toLowerCase();
  const terms = lower.match(/[a-z0-9]+/g) ?? [];
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) terms.push(run);
    for (let index = 0; index < run.length - 1; index += 1) terms.push(run.slice(index, index + 2));
  }
  return terms;
};
const chunkIndex = structured.flatMap(({ article, chunks }) => chunks.map((chunk) => ({ key: article.articleKey, terms: bigrams(chunk.text) })));
const documentFrequency = new Map();
for (const chunk of chunkIndex) for (const term of new Set(chunk.terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
const averageLength = chunkIndex.reduce((sum, chunk) => sum + chunk.terms.length, 0) / chunkIndex.length;
for (const chunk of chunkIndex) chunk.tf = chunk.terms.reduce((map, term) => map.set(term, (map.get(term) ?? 0) + 1), new Map());
function bm25Rank(query) {
  const terms = [...new Set(bigrams(query))];
  const scored = chunkIndex.map((chunk) => {
    let score = 0;
    for (const term of terms) {
      const tf = chunk.tf.get(term);
      if (!tf) continue;
      const df = documentFrequency.get(term);
      const idf = Math.log(1 + (chunkIndex.length - df + 0.5) / (df + 0.5));
      score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * chunk.terms.length / averageLength));
    }
    return { key: chunk.key, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  return [...new Set(scored.map((item) => item.key))];
}

const genericHeading = /^(导语|前言|引言|结语|总结|小结|结论|写在最后|参考|参考文献|附录|目录|摘要|概述|背景|end|\d+|[一二三四五六七八九十]+、?)$/i;
const queries = [];
for (const article of articles) {
  // 出现在 3 篇及以上文章的模板标题不作为问题。
  const headings = article.blocks.filter((block) => block.type === "heading" && block.role === "content" && headingFrequency[block.text] < 3).map((block) => block.text.replace(/^[\d一二三四五六七八九十]+[、.｜|：:\s]+/, "").trim()).filter((text) => text.length >= 6 && !genericHeading.test(text));
  for (const heading of headings.slice(0, 3)) queries.push({ kind: "章节标题", query: heading, key: article.articleKey });
  const summary = article.summary?.split(/[。！？]/)[1]?.trim();
  if (summary && summary.length >= 10) queries.push({ kind: "摘要句", query: summary, key: article.articleKey });
}
function evaluate(rank) {
  const result = {};
  for (const kind of [...new Set(queries.map((query) => query.kind))]) {
    const group = queries.filter((query) => query.kind === kind);
    const positions = group.map((query) => rank(query.query).indexOf(query.key));
    result[kind] = { queries: group.length, top1: pct(positions.filter((position) => position === 0).length, group.length), top3: pct(positions.filter((position) => position >= 0 && position < 3).length, group.length), miss: pct(positions.filter((position) => position < 0).length, group.length) };
  }
  return result;
}
const retrieval = {
  note: "代理测试：以章节标题和摘要第二句为问题，期望命中所属文章；只衡量词面召回，不代表语义检索效果",
  currentKeyword: evaluate(currentRank),
  bm25OverlappingBigrams: evaluate(bm25Rank),
  currentTermsExample: { query: "固态电池中试线样品测试", terms: currentTerms("固态电池中试线样品测试"), overlapping: bigrams("固态电池中试线样品测试") },
};

const report = { generatedAt: new Date().toISOString(), corpus, chunking, retrieval };
await writeFile(join(outDir, pages ? `report-pages-${pages.join("-")}.json` : "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
