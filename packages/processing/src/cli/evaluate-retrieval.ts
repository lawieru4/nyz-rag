// 用法：pnpm --filter @nyz-rag/processing evaluate:retrieval [--mode=offline|db] [--dataset=<路径>] [--split=dev|test] [--k=1,3,5,10]
//       pnpm --filter @nyz-rag/processing evaluate:retrieval --mode=hybrid --dataset=<路径> --name=<运行名> [--split=dev|test] [--variant=keyword,vector,summary,fused,rerank]
//         [--context=topk|budget|section] [--schema=eval_<名称>] [--concurrency=1] [--limit=N]
// offline / db 为关键词冒烟测试；hybrid 调用问答使用的 retrieve()（业务模型配置中的 Embedding、Rerank 与最近创建的知识库参数），
// 按变体消融，--context 选择回答上下文的组装方式，--schema 改用 evaluate:index 建立的实验索引；
// 运行记录保存到 .nyz-data/eval-runs/<时间>-<运行名>.json，用 evaluate:compare 对比。方案见 docs/evaluation-plan.md。
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, dirname } from "node:path";
import { eq, inArray } from "drizzle-orm";
import {
  evaluateRetrieval, filterSplit, normalizeEvidenceText, rankOffline, readEvaluationDataset, SPLITS, validateEvaluationDataset,
  type DatasetValidationOptions, type EvaluationDataset, type EvaluationQuestion, type Split,
} from "../evaluation.js";
import {
  CONTEXT_MODES, failedResult, HIT_KS, percentile, RANKING_DEPTH, RETRIEVAL_VARIANTS, RUN_SCHEMA_VERSION, runVariant, sourceLabels, summarizeVariant,
  type ContextMode, type RetrievalVariant, type RunQuestion, type RunRecord,
} from "../evaluation-run.js";
import { getDb, closeDatabase } from "../db.js";
import { closeModelAdmissionLimiter } from "../model-admission.js";
import { createEmbeddingModel, createRerankModel } from "../models.js";
import { usableModel } from "../provider.js";
import { DEFAULT_RETRIEVAL_SETTINGS, type RetrievalDependencies, type RetrievalSettings } from "../rag.js";
import { documents } from "../schema.js";
import { getModelSelections, keywordSearchChunks, listKnowledgeBases, listSectionContexts, summarySearchChunks, vectorSearchChunks } from "../repository.js";
import { searchTerms } from "../search-terms.js";
import { evidenceSource } from "../synthetic-questions.js";
import { loadCorpus, useEvaluationSchema, withRetry } from "./evaluation-corpus.js";

const arg = (name: string, fallback?: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

// Resolve defaults relative to this file so the script works regardless of cwd
// (pnpm scripts run from the package directory, not the workspace root).
const packageDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageDir, "../../../..");

const defaultDataset = join(repoRoot, "packages/processing/test/evaluation/retrieval-dataset.json");
const defaultArticleOut = join(repoRoot, ".nyz-data/nyz-articles");
const runsDir = join(repoRoot, ".nyz-data/eval-runs");

// pnpm 在包目录运行脚本，相对路径按调用命令时的目录解析。
const invocationDir = process.env.INIT_CWD ?? process.cwd();
const datasetPath = resolve(invocationDir, arg("dataset") ?? defaultDataset);
const mode = arg("mode") ?? "offline";
// --corpus overrides the default clean-article directory for offline ranking and validation.
const corpusArg = arg("corpus");
const ks = [...new Set((arg("k") ?? "1,3,5,10").split(",").map(Number))];

if (ks.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("--k must contain only positive integers");
if (mode !== "offline" && mode !== "db" && mode !== "hybrid") throw new Error(`Unknown --mode=${mode}; use offline, db or hybrid`);
const split = arg("split") as Split | undefined;
if (split !== undefined && !SPLITS.includes(split)) throw new Error("--split must be dev or test");

// 先校验完整数据集（ID 唯一等），再按 --split 取子集。
const fullDataset = await readEvaluationDataset(datasetPath);
const dataset = filterSplit(fullDataset, split);
if (!dataset.questions.length) throw new Error(`No questions in split ${split}`);

// --- Offline mode: rank using a stable keyword baseline against local clean files. ---
async function offline() {
  const rankings = new Map<string, string[]>();
  const cleanDir = resolve(invocationDir, corpusArg ?? join(process.env.NYZ_ARTICLE_OUT ?? defaultArticleOut, "clean"));
  const files = (await readdir(cleanDir)).filter((file) => file.endsWith(".json")).sort();
  const corpus = await Promise.all(files.map(async (file) => {
    const article = JSON.parse(await readFile(join(cleanDir, file), "utf8")) as { articleKey: string; title: string; summary?: string; plainText?: string; blocks?: Array<{ text?: string }> };
    return { articleKey: article.articleKey, title: article.title, text: `${article.summary ?? ""}\n${article.plainText ?? article.blocks?.map((block) => block.text ?? "").join(" ") ?? ""}` };
  }));
  const evidenceByArticle = new Map(corpus.map((article) => [article.articleKey, article.text]));
  const errors = validateEvaluationDataset(dataset, { corpusArticleKeys: evidenceByArticle.keys(), evidenceByArticle });
  if (errors.length) throw new Error(`Evaluation dataset invalid:\n${errors.join("\n")}`);
  for (const question of dataset.questions) rankings.set(question.id, rankOffline(question.question, corpus));
  // Keyword baseline: lexical term overlap; not a hybrid retrieval system.
  console.log(JSON.stringify({ dataset: dataset.name, mode, retrieval: "keyword-baseline", metrics: evaluateRetrieval(dataset, rankings, ks, evidenceByArticle.keys()) }, null, 2));
}

// --- DB mode: keyword retrieval over the indexed corpus; local files are optional (for validation only if --corpus is given). ---
async function keywordDb() {
  const rankings = new Map<string, string[]>();
  const db = getDb();
  try {
    // Fetch all ready externalIds so evaluateRetrieval can compute correct corpus coverage.
    const readyRows = await db.select({ externalId: documents.externalId }).from(documents).where(eq(documents.status, "ready"));
    const dbCorpusKeys = readyRows.map((row) => row.externalId).filter((id): id is string => Boolean(id));

    // Missing DB documents are coverage gaps, not malformed labels; report them in metrics.
    const validationOptions: DatasetValidationOptions = {};
    if (corpusArg) {
      // Optional: if caller provides a local corpus dir for evidence validation, load it.
      const files = (await readdir(resolve(invocationDir, corpusArg))).filter((file) => file.endsWith(".json"));
      const localCorpus = await Promise.all(files.map(async (file) => {
        const article = JSON.parse(await readFile(join(resolve(invocationDir, corpusArg), file), "utf8")) as { articleKey: string; title: string; summary?: string; plainText?: string; blocks?: Array<{ text?: string }> };
        return { articleKey: article.articleKey, text: `${article.summary ?? ""}\n${article.plainText ?? article.blocks?.map((block) => block.text ?? "").join(" ") ?? ""}` };
      }));
      validationOptions.evidenceByArticle = new Map(localCorpus.map((a) => [a.articleKey, a.text]));
    }

    const errors = validateEvaluationDataset(dataset, validationOptions);
    if (errors.length) throw new Error(`Evaluation dataset invalid:\n${errors.join("\n")}`);

    // Keyword retrieval over the indexed tsvector terms; not hybrid (no vector search here).
    for (const question of dataset.questions) {
      const hits = await keywordSearchChunks(searchTerms(question.question), Math.max(20, ...ks), db);
      const ids = hits.map((hit) => hit.documentId);
      const rows = ids.length ? await db.select({ id: documents.id, externalId: documents.externalId }).from(documents).where(inArray(documents.id, ids)) : [];
      const external = new Map(rows.map((row) => [row.id, row.externalId]).filter((row): row is [string, string] => Boolean(row[1])));
      rankings.set(question.id, ids.map((id) => external.get(id) ?? `document:${id}`));
    }

    const metrics = evaluateRetrieval(dataset, rankings, ks, dbCorpusKeys);
    console.log(JSON.stringify({ dataset: dataset.name, mode, retrieval: "keyword-db", metrics }, null, 2));
    if (metrics.missingRelevantDocs) {
      console.error("Incomplete database corpus: metrics cover only available labeled documents and are not a complete baseline.");
      process.exitCode = 1;
    }
  } finally { await closeDatabase(); }
}

// --- Hybrid mode ---

const message = (error: unknown) => error instanceof Error ? error.message : "unknown error";

function parseVariants(raw: string | undefined): RetrievalVariant[] {
  const values = [...new Set((raw ?? RETRIEVAL_VARIANTS.join(",")).split(",").map((value) => value.trim()).filter(Boolean))];
  const unknown = values.filter((value) => !RETRIEVAL_VARIANTS.includes(value as RetrievalVariant));
  if (unknown.length || !values.length) throw new Error(`--variant must be a comma-separated subset of ${RETRIEVAL_VARIANTS.join(",")}`);
  return RETRIEVAL_VARIANTS.filter((variant) => values.includes(variant));
}

const stamp = (date: Date) => date.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[-:]/g, "").replace(" ", "-");
const percent = (value: number | null) => value === null ? "  -  " : `${(value * 100).toFixed(1).padStart(5)}`;

async function hybrid() {
  const runName = arg("name");
  if (!runName || !/^[a-z0-9][a-z0-9-]*$/.test(runName)) throw new Error("--name is required (lowercase letters, digits and dashes), e.g. --name=baseline");
  const variants = parseVariants(arg("variant"));
  const concurrency = Number(arg("concurrency", "1"));
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error("--concurrency must be a positive integer");
  // --limit 只取前 N 道题，用于冒烟测试，不作为基线。
  const limit = arg("limit") === undefined ? undefined : Number(arg("limit"));
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");
  const contextMode = arg("context", "topk") as ContextMode;
  if (!CONTEXT_MODES.includes(contextMode)) throw new Error(`--context must be one of ${CONTEXT_MODES.join(", ")}`);
  const schema = arg("schema");
  if (schema) useEvaluationSchema(schema);
  const selected = dataset.questions.slice(0, limit);
  const errors = validateEvaluationDataset(fullDataset);
  if (errors.length) throw new Error(`Evaluation dataset invalid:\n${errors.join("\n")}`);

  try {
    const { articles, snapshot } = await loadCorpus();
    const byKey = new Map(articles.map((article) => [article.articleKey, article]));
    const keyOf = new Map(articles.map((article) => [article.documentId, article.articleKey]));
    const articleKeyOf = (documentId: string) => keyOf.get(documentId) ?? `document:${documentId}`;

    const [knowledgeBase] = await listKnowledgeBases();
    const settings: RetrievalSettings = knowledgeBase
      ? { topK: knowledgeBase.topK, similarityThreshold: knowledgeBase.similarityThreshold, rerankEnabled: knowledgeBase.rerankEnabled, maxContextLength: knowledgeBase.maxContextLength }
      : DEFAULT_RETRIEVAL_SETTINGS;
    const selections = await getModelSelections();
    const embeddingSelection = usableModel(selections.embedding);
    const rerankSelection = usableModel(selections.rerank);
    if (variants.some((variant) => variant !== "keyword") && !embeddingSelection) throw new Error("未配置可用的 Embedding 模型，只能运行 --variant=keyword");
    if (variants.includes("rerank") && !rerankSelection) throw new Error("未配置可用的 Rerank 模型，请去掉 rerank 变体");
    const embedding = embeddingSelection && variants.some((variant) => variant !== "keyword") ? createEmbeddingModel(embeddingSelection) : null;
    const reranker = rerankSelection && variants.includes("rerank") ? createRerankModel(rerankSelection) : null;

    const corpusChanged = Boolean(dataset.corpus && dataset.corpus.fingerprint !== snapshot.fingerprint);
    if (corpusChanged) console.warn("语料快照与数据集生成时不同：来源文章被删除或证据已不在原文中的题目将排除在指标之外。");
    if (embedding && snapshot.embeddingModel && embedding.model !== snapshot.embeddingModel) console.warn(`Embedding 模型 ${embedding.model} 与语料的 ${snapshot.embeddingModel} 不同，向量召回只比较同一模型的切片。`);
    const incomplete = snapshot.embeddingCoverage < 1;
    if (incomplete) console.warn(`向量化覆盖率 ${(snapshot.embeddingCoverage * 100).toFixed(2)}%，运行结果标记为不完整。`);
    if (contextMode === "section" && snapshot.chunkerVersion !== 2) console.warn("语料不是全部按父子块（切片规则 2）切分，没有父块的切片按切片放入上下文。");

    // 来源文章被删除或证据已不在原文中（含标题与元数据线索）的题目排除，标注到「文章 + 证据」，与切片无关。
    const staleReason = (question: EvaluationQuestion) => {
      for (const label of sourceLabels(question)) {
        const article = byKey.get(label.articleKey);
        if (!article) return `来源文章 ${label.articleKey} 不在语料中`;
        const source = normalizeEvidenceText(evidenceSource(article, question.type === "metadata" ? "metadata" : "fact"));
        if (label.evidence.some((text) => !source.includes(normalizeEvidenceText(text)))) return `证据已不在来源文章 ${label.articleKey} 中`;
      }
      return undefined;
    };
    const entries: Array<[RunQuestion, EvaluationQuestion]> = selected.map((question) => {
      const excluded = staleReason(question);
      return [{
        id: question.id, question: question.question, type: question.type, split: question.split,
        ...(question.specificity ? { specificity: question.specificity } : {}),
        ...(question.lexicalOverlap !== undefined ? { lexicalOverlap: question.lexicalOverlap } : {}),
        sourceArticleKeys: sourceLabels(question).map((label) => label.articleKey),
        ...(excluded ? { excluded } : {}),
        results: {},
      }, question];
    });
    const excluded = entries.filter(([entry]) => entry.excluded);
    if (excluded.length) console.warn(`因语料变化排除 ${excluded.length} 道题：${excluded.map(([entry]) => `${entry.id}（${entry.excluded}）`).join("；")}`);

    console.info(`数据集 ${dataset.name}@${dataset.version}，${split ?? "全部"} ${selected.length} 道题；变体 ${variants.join(", ")}；`
      + `知识库 ${knowledgeBase?.name ?? "（默认参数）"} topK=${settings.topK} 阈值=${settings.similarityThreshold} 上下文 ${contextMode}/${settings.maxContextLength} 字；`
      + `Embedding ${embedding?.model ?? "-"}，Rerank ${reranker?.model ?? "-"}；索引 ${schema ?? "业务库"}（切片规则 ${snapshot.chunkerVersion ?? "1"}）`);

    async function processQuestion([entry, question]: [RunQuestion, EvaluationQuestion]) {
      if (entry.excluded) return;
      // 同一道题的各变体共用一次查询 Embedding，与 API 一致；先算好向量，retrieve() 耗时不含 Embedding。
      let vector: number[] | null = null;
      if (embedding) {
        const started = performance.now();
        try {
          vector = await withRetry(() => embedding.embedQuery(question.question));
          entry.embeddingMs = Math.round((performance.now() - started) * 10) / 10;
        } catch (error) {
          entry.error = `查询 Embedding 失败：${message(error)}`;
          return;
        }
      }
      const dependencies: RetrievalDependencies = {
        keywordSearch: (terms, limit) => keywordSearchChunks(terms, limit),
        ...(vector && embedding ? {
          vectorSearch: (_text: string, limit: number) => vectorSearchChunks(vector, embedding.model, limit),
          summarySearch: (_text: string, limit: number) => summarySearchChunks(vector, embedding.model, limit),
        } : {}),
        ...(reranker ? { rerank: (query: string, texts: string[], topN: number) => withRetry(() => reranker.rerank(query, texts, topN)) } : {}),
      };
      for (const variant of variants) {
        try { entry.results[variant] = await runVariant(question, variant, settings, dependencies, articleKeyOf, { mode: contextMode, loadSections: (ids) => listSectionContexts(ids) }); }
        catch (error) { entry.results[variant] = failedResult(message(error)); }
      }
    }

    const queue = [...entries];
    let done = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        await processQuestion(item);
        done += 1;
        if (done % 25 === 0 || done === entries.length) console.info(`[${done}/${entries.length}]`);
      }
    }));

    const questions = entries.map(([entry]) => entry);
    const embeddingTimes = questions.flatMap((question) => question.embeddingMs === undefined ? [] : [question.embeddingMs]);
    const createdAt = new Date();
    const record: RunRecord = {
      schemaVersion: RUN_SCHEMA_VERSION,
      name: runName,
      createdAt: createdAt.toISOString(),
      dataset: {
        name: dataset.name, version: dataset.version, path: relative(repoRoot, datasetPath).replaceAll("\\", "/"), split: split ?? "all", questions: selected.length, ...(limit ? { limit } : {}),
        corpusFingerprint: dataset.corpus?.fingerprint ?? null, ...(dataset.generation ? { generation: dataset.generation } : {}),
      },
      corpus: snapshot,
      corpusChanged,
      incomplete,
      settings: {
        knowledgeBase: knowledgeBase ? { id: knowledgeBase.id, name: knowledgeBase.name } : null, retrieval: settings, rankingDepth: RANKING_DEPTH, context: contextMode, ...(schema ? { schema } : {}),
      },
      models: {
        embedding: embedding && embeddingSelection ? { provider: embeddingSelection.provider.name, model: embedding.model } : null,
        rerank: reranker && rerankSelection ? { provider: rerankSelection.provider.name, model: reranker.model } : null,
      },
      variants,
      summary: Object.fromEntries(variants.map((variant) => [variant, summarizeVariant(questions, variant)])),
      embedding: { p50: percentile(embeddingTimes, 0.5), p95: percentile(embeddingTimes, 0.95), failures: questions.filter((question) => question.error).length },
      questions,
    };
    await mkdir(runsDir, { recursive: true });
    const out = join(runsDir, `${stamp(createdAt)}-${runName}.json`);
    await writeFile(out, `${JSON.stringify(record)}\n`);
    printSummary(record, dataset);
    console.info(`运行记录：${out}`);
  } finally {
    await closeModelAdmissionLimiter();
    await closeDatabase();
  }
}

function printSummary(record: RunRecord, data: EvaluationDataset) {
  const header = ["变体    ", ...HIT_KS.map((k) => `Hit@${k}`.padStart(6)), "   MRR", "  证据", "全证据", "上下文", "  字数", " p50ms", " p95ms", " 题数", " 降级", " 失败", " 深度不足"];
  console.info(`\n${data.name}@${data.version}（${record.dataset.split}，上下文 ${record.settings.context ?? "topk"}）指标（%，字数为上下文平均字数）：`);
  console.info(header.join(" "));
  for (const variant of record.variants) {
    const { overall, latency, reliability } = record.summary[variant]!;
    console.info([
      variant.padEnd(8), ...HIT_KS.map((k) => percent(overall.hitAt[String(k)]).padStart(6)), percent(overall.mrr).padStart(6), percent(overall.evidenceHit).padStart(6), percent(overall.evidenceFull).padStart(6), percent(overall.contextHit).padStart(6),
      String(Math.round(overall.contextChars ?? 0)).padStart(6),
      String(Math.round(latency.p50 ?? 0)).padStart(6), String(Math.round(latency.p95 ?? 0)).padStart(6),
      String(reliability.evaluated).padStart(5), String(reliability.degraded).padStart(5), String(reliability.errors).padStart(5), String(reliability.shallowRanking).padStart(9),
    ].join(" "));
  }
  console.info(`查询 Embedding p50 ${Math.round(record.embedding.p50 ?? 0)}ms / p95 ${Math.round(record.embedding.p95 ?? 0)}ms，失败 ${record.embedding.failures} 道；因语料变化排除 ${record.questions.filter((question) => question.excluded).length} 道。按划分、题型、具体度与词面重叠分组的指标见运行记录的 summary。`);
}

if (mode === "offline") await offline();
else if (mode === "db") await keywordDb();
else await hybrid();
