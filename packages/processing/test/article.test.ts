import assert from "node:assert/strict";
import test from "node:test";
import { ArticleApiError, createArticleClient, type ArticleListItem } from "../src/article/client.js";
import { PARSER_VERSION, parseArticle, type ArticleDetail } from "../src/article/parse.js";
import { syncArticles } from "../src/article/sync.js";
import { articleQuestions, chunkArticle, chunkArticleWith, chunkBlocks, chunkSections, embeddingInput, estimateTokens, LEGACY_CHUNKER_VERSION, SECTION_CHUNKER_VERSION, type ChunkBlock } from "../src/chunking.js";
import { prepareDocument } from "../src/prepare.js";

const text = (value: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: object[]) => ({ type: "paragraph", content });
const heading = (level: number, value: string) => ({ type: "heading", attrs: { level }, content: [text(value)] });
const link = (label: string, href: string) => text(label, [{ type: "link", attrs: { href } }]);

function detail(content: object[], extra: Partial<ArticleDetail> = {}): ArticleDetail {
  return {
    _key: "1001", title: " 清华大学某团队EES｜固态电池新进展 ", content: JSON.stringify({ type: "doc", content }), createTime: Date.UTC(2026, 9, 1), updateTime: Date.UTC(2026, 9, 2),
    summary: "摘要文字", tagName: "科研", tagArray: [{ name: "固态电池" }], creator: { nickName: "新能源小王" }, ...extra,
  };
}

const sample = detail([
  { type: "blockquote", content: [paragraph(text("作者：qwen3.6-plus"), { type: "hardBreak" }, text("转载源：电化学能源@微信公众号"), { type: "hardBreak" }, text("关键词：[[固态电池]]、[[硫化物电解质]]"), { type: "hardBreak" }, text("场景：[[材料发现]]"))] },
  paragraph(text("硫化物固态电解质具有高离子电导率。"), text("Na₀.₉MnO₂", [{ type: "subscript" }])),
  heading(2, "【工作要点】"),
  { type: "orderedList", content: [{ type: "listItem", content: [paragraph(text("提出新型界面层。"))] }, { type: "listItem", content: [paragraph(text("循环寿命提升。"))] }] },
  heading(2, "图1展示了材料的结构表征与电化学性能对比结果："),
  { type: "wrapDiv", attrs: { class: "center" }, content: [{ type: "image", attrs: { src: "https://cdn.test/1.png" } }, paragraph(text("图1 结构表征"))] },
  { type: "table", content: [
    { type: "tableRow", content: [{ type: "tableHeader", content: [paragraph(text("样品"))] }, { type: "tableHeader", content: [paragraph(text("容量"))] }] },
    { type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("A"))] }, { type: "tableCell", content: [paragraph(text("150 mAh/g"))] }] },
  ] },
  heading(2, "【本文链接】"),
  paragraph(link("https://doi.org/10.1039/d6sc05687c", "https://doi.org/10.1039/d6sc05687c")),
  heading(2, "延伸思考"),
  paragraph(text("1\\. 界面层如何抑制副反应？")),
  paragraph(text("2. 如何放大到工业级？")),
  heading(2, "相关阅读"),
  paragraph(link("另一篇文章", "/ArticleDetail?id=2002")),
  { type: "mysteryNode", content: [paragraph(text("未知节点里的文字"))] },
]);

test("parseArticle extracts metadata, roles, links and demotes sentence headings", () => {
  const article = parseArticle(sample);
  assert.equal(article.title, "清华大学某团队EES｜固态电池新进展");
  assert.deepEqual(article.sourceMeta, { generator: "qwen3.6-plus", repostSource: "电化学能源@微信公众号", keywords: ["固态电池", "硫化物电解质"], scenarios: ["材料发现"] });
  assert.equal(article.doi, "10.1039/d6sc05687c");
  assert.deepEqual(article.relatedArticleKeys, ["2002"]);
  assert.equal(article.demotedHeadings, 1);
  assert.equal(article.images[0].caption, "图1 结构表征");
  assert.deepEqual(article.unknownNodeTypes, ["mysteryNode"]);
  assert.equal(article.blocks[0].role, "meta");
  assert.equal(article.blocks.find((block) => block.type === "table")?.role, "content");
  assert.ok(article.blocks.filter((block) => block.text.includes("界面层如何")).every((block) => block.role === "questions"));
  assert.ok(article.blocks.filter((block) => block.text.includes("另一篇文章")).every((block) => block.role === "related"));
  assert.match(article.markdown, /<sub>Na₀\.₉MnO₂<\/sub>/);
  assert.equal(article.publishedAt, "2026-10-01T00:00:00.000Z");
  assert.throws(() => parseArticle({ _key: "1", content: "{}" }), /ProseMirror/);
});

test("article chunks exclude meta, related, reference and questions and carry context", () => {
  const article = parseArticle(sample);
  const chunks = chunkArticle("doc", article);
  const all = chunks.map((chunk) => chunk.content).join("\n");
  assert.doesNotMatch(all, /qwen3\.6-plus|doi\.org|另一篇文章|界面层如何/);
  assert.match(all, /图1展示了材料的结构表征/, "demoted heading text is kept");
  assert.match(all, /样品 \| 容量/);
  assert.equal(chunks[0].id, "doc-1");
  assert.match(chunks[0].context, /^文章：清华大学某团队EES｜固态电池新进展\n/);
  assert.match(chunks[0].context, /关键词：固态电池、硫化物电解质/);
  assert.ok(embeddingInput(chunks[0]).startsWith(chunks[0].context));
  assert.deepEqual(articleQuestions(article), ["界面层如何抑制副反应？", "如何放大到工业级？"]);

  const update = prepareDocument("doc", { rawJson: sample }).update;
  assert.equal(update.title, "清华大学某团队EES｜固态电池新进展");
  assert.doesNotMatch(update.content, /qwen3\.6-plus/);
  assert.equal(update.metadata?.followUpQuestions.length, 2);
  assert.equal(update.metadata?.sourceMeta?.repostSource, "电化学能源@微信公众号");
  assert.deepEqual(update.tags, ["固态电池"]);

  const imageOnly = parseArticle(detail([{ type: "image", attrs: { src: "https://cdn.test/a.png" } }]));
  assert.deepEqual(chunkArticle("img", imageOnly).map((chunk) => chunk.content), ["摘要文字"]);
});

test("project intro paragraphs become metadata without entering body chunks", () => {
  const rawJson = detail([
    paragraph(text("项目名称：", [{ type: "bold" }]), text(" Lithium-Sulfur Batteries（锂硫电池），项目编号 bat230")),
    paragraph(text("项目负责人： A. Smith（National Lab）")),
    paragraph(text("承担单位： National Lab；合作单位 University A")),
    paragraph(text("关键词： [[锂硫电池]]，[[聚合物，复合电解质]]，[[锂硫电池]]")),
    paragraph(),
    heading(2, "项目概述"),
    paragraph(text("开发高能量密度电池，提高循环寿命。")),
  ]);
  const article = parseArticle(rawJson);
  assert.deepEqual(article.projectMeta, {
    name: "Lithium-Sulfur Batteries（锂硫电池），项目编号 bat230",
    principal: "A. Smith（National Lab）",
    institution: "National Lab；合作单位 University A",
    keywords: ["锂硫电池", "聚合物，复合电解质"],
  });
  assert.equal(article.sourceMeta, null);
  assert.ok(article.blocks.slice(0, 4).every((block) => block.role === "meta"));
  assert.match(article.markdown, /项目负责人/, "full Markdown remains available for source inspection");
  assert.doesNotMatch(article.plainText, /\[\[/);
  const { update, chunks } = prepareDocument("project", { rawJson });
  assert.equal(update.parserVersion, PARSER_VERSION);
  assert.deepEqual(update.metadata?.projectMeta, article.projectMeta);
  assert.doesNotMatch(update.content, /项目名称|项目负责人|承担单位|关键词|bat230/);
  assert.match(update.content, /开发高能量密度电池/);
  assert.doesNotMatch(chunks.map((chunk) => chunk.content).join("\n"), /A\. Smith|National Lab|关键词/);
  assert.match(chunks[0].context, /关键词：锂硫电池、聚合物，复合电解质/);
  assert.deepEqual(prepareDocument("project", { rawJson }), { update, chunks, sections: [] }, "rule 1 has no sections");
});

test("project intro supports multiline blocks, ASCII colons and plain keywords", () => {
  const lines = ["项目名称: Battery project", "项目负责人: A. Smith", "关键词: 锂硫电池, 固态电池；锂硫电池"];
  const containers = [
    paragraph(text(lines.join("\n"))),
    { type: "blockquote", content: lines.map((line) => paragraph(text(line))) },
    { type: "bulletList", content: lines.map((line) => ({ type: "listItem", content: [paragraph(text(line, [{ type: "bold" }]))] })) },
  ];
  for (const container of containers) {
    const article = parseArticle(detail([container, paragraph(text("项目概述正文"))]));
    assert.deepEqual(article.projectMeta, { name: "Battery project", principal: "A. Smith", institution: null, keywords: ["锂硫电池", "固态电池"] });
    assert.equal(article.blocks[0].role, "meta");
    assert.equal(article.blocks[1].role, "content");
  }
});

test("project extraction preserves ambiguous or non-intro body text", () => {
  const fields = [paragraph(text("项目名称：测试项目")), paragraph(text("承担单位：测试单位"))];
  for (const content of [
    [fields[0], paragraph(text("普通正文"))],
    [paragraph(text("项目名称：测试项目\n承担单位：测试单位\n不能丢失的正文"))],
    [paragraph(text("普通正文")), ...fields],
    [heading(2, "项目对比"), ...fields],
    [paragraph(text("关键词：电池")), paragraph(text("普通正文"))],
    [paragraph(text("项目名称：测试项目\n项目名称：另一项目\n承担单位：测试单位"))],
    [{ type: "codeBlock", content: [text("项目名称：测试项目\n承担单位：测试单位")] }],
  ]) {
    const article = parseArticle(detail(content));
    assert.equal(article.projectMeta, null);
    assert.ok(article.blocks.every((block) => block.role === "content"));
  }
  const repeated = parseArticle(detail([...fields, paragraph(text("项目名称：另一项目")), paragraph(text("正文内容"))]));
  assert.equal(repeated.projectMeta?.name, "测试项目");
  assert.equal(repeated.blocks[2].role, "content");
  assert.equal(parseArticle(sample).projectMeta, null);
});

test("article title metadata is stored without changing title, content or chunk context", () => {
  const title = "浙江大学范修林、上海交通大学邓涛AM：三阴离子协同溶剂化重塑双电层";
  const rawJson = detail([paragraph(text("有效正文"))], { title });
  const { update, chunks } = prepareDocument("title", { rawJson });
  assert.deepEqual(update.metadata?.titleMeta, { journal: "Advanced Materials", journalAbbreviation: "AM", institutions: ["浙江大学", "上海交通大学"] });
  assert.equal(update.title, title);
  assert.equal(update.content, "有效正文");
  assert.ok(chunks[0].context.startsWith(`文章：${title}`));
  assert.equal(prepareDocument("plain", { rawJson: detail([paragraph(text("正文"))], { title: "电芯寿命衰减的机理" }) }).update.metadata?.titleMeta, null);
});

test("project and repost metadata coexist and merge keyword context without duplicates", () => {
  const rawJson = detail([
    { type: "blockquote", content: [paragraph(text("作者：qwen\n转载源：原始来源\n关键词：[[电池]]\n场景：[[研发]]"))] },
    paragraph(text("项目名称：电池项目")),
    paragraph(text("承担单位：研究院")),
    paragraph(text("关键词：[[电池]]、[[硫正极]]")),
    paragraph(text("有效正文")),
  ]);
  const { update, chunks } = prepareDocument("project", { rawJson });
  assert.equal(update.metadata?.sourceMeta?.repostSource, "原始来源");
  assert.equal(update.metadata?.projectMeta?.institution, "研究院");
  assert.equal(update.content, "有效正文");
  assert.match(chunks[0].context, /关键词：电池、硫正极$/);
});

test("chunkBlocks keeps sections apart, merges short sections, keeps tables and splits long text", () => {
  const long = "句子很长。".repeat(300);
  const chunks = chunkBlocks("d", [
    { kind: "text", text: "短", sectionPath: ["一"] },
    { kind: "text", text: "甲".repeat(300), sectionPath: ["二"] },
    { kind: "text", text: "乙".repeat(300), sectionPath: ["三"] },
    { kind: "table", text: ["表头 | 值", ...Array.from({ length: 30 }, (_, index) => `行${index} | ${index}`)].join("\n"), sectionPath: ["三"] },
    { kind: "text", text: long, sectionPath: ["四"] },
  ], { title: "T" }, { targetChars: 400, minChars: 200 });
  assert.equal(chunks[0].content, `短\n${"甲".repeat(300)}`, "short section merges into the next one");
  assert.deepEqual(chunks[0].sectionPath, ["二"]);
  assert.equal(chunks[1].content, "乙".repeat(300), "sections with enough text are not mixed");
  assert.equal(chunks[2].contentType, "table");
  assert.ok(chunks[2].content.startsWith("表头 | 值") && chunks[2].content.includes("行29 | 29"), "table fits within twice the target and stays whole");
  const tail = chunks.slice(3);
  assert.ok(tail.every((chunk) => chunk.content.length <= 400 && chunk.content.endsWith("。")), "long text splits at sentence ends");
  assert.equal(tail.map((chunk) => chunk.content).join(""), long);
  // 没有句末标点的行（如长列表）按行切分，不丢字，换行保留。
  const list = Array.from({ length: 60 }, (_, index) => `第${index}项没有句号`).join("\n");
  const listChunks = chunkBlocks("p", [{ kind: "text", text: list, sectionPath: [] }], { title: "T" }, { targetChars: 200 });
  assert.ok(listChunks.length > 1 && listChunks.every((chunk) => chunk.content.length <= 200));
  assert.equal(listChunks.map((chunk) => chunk.content).join("\n"), list);

  const bigTable = ["H1 | H2", ...Array.from({ length: 200 }, (_, index) => `r${index} | v${index}`)].join("\n");
  const tableChunks = chunkBlocks("t", [{ kind: "table", text: bigTable, sectionPath: [] }], { title: "T" }, { targetChars: 300 });
  assert.ok(tableChunks.length > 1 && tableChunks.every((chunk) => chunk.content.startsWith("H1 | H2\n")), "oversized tables repeat the header");
});

test("chunkSections keeps short sections, splits long ones and groups blocks into children", () => {
  const title = (value: string, sectionPath: string[]): ChunkBlock => ({ kind: "text", text: value, sectionPath, heading: true });
  const body = (value: string, sectionPath: string[]): ChunkBlock => ({ kind: "text", text: value, sectionPath });
  const { sections, chunks } = chunkSections("d", [
    body("引导段落。", []),
    title("一、方法", ["一、方法"]),
    title("1.1 材料", ["一、方法", "1.1 材料"]),
    body("甲".repeat(300), ["一、方法", "1.1 材料"]),
    body("乙".repeat(150), ["一、方法", "1.1 材料"]),
    body("丙".repeat(100), ["一、方法", "1.1 材料"]),
    title("小结", ["小结"]),
    body("短。", ["小结"]),
    title("小结", ["小结"]),
    body("另一处同名章节。", ["小结"]),
  ], { title: "T", keywords: ["锂"] });
  assert.deepEqual(sections.map((section) => section.sectionPath.join(">")), ["", "一、方法>1.1 材料", "小结", "小结"], "repeated headings stay apart");
  assert.equal(sections[1].content, `一、方法\n1.1 材料\n${"甲".repeat(300)}\n${"乙".repeat(150)}\n${"丙".repeat(100)}`, "heading-only sections join the next one");
  assert.equal(sections[2].content, "小结\n短。", "short sections keep their own parent");
  const children = chunks.filter((chunk) => chunk.sectionId === sections[1].id);
  assert.deepEqual(children.map((chunk) => chunk.content), [`一、方法\n1.1 材料\n${"甲".repeat(300)}`, `${"乙".repeat(150)}\n${"丙".repeat(100)}`]);
  assert.ok(chunks.every((chunk) => chunk.context === `文章：T\n${chunk.sectionPath.length ? `章节：${chunk.sectionPath.join(" > ")}\n` : ""}关键词：锂`));
  assert.deepEqual(chunks.map((chunk) => chunk.index), chunks.map((_, index) => index));

  // 超长章节按内容块边界分段；超长段落按句切分且不丢字（含没有句末标点的行）；表格单独成块，超长时重复表头。
  const paragraphs = Array.from({ length: 12 }, (_, index) => body(`第${index}段${"字".repeat(300)}。`, ["长"]));
  const long = chunkSections("l", paragraphs, { title: "T" });
  assert.ok(long.sections.length === 2 && long.sections.every((section) => section.content.length <= 2000));
  assert.deepEqual(long.sections.map((section) => section.part), [0, 1]);
  assert.equal(long.sections.map((section) => section.content).join("\n"), paragraphs.map((block) => block.text).join("\n"));
  const list = Array.from({ length: 100 }, (_, index) => `第${index}项没有句号`).join("\n");
  const split = chunkSections("p", [body(list, ["列表"])], { title: "T" });
  assert.ok(split.chunks.length > 1 && split.chunks.every((chunk) => chunk.content.length <= 600));
  assert.equal(split.chunks.map((chunk) => chunk.content).join("\n"), list);
  const table = ["H1 | H2", ...Array.from({ length: 200 }, (_, index) => `r${index} | v${index}`)].join("\n");
  const tables = chunkSections("t", [body("表前说明文字".repeat(10), ["表"]), { kind: "table", text: table, sectionPath: ["表"] }], { title: "T" });
  const tableChunks = tables.chunks.filter((chunk) => chunk.contentType === "table");
  assert.ok(tableChunks.length > 1 && tableChunks.every((chunk) => chunk.content.startsWith("H1 | H2\n")));
  assert.equal(tables.chunks[0].contentType, "text", "tables do not merge with long enough text");
});

test("chunkArticleWith keeps rule 1 without sections and uses the summary for image-only articles", () => {
  const article = parseArticle(detail([heading(2, "背景"), paragraph(text("正文内容"))]));
  assert.deepEqual(chunkArticleWith(LEGACY_CHUNKER_VERSION, "doc", article), { sections: [], chunks: chunkArticle("doc", article).map((chunk) => ({ ...chunk, sectionId: null })) });
  const imageOnly = parseArticle(detail([{ type: "image", attrs: { src: "https://example.test/a.png" } }], { summary: "摘要文字" }));
  const sectioned = chunkArticleWith(SECTION_CHUNKER_VERSION, "img", imageOnly);
  assert.deepEqual([sectioned.sections.map((section) => section.content), sectioned.chunks.map((chunk) => chunk.content)], [["摘要文字"], ["摘要文字"]]);
});

test("estimateTokens counts CJK characters individually and other text by length", () => {
  assert.equal(estimateTokens("中文abc defg"), 2 + 2);
});

function fakeFetch(handler: (url: URL) => { status?: number; body: unknown }) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: URL) => {
    calls.push(input);
    const { status = 200, body } = handler(input);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test("article client builds URLs, keeps the token out of errors and stops on invalid tokens", async () => {
  const token = "secret-token-value";
  assert.throws(() => createArticleClient({ listUrl: "https://x.test/api/article?token=abc", token }), /不能包含 token/);
  assert.throws(() => createArticleClient({ listUrl: "https://x.test/api/article", token: " " }), (error: unknown) => error instanceof ArticleApiError && error.fatal);

  const { calls, fetchImpl } = fakeFetch((url) => url.pathname.endsWith("/articleDetail")
    ? url.searchParams.get("articleKey") === "bad" ? { body: { status: 200, data: { _key: "bad", invalidToken: true } } } : { status: 500, body: {} }
    : { body: { status: 200, data: { list: [{ _key: "1" }], total: 1 } } });
  const client = createArticleClient({ listUrl: "https://x.test/api/article?tagKey=9", token, fetch: fetchImpl });
  assert.deepEqual(await client.list(3, 10), { items: [{ _key: "1" }], total: 1 });
  assert.equal(calls[0].pathname, "/api/article");
  assert.deepEqual(Object.fromEntries(calls[0].searchParams), { tagKey: "9", curPage: "3", perPage: "10", type: "2", sort: "desc", token });
  await assert.rejects(client.detail("bad"), (error: unknown) => error instanceof ArticleApiError && error.fatal);
  assert.equal(calls[1].pathname, "/api/article/articleDetail");
  assert.equal(calls[1].searchParams.get("tagKey"), null);
  await assert.rejects(client.detail("x"), (error: unknown) => error instanceof ArticleApiError && !error.fatal && !error.message.includes(token));
  assert.equal(client.articleUrl("42"), "https://x.test/ArticleDetail?id=42");
});

function listClient(pages: ArticleListItem[][], total = pages.flat().length) {
  const requested: number[] = [];
  return { requested, client: { list: async (page: number) => { requested.push(page); return { items: pages[page - 1] ?? [], total }; } } };
}
const items = (from: number, count: number, updateTime = 1): ArticleListItem[] => Array.from({ length: count }, (_, index) => ({ _key: String(from + index), updateTime }));

test("syncArticles skips unchanged pinned items, stops after quiet pages and resumes backfill", async () => {
  const pages = [[{ _key: "pinned", updateTime: 1, top: 1 }, ...items(1, 2)], items(3, 3), items(6, 3), items(9, 3), items(12, 3)];
  const known = new Map<string, number | null>([["pinned", 1], ...items(1, 14).map((item) => [item._key, 1] as [string, number])]);
  const processed: string[] = [];
  const base = { known, limit: 100, overlapPages: 2, pause: async () => {}, process: async (item: ArticleListItem) => { processed.push(item._key); } };

  // 回填已完成：只扫描到连续 2 页无变化为止。
  let saved = {};
  let run = listClient(pages);
  await syncArticles({ ...base, client: run.client, state: { backfillDone: true }, saveState: async (state) => { saved = state; } });
  assert.deepEqual(run.requested, [1, 2]);
  assert.deepEqual(processed, []);

  // 更新时间变化的已知文章会重新处理，即使出现在置顶之后。
  known.set("4", 0);
  run = listClient(pages);
  await syncArticles({ ...base, client: run.client, state: { backfillDone: true }, saveState: async (state) => { saved = state; } });
  assert.deepEqual(processed, ["4"]);
  assert.deepEqual(run.requested, [1, 2, 3, 4]);
  known.set("4", 1);

  // 首次同步达到上限后中断，下次从回填位置继续，并重试失败的文章。
  processed.length = 0;
  const fresh = new Map<string, number | null>();
  let state = {};
  let failOnce = true;
  const process = async (item: ArticleListItem) => {
    if (item._key === "2" && failOnce) { failOnce = false; throw new Error("temporary"); }
    processed.push(item._key);
    fresh.set(item._key, 1);
  };
  run = listClient(pages);
  const progress: Array<{ processed: number; failed: number }> = [];
  let result = await syncArticles({ ...base, known: fresh, limit: 6, process, client: run.client, state, saveState: async (next) => { state = next; }, onProgress: (next) => { progress.push(next); } });
  assert.equal(result.limitReached, true);
  assert.equal(progress.length, 6, "progress is reported after failures too");
  assert.deepEqual(progress.at(-1), { processed: 5, failed: 1 });
  assert.deepEqual(result.failures.map((failure) => failure.articleKey), ["2"]);
  assert.deepEqual(state, { backfillPage: 3, retryKeys: ["2"], remoteTotal: 15 });

  run = listClient(pages);
  result = await syncArticles({ ...base, known: fresh, limit: 100, process, client: run.client, state, saveState: async (next) => { state = next; } });
  assert.equal(result.limitReached, false);
  assert.deepEqual(processed, ["pinned", "1", "3", "4", "5", "2", "6", "7", "8", "9", "10", "11", "12", "13", "14"]);
  assert.deepEqual(state, { backfillDone: true, remoteTotal: 15 });
  assert.deepEqual(saved, { backfillDone: true, remoteTotal: 15 });
});

test("syncArticles aborts on fatal API errors and still saves progress", async () => {
  let state = {};
  const run = listClient([items(1, 3)]);
  await assert.rejects(syncArticles({
    client: run.client, known: new Map(), state: {}, limit: 10, overlapPages: 1, pause: async () => {},
    process: async (item) => { if (item._key === "2") throw new ArticleApiError("token 无效", true); },
    saveState: async (next) => { state = next; },
  }), /token 无效/);
  assert.deepEqual(state, { remoteTotal: 3 });
});
