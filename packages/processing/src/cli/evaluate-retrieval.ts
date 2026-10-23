import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { evaluateRetrieval, filterSplit, rankOffline, readEvaluationDataset, SPLITS, validateEvaluationDataset, type DatasetValidationOptions, type Split } from "../evaluation.js";
import { getDb, closeDatabase } from "../db.js";
import { documents } from "../schema.js";
import { keywordSearchChunks } from "../repository.js";
import { searchTerms } from "../search-terms.js";
import { eq, inArray } from "drizzle-orm";

const arg = (name: string, fallback?: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

// Resolve defaults relative to this file so the script works regardless of cwd
// (pnpm scripts run from the package directory, not the workspace root).
const packageDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageDir, "../../../..");

const defaultDataset = join(repoRoot, "packages/processing/test/evaluation/retrieval-dataset.json");
const defaultArticleOut = join(repoRoot, ".nyz-data/nyz-articles");

const datasetPath = resolve(arg("dataset") ?? defaultDataset);
const mode = arg("mode") ?? "offline";
// --corpus overrides the default clean-article directory for offline ranking and validation.
const corpusArg = arg("corpus");
const ks = [...new Set((arg("k") ?? "1,3,5,10").split(",").map(Number))];

if (ks.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error("--k must contain only positive integers");
if (mode !== "offline" && mode !== "db") throw new Error(`Unknown --mode=${mode}; use offline or db`);
const split = arg("split") as Split | undefined;
if (split !== undefined && !SPLITS.includes(split)) throw new Error("--split must be dev or test");

// 先校验完整数据集（ID 唯一等），再按 --split 取子集。
const fullDataset = await readEvaluationDataset(datasetPath);
const dataset = filterSplit(fullDataset, split);
if (!dataset.questions.length) throw new Error(`No questions in split ${split}`);

// --- Offline mode: rank using a stable keyword baseline against local clean files. ---
// DB mode: query the actual indexed corpus; local files are optional (for validation only if --corpus is given).
const rankings = new Map<string, string[]>();

if (mode === "offline") {
  const cleanDir = resolve(corpusArg ?? join(process.env.NYZ_ARTICLE_OUT ?? defaultArticleOut, "clean"));
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

} else {
  // DB mode: use ready documents in the actual database as the corpus.
  // No local files are required unless --corpus is passed for additional evidence validation.
  const db = getDb();
  try {
    // Fetch all ready externalIds so evaluateRetrieval can compute correct corpus coverage.
    const readyRows = await db.select({ externalId: documents.externalId }).from(documents).where(eq(documents.status, "ready"));
    const dbCorpusKeys = readyRows.map((row) => row.externalId).filter((id): id is string => Boolean(id));

    // Missing DB documents are coverage gaps, not malformed labels; report them in metrics.
    const validationOptions: DatasetValidationOptions = {};
    if (corpusArg) {
      // Optional: if caller provides a local corpus dir for evidence validation, load it.
      const files = (await readdir(corpusArg)).filter((file) => file.endsWith(".json"));
      const localCorpus = await Promise.all(files.map(async (file) => {
        const article = JSON.parse(await readFile(join(corpusArg, file), "utf8")) as { articleKey: string; title: string; summary?: string; plainText?: string; blocks?: Array<{ text?: string }> };
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
