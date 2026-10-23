import assert from "node:assert/strict";
import { test } from "node:test";
import type { ArticleMetadata } from "@nyz-rag/types";
import { searchTerms } from "../src/search-terms.js";
import {
  assignTargets, checkGenerated, failureCategory, generationMessages, parseGenerated, parseModelJson, parseReview, stratifiedSample, strataFor,
  type CorpusArticle, type GeneratedQuestion, type SampleTarget,
} from "../src/synthetic-questions.js";

const CONTENT = [
  "全固态锂金属电池凭借固态电解质不燃的固有安全优势，成为下一代高能量密度储能体系的候选对象。",
  "测试结果显示，Li(110) 晶面拥有 0.5 MPa 的最低屈服强度以及 6.95 的最高幂律蠕变指数，表现出更强的应力敏感性。",
  "依靠该力-电化学匹配效应，锂剥离容量实现 34%–68% 的提升，能够在界面失效前维持更长时间的共形接触。",
].join("\n\n");

const metadata = (journal: string | null, institutions: string[] = []): ArticleMetadata => ({
  summary: null, cover: null, doi: null, sourceMeta: null, projectMeta: null,
  titleMeta: journal ? { journal, journalAbbreviation: null, institutions } : null,
  relatedArticleKeys: [], followUpQuestions: [], attachments: [], images: [], media: [], isVIP: false, original: false, unknownNodeTypes: [], demotedHeadings: 0,
} as ArticleMetadata);

const article: CorpusArticle = {
  articleKey: "10381285968",
  title: "上海交通大学罗加严ACS Energy Lett.：晶面工程赋能锂金属负极",
  category: "科研",
  content: CONTENT,
  metadata: metadata("ACS Energy Letters", ["上海交通大学"]),
  contentHash: "hash",
};

const target = (overrides: Partial<SampleTarget> = {}): SampleTarget => ({ articleKey: article.articleKey, stratum: "科研/期刊/短", type: "mechanism", specificity: "high", ...overrides });
const generated = (overrides: Partial<GeneratedQuestion> = {}): GeneratedQuestion => ({
  question: "为什么锂的 (110) 晶面在受压时能维持更久的界面接触？",
  answer: "Li(110) 屈服强度最低、蠕变指数最高，蠕变更快，能适配剥离时的锂通量。",
  evidence: ["Li(110) 晶面拥有 0.5 MPa 的最低屈服强度以及 6.95 的最高幂律蠕变指数，表现出更强的应力敏感性。"],
  type: "mechanism",
  specificity: "high",
  ...overrides,
});

const corpus = (count: number): CorpusArticle[] => Array.from({ length: count }, (_, index) => ({
  articleKey: String(10_000 + index),
  title: `文章 ${index}`,
  category: index % 10 < 6 ? "科研" : index % 10 < 9 ? "能学堂" : `小栏目${index % 7}`,
  content: "正".repeat(300 + index * 7),
  metadata: index % 2 ? metadata("Nature Energy", ["清华大学"]) : metadata(null),
  contentHash: String(index),
}));

test("stratified sample is deterministic, proportional and interleaved across strata", () => {
  const articles = corpus(600);
  const first = stratifiedSample(articles, 120, 7);
  assert.deepEqual(first, stratifiedSample(articles, 120, 7));
  assert.notDeepEqual(first, stratifiedSample(articles, 120, 8));
  assert.equal(first.length, 120);
  assert.equal(new Set(first.map((item) => item.articleKey)).size, 120);
  const science = first.filter((item) => item.stratum.startsWith("科研")).length;
  assert.ok(Math.abs(science - 72) <= 3, `科研 ${science}`);
  // 小栏目合并为「其他」，期刊只在科研栏目内区分。
  const strata = strataFor(articles);
  assert.ok([...strata.values()].some((value) => value.startsWith("其他/")));
  assert.ok([...strata.values()].every((value) => !value.startsWith("能学堂/期刊")));
  // 取前 N 篇（试点）时不按层聚集。
  assert.ok(new Set(first.slice(0, 20).map((item) => item.stratum)).size >= 4);
  assert.equal(stratifiedSample(articles.slice(0, 10), 50, 1).length, 10, "sample size is capped by the corpus");
});

test("targets fill constrained types from eligible articles and fix their specificity", () => {
  const articles = corpus(400);
  const byKey = new Map(articles.map((item) => [item.articleKey, item]));
  const sample = stratifiedSample(articles, 200, 3);
  const targets = assignTargets(sample, byKey, 3);
  const by = (type: string) => targets.filter((item) => item.type === type);
  assert.equal(by("metadata").length, 40);
  assert.ok(by("metadata").every((item) => byKey.get(item.articleKey)!.metadata?.titleMeta), "metadata only for articles with clues");
  assert.equal(by("term").length, 0, "no technical terms in the fixture text");
  assert.equal(by("mechanism").length, 50);
  assert.ok([...by("metadata")].every((item) => item.specificity === "high"));
  const flexible = targets.filter((item) => item.type === "fact" || item.type === "mechanism");
  const low = flexible.filter((item) => item.specificity === "low").length;
  assert.ok(Math.abs(low - flexible.length / 2) <= 1, `low ${low} of ${flexible.length}`);
});

test("model JSON is extracted from fences and reasoning and rejected when invalid", () => {
  assert.deepEqual(parseModelJson("<think>先想想 {x}</think>\n```json\n{\"question\": \"q\"}\n```"), { question: "q" });
  assert.throws(() => parseModelJson("没有 JSON"), /没有 JSON/);
  assert.throws(() => parseModelJson("{question: q}"), /无法解析/);
  const parsed = parseGenerated({ question: " 问题 ", answer: "答", evidence: ["a", 1, " "], type: "fact", specificity: "low" });
  assert.deepEqual(parsed.evidence, ["a"]);
  assert.equal(parsed.question, "问题");
});

test("review passes only when every criterion is explicitly true", () => {
  assert.equal(parseReview({ standalone: true, supported: true, faithful: true, specific: true, distinctive: true, natural: true, reason: "" }).passed, true);
  const failed = parseReview({ standalone: true, supported: "true", faithful: true, specific: true, distinctive: true, natural: true, reason: " 证据不足 " });
  assert.equal(failed.passed, false);
  assert.equal(failed.criteria.supported, false);
  assert.equal(failed.reason, "证据不足");
});

test("a well-formed question passes the program checks", () => {
  const result = checkGenerated(generated(), article, target());
  assert.deepEqual(result.failures, []);
  assert.ok(result.lexicalOverlap > 0 && result.lexicalOverlap <= 0.8);
});

test("program checks catch evidence, pronoun, leak, overlap, duplicate and type problems", () => {
  const cases: Array<[Partial<GeneratedQuestion>, Partial<SampleTarget>, string]> = [
    [{ evidence: ["Li(110) 晶面拥有最低的屈服强度和最高的蠕变指数"] }, {}, "证据不在原文中"],
    [{ question: "该研究中锂的 (110) 晶面为什么能维持更久的界面接触？" }, {}, "指代"],
    [{ question: "锂剥离容量提升幅度与 6.95 的蠕变指数有什么关系呢？", answer: "蠕变指数 6.95 使剥离容量提升" }, {}, "泄漏答案"],
    [{ question: "Li(110) 晶面拥有最低屈服强度以及最高幂律蠕变指数的原因是？", specificity: "low" }, { specificity: "low" }, "词面重叠过高"],
    [{ type: "term" }, {}, "题型不符"],
    [{ specificity: "low" }, {}, "具体度不符"],
    [{ question: "为什么？" }, {}, "问题长度"],
    [{ type: "metadata", question: "为什么锂的 (110) 晶面在受压时能维持更久的界面接触？" }, { type: "metadata" }, "缺少线索"],
  ];
  for (const [question, targetOverrides, category] of cases) {
    const { failures } = checkGenerated(generated(question), article, target(targetOverrides));
    assert.ok(failures.map(failureCategory).includes(category), `${category}: ${failures.join("; ")}`);
  }
  const duplicate = checkGenerated(generated(), article, target(), [searchTerms("为什么锂的 (110) 晶面受压时能维持更久的界面接触")]);
  assert.ok(duplicate.failures.map(failureCategory).includes("重复"));
  // 元数据题：包含期刊或机构线索即可，证据也可以摘自标题。
  const metadataQuestion = generated({ type: "metadata", question: "上海交通大学在 ACS Energy Letters 上关于锂晶面的工作发现哪个晶面蠕变最快？", evidence: ["晶面工程赋能锂金属负极"] });
  assert.deepEqual(checkGenerated(metadataQuestion, article, target({ type: "metadata" })).failures, []);
});

test("generation prompt carries the target, clues and retry feedback", () => {
  const [system, user] = generationMessages(article, target({ type: "metadata" }), ["证据不在原文中：…"]);
  assert.equal(system.role, "system");
  assert.match(user.content, /目标题型：metadata/);
  assert.match(user.content, /线索：ACS Energy Letters；上海交通大学/);
  assert.match(user.content, /未通过检查[\s\S]*证据不在原文中/);
  assert.ok(user.content.includes(CONTENT));
});
