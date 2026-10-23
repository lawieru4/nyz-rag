// 用法：pnpm --filter @nyz-rag/processing evaluate:generate --name=<数据集名> [--size=400] [--seed=20261023] [--limit=50] [--concurrency=2]
//       pnpm --filter @nyz-rag/processing evaluate:generate --name=<数据集名> --freeze [--out=<JSON 路径>]
// 按文章生成合成评估题：首次运行冻结语料快照并分层抽样，之后每篇文章用 Chat 模型生成、程序校验、审核模型审核，失败时带原因重试。
// 每次尝试追加到 .nyz-data/evaluation/<名称>/items.jsonl，中断后重新运行从未完成的文章继续；--limit 只处理样本中的前 N 篇（试点）。
// --freeze 在全部样本完成后导出 schemaVersion 2 数据集。方案见 docs/evaluation-plan.md。
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import type { ArticleMetadata } from "@nyz-rag/types";
import { closeDatabase, getDb } from "../db.js";
import { corpusFingerprint, splitForArticle, validateEvaluationDataset, type CorpusSnapshot, type EvaluationDataset, type EvaluationQuestion } from "../evaluation.js";
import { closeModelAdmissionLimiter } from "../model-admission.js";
import { createChatModel, type ChatMessage, type ChatModel } from "../models.js";
import { usableModel } from "../provider.js";
import { getModelSelection } from "../repository.js";
import { documents } from "../schema.js";
import { searchTerms } from "../search-terms.js";
import {
  assignTargets, checkGenerated, eligibleForSample, evidenceSource, failureCategory, generationMessages, MAX_GENERATION_ATTEMPTS, parseGenerated, parseModelJson, parseReview,
  REVIEW_CRITERIA, reviewMessages, stratifiedSample, SYNTHETIC_PROMPT_VERSION, type CorpusArticle, type GeneratedQuestion, type ReviewCriterion, type ReviewResult, type SampleTarget,
} from "../synthetic-questions.js";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const positiveInt = (name: string, fallback?: number) => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const name = arg("name");
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("--name is required (lowercase letters, digits and dashes), e.g. --name=nyz-rag-synthetic-v1");
const workDir = join(repoRoot, ".nyz-data/evaluation", name);
const samplePath = join(workDir, "sample.json");
const itemsPath = join(workDir, "items.jsonl");

const CRITERION_LABELS: Record<ReviewCriterion, string> = {
  standalone: "不能独立理解", supported: "证据不足以支持答案", faithful: "答案有编造或过度推断", specific: "答案不明确", distinctive: "属于通识而非文章特有内容", natural: "不像真实提问",
};

interface SampleFile {
  name: string;
  seed: number;
  size: number;
  promptVersion: number;
  createdAt: string;
  corpus: CorpusSnapshot;
  eligibleDocuments: number;
  strata: Record<string, number>;
  articles: Array<SampleTarget & { contentHash: string | null }>;
}

interface Usage { promptTokens: number; completionTokens: number }

interface AttemptRecord {
  articleKey: string;
  /** 失败（error）不计入尝试次数，下次运行重新尝试。 */
  status: "retry" | "approved" | "rejected" | "error";
  attempt: number;
  at: string;
  promptVersion: number;
  generatorModel: string;
  reviewerModel: string;
  generated?: GeneratedQuestion;
  /** 无法解析时保留的模型输出开头，便于排查提示问题。 */
  raw?: string;
  failures: string[];
  lexicalOverlap?: number;
  review?: ReviewResult;
  usage: { generate: Usage; review: Usage };
  error?: string;
}

// ---- 语料 ----

async function loadCorpus(): Promise<{ articles: CorpusArticle[]; snapshot: CorpusSnapshot }> {
  const rows = await getDb().select({
    articleKey: documents.externalId, title: documents.title, category: documents.category, content: documents.content, metadata: documents.metadata,
    contentHash: documents.contentHash, parserVersion: documents.parserVersion, embeddingStatus: documents.embeddingStatus, embeddingModel: documents.embeddingModel,
  }).from(documents).where(and(eq(documents.status, "ready"), isNull(documents.duplicateOf)));
  const parserVersions: Record<string, number> = {};
  const models = new Map<string, number>();
  let embedded = 0;
  for (const row of rows) {
    parserVersions[String(row.parserVersion)] = (parserVersions[String(row.parserVersion)] ?? 0) + 1;
    if (row.embeddingStatus === "ready") {
      embedded += 1;
      if (row.embeddingModel) models.set(row.embeddingModel, (models.get(row.embeddingModel) ?? 0) + 1);
    }
  }
  const embeddingModel = [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    articles: rows.map((row) => ({ articleKey: row.articleKey, title: row.title, category: row.category, content: row.content, metadata: row.metadata as ArticleMetadata | null, contentHash: row.contentHash })),
    snapshot: {
      documents: rows.length,
      fingerprint: corpusFingerprint(rows),
      parserVersions,
      chunkerVersion: null,
      embeddingModel,
      embeddingCoverage: rows.length ? Math.round((embedded / rows.length) * 10_000) / 10_000 : 0,
    },
  };
}

async function loadOrCreateSample(articles: CorpusArticle[], snapshot: CorpusSnapshot): Promise<SampleFile> {
  const size = positiveInt("size");
  const seed = positiveInt("seed");
  if (existsSync(samplePath)) {
    const sample = JSON.parse(await readFile(samplePath, "utf8")) as SampleFile;
    if ((size && size !== sample.size) || (seed && seed !== sample.seed)) throw new Error(`Sample already exists with size=${sample.size} seed=${sample.seed}; use a new --name to resample`);
    if (sample.corpus.fingerprint !== snapshot.fingerprint) console.warn("语料已变化：正文改变或被删除的样本文章将跳过（stale）。");
    return sample;
  }
  const eligible = articles.filter(eligibleForSample);
  const sampleSeed = seed ?? 20261023;
  const sampled = stratifiedSample(eligible, size ?? 400, sampleSeed);
  const byKey = new Map(articles.map((article) => [article.articleKey, article]));
  const targets = assignTargets(sampled, byKey, sampleSeed);
  const strata: Record<string, number> = {};
  for (const item of targets) strata[item.stratum] = (strata[item.stratum] ?? 0) + 1;
  const sample: SampleFile = {
    name: name!, seed: sampleSeed, size: targets.length, promptVersion: SYNTHETIC_PROMPT_VERSION, createdAt: new Date().toISOString(),
    corpus: snapshot, eligibleDocuments: eligible.length, strata,
    articles: targets.map((target) => ({ ...target, contentHash: byKey.get(target.articleKey)!.contentHash })),
  };
  await mkdir(workDir, { recursive: true });
  await writeFile(samplePath, `${JSON.stringify(sample, null, 2)}\n`);
  console.info(`已抽样 ${targets.length} 篇（可出题 ${eligible.length} / 语料 ${snapshot.documents}），写入 ${samplePath}`);
  return sample;
}

/** 只读取当前提示版本的记录；提示或校验规则变化后，旧版本的结果保留在文件中但不再计入，文章重新生成。 */
async function readAttempts(): Promise<Map<string, AttemptRecord[]>> {
  const attempts = new Map<string, AttemptRecord[]>();
  if (!existsSync(itemsPath)) return attempts;
  for (const line of (await readFile(itemsPath, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as AttemptRecord;
    if (record.promptVersion !== SYNTHETIC_PROMPT_VERSION) continue;
    attempts.set(record.articleKey, [...(attempts.get(record.articleKey) ?? []), record]);
  }
  return attempts;
}

const finalStatus = (records: AttemptRecord[] | undefined) => {
  const last = records?.filter((record) => record.status !== "error").at(-1);
  return last?.status === "approved" || last?.status === "rejected" ? last : undefined;
};

// ---- 生成 ----

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** 收集流式输出；临时故障最多重试 2 次。 */
async function complete(model: ChatModel, messages: ChatMessage[], usage: Usage): Promise<string> {
  for (let retry = 0; ; retry += 1) {
    try {
      let text = "";
      for await (const chunk of model.streamChat(messages)) {
        if (chunk.type === "token") text += chunk.text;
        else { usage.promptTokens += chunk.promptTokens; usage.completionTokens += chunk.completionTokens; }
      }
      return text;
    } catch (error) {
      if (retry >= 2) throw error;
      await sleep(5_000 * (retry + 1) ** 2);
    }
  }
}

async function generate(sample: SampleFile, articles: Map<string, CorpusArticle>) {
  const [chat, review] = await Promise.all([getModelSelection("chat"), getModelSelection("review")]);
  const generatorSelection = usableModel(chat);
  const reviewerSelection = usableModel(review);
  if (!generatorSelection) throw new Error("未配置可用的 Chat 模型（业务模型 chat）");
  if (!reviewerSelection) throw new Error("未配置可用的审核模型（业务模型 review），不会改用 Chat 模型");
  if (generatorSelection.provider.id === reviewerSelection.provider.id && generatorSelection.model.trim() === reviewerSelection.model.trim()) {
    console.warn("审核模型与 Chat 模型相同，建议选用不同的模型。");
  }
  const generator = createChatModel(generatorSelection);
  const reviewer = createChatModel(reviewerSelection);

  const attempts = await readAttempts();
  const limit = positiveInt("limit");
  const scope = sample.articles.slice(0, limit ?? sample.articles.length);
  const accepted = [...attempts.values()].map(finalStatus).filter((record) => record?.status === "approved").map((record) => searchTerms(record!.generated!.question));
  const pending = scope.filter((target) => !finalStatus(attempts.get(target.articleKey)));
  console.info(`本次范围 ${scope.length} 篇，待处理 ${pending.length} 篇；生成 ${generator.model}，审核 ${reviewer.model}`);

  let writes = Promise.resolve();
  const append = (record: AttemptRecord) => {
    attempts.set(record.articleKey, [...(attempts.get(record.articleKey) ?? []), record]);
    writes = writes.then(() => appendFile(itemsPath, `${JSON.stringify(record)}\n`));
    return writes;
  };

  let done = 0;
  async function processTarget(target: SampleTarget & { contentHash: string | null }) {
    const article = articles.get(target.articleKey);
    if (!article || article.contentHash !== target.contentHash) {
      console.warn(`跳过 ${target.articleKey}：文章已删除或正文已变化（stale）`);
      return;
    }
    const previous = attempts.get(target.articleKey) ?? [];
    let attempt = previous.filter((record) => record.status !== "error").length;
    let feedback = previous.filter((record) => record.status === "retry").at(-1)?.failures ?? [];
    while (attempt < MAX_GENERATION_ATTEMPTS) {
      attempt += 1;
      const record: AttemptRecord = {
        articleKey: target.articleKey, status: "retry", attempt, at: new Date().toISOString(), promptVersion: SYNTHETIC_PROMPT_VERSION,
        generatorModel: generator.model, reviewerModel: reviewer.model, failures: [],
        usage: { generate: { promptTokens: 0, completionTokens: 0 }, review: { promptTokens: 0, completionTokens: 0 } },
      };
      try {
        const text = await complete(generator, generationMessages(article, target, feedback), record.usage.generate);
        try {
          record.generated = parseGenerated(parseModelJson(text));
        } catch (error) {
          record.raw = text.slice(0, 1000);
          record.failures.push(`格式错误：${error instanceof Error ? error.message : "无法解析"}，只输出一个 JSON 对象`);
        }
        if (record.generated) {
          const check = checkGenerated(record.generated, article, target, accepted);
          record.failures.push(...check.failures);
          record.lexicalOverlap = Math.round(check.lexicalOverlap * 1000) / 1000;
        }
        if (!record.failures.length) {
          const reviewText = await complete(reviewer, reviewMessages(article, record.generated!), record.usage.review);
          // 审核输出无法解析是审核模型的问题，记为 error，下次运行重新审核同一篇文章。
          record.review = parseReview(parseModelJson(reviewText));
          if (!record.review.passed) {
            const failed = REVIEW_CRITERIA.filter((key) => !record.review!.criteria[key]).map((key) => CRITERION_LABELS[key]);
            record.failures.push(`审核未通过：${failed.join("、")}${record.review.reason ? `。${record.review.reason}` : ""}`);
          }
        }
      } catch (error) {
        record.status = "error";
        record.error = error instanceof Error ? error.message : "unknown error";
        await append(record);
        console.warn(`${target.articleKey} 调用失败，下次运行重试：${record.error}`);
        return;
      }
      record.status = record.failures.length ? (attempt >= MAX_GENERATION_ATTEMPTS ? "rejected" : "retry") : "approved";
      await append(record);
      if (record.status === "approved") accepted.push(searchTerms(record.generated!.question));
      if (record.status !== "retry") break;
      feedback = record.failures;
    }
    done += 1;
    const status = finalStatus(attempts.get(target.articleKey))?.status ?? "pending";
    console.info(`[${done}/${pending.length}] ${target.articleKey} ${target.type}/${target.specificity} → ${status}（第 ${attempt} 次）`);
  }

  const concurrency = positiveInt("concurrency", 2)!;
  const queue = [...pending];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let target = queue.shift(); target; target = queue.shift()) await processTarget(target);
  }));
  await writes;
  await writeReport(sample, scope, attempts, articles);
}

// ---- 报告 ----

const addUsage = (total: Usage, usage: Usage) => { total.promptTokens += usage.promptTokens; total.completionTokens += usage.completionTokens; };
const count = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };

async function writeReport(sample: SampleFile, scope: SampleFile["articles"], attempts: Map<string, AttemptRecord[]>, articles: Map<string, CorpusArticle>) {
  const statuses: Record<string, number> = {};
  const failureCategories: Record<string, number> = {};
  const reviewFailures: Record<string, number> = {};
  const approvedBy: Record<string, number> = {};
  const overlap: Record<string, number> = { "<0.4": 0, "0.4-0.6": 0, ">=0.6": 0 };
  const usage = { generate: { promptTokens: 0, completionTokens: 0 }, review: { promptTokens: 0, completionTokens: 0 } };
  let errors = 0;
  let fallbackToFact = 0;
  let approvedAttempts = 0;
  const preview: string[] = [`# ${sample.name} 生成预览`, "", `范围 ${scope.length} 篇；提示版本 ${SYNTHETIC_PROMPT_VERSION}；生成于 ${new Date().toISOString()}`, ""];
  for (const target of scope) {
    const records = attempts.get(target.articleKey) ?? [];
    for (const record of records) {
      addUsage(usage.generate, record.usage.generate);
      addUsage(usage.review, record.usage.review);
      if (record.status === "error") { errors += 1; continue; }
      for (const failure of record.failures) count(failureCategories, failureCategory(failure));
      if (record.review) for (const key of REVIEW_CRITERIA) if (!record.review.criteria[key]) count(reviewFailures, key);
    }
    const final = finalStatus(records);
    const stale = articles.get(target.articleKey)?.contentHash !== target.contentHash;
    count(statuses, stale ? "stale" : final?.status ?? "pending");
    if (!final) continue;
    const title = articles.get(target.articleKey)?.title ?? "";
    preview.push(`## ${final.status === "approved" ? "✅" : "❌"} ${target.articleKey}｜${target.type}/${target.specificity}｜${title}`, "");
    if (final.status === "approved") {
      const generated = final.generated!;
      approvedAttempts += final.attempt;
      count(approvedBy, `${generated.type}/${generated.specificity}`);
      if (generated.type !== target.type) fallbackToFact += 1;
      const value = final.lexicalOverlap ?? 0;
      count(overlap, value < 0.4 ? "<0.4" : value < 0.6 ? "0.4-0.6" : ">=0.6");
      preview.push(`- 问题：${generated.question}`, `- 答案：${generated.answer}`, ...generated.evidence.map((text) => `- 证据：${text}`), `- 词面重叠 ${value}，第 ${final.attempt} 次通过`, "");
    } else {
      preview.push(`- 最后一次问题：${final.generated?.question ?? "（无法解析）"}`, ...final.failures.map((failure) => `- ${failure}`), "");
    }
  }
  const approved = statuses.approved ?? 0;
  const finished = approved + (statuses.rejected ?? 0);
  const report = {
    name: sample.name, scope: scope.length, promptVersion: SYNTHETIC_PROMPT_VERSION, statuses,
    passRate: finished ? Math.round((approved / finished) * 1000) / 1000 : null,
    averageAttemptsForApproved: approved ? Math.round((approvedAttempts / approved) * 100) / 100 : null,
    fallbackToFact, approvedBy, overlap, failureCategories, reviewFailures, callErrors: errors, usage,
  };
  await writeFile(join(workDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(workDir, "preview.md"), `${preview.join("\n")}\n`);
  console.info(JSON.stringify(report, null, 2));
  console.info(`报告：${join(workDir, "report.json")}；逐题预览：${join(workDir, "preview.md")}`);
}

// ---- 冻结 ----

async function freeze(sample: SampleFile, articles: Map<string, CorpusArticle>) {
  const attempts = await readAttempts();
  const unfinished = sample.articles.filter((target) => !finalStatus(attempts.get(target.articleKey)) && articles.get(target.articleKey)?.contentHash === target.contentHash);
  if (unfinished.length) throw new Error(`${unfinished.length} 篇样本尚未完成，请先运行生成（不带 --limit）`);
  const questions: EvaluationQuestion[] = [];
  const models = { generator: new Set<string>(), reviewer: new Set<string>() };
  let rejected = 0;
  let stale = 0;
  let fallbackToFact = 0;
  for (const target of sample.articles) {
    const article = articles.get(target.articleKey);
    if (!article || article.contentHash !== target.contentHash) { stale += 1; continue; }
    const final = finalStatus(attempts.get(target.articleKey))!;
    if (final.status !== "approved") { rejected += 1; continue; }
    const generated = final.generated!;
    if (generated.type !== target.type) fallbackToFact += 1;
    models.generator.add(final.generatorModel);
    models.reviewer.add(final.reviewerModel);
    questions.push({
      id: `s${String(questions.length + 1).padStart(4, "0")}`,
      question: generated.question,
      answer: generated.answer,
      history: [],
      filters: null,
      type: generated.type,
      specificity: generated.specificity,
      source: "synthetic",
      split: splitForArticle(target.articleKey),
      answerable: true,
      lexicalOverlap: final.lexicalOverlap,
      labels: [{ articleKey: target.articleKey, relevance: 3, evidence: generated.evidence }],
    });
  }
  const dataset: EvaluationDataset = {
    schemaVersion: 2,
    name: sample.name,
    version: new Date().toISOString().slice(0, 10),
    provenance: "Synthetic questions generated by an LLM from single articles with verbatim evidence, auto-checked and LLM-reviewed; not real user questions and not human validated. Single-source labels: only the source article is judged.",
    corpus: sample.corpus,
    sample: { seed: sample.seed, size: sample.size, strata: ["category", "journal", "lengthTercile"], createdAt: sample.createdAt },
    generation: {
      generatorModel: [...models.generator].join(", "), reviewerModel: [...models.reviewer].join(", "), promptVersion: SYNTHETIC_PROMPT_VERSION,
      approved: questions.length, rejected, stale, fallbackToFact,
    },
    questions,
  };
  const evidenceByArticle = new Map(questions.map((item) => [item.labels[0].articleKey, evidenceSource(articles.get(item.labels[0].articleKey)!, "metadata")]));
  const errors = validateEvaluationDataset(dataset, { corpusArticleKeys: articles.keys(), evidenceByArticle });
  if (errors.length) throw new Error(`Frozen dataset invalid:\n${errors.join("\n")}`);
  const out = resolve(arg("out") ?? join(repoRoot, "packages/processing/test/evaluation", `${sample.name}.json`));
  await writeFile(out, `${JSON.stringify(dataset, null, 2)}\n`);
  const splits = { dev: questions.filter((item) => item.split === "dev").length, test: questions.filter((item) => item.split === "test").length };
  console.info(`已冻结 ${questions.length} 道题（dev ${splits.dev} / test ${splits.test}，未通过 ${rejected}，跳过 ${stale}）→ ${out}`);
}

try {
  const { articles, snapshot } = await loadCorpus();
  const sample = await loadOrCreateSample(articles, snapshot);
  const byKey = new Map(articles.map((article) => [article.articleKey, article]));
  if (flag("freeze")) await freeze(sample, byKey);
  else await generate(sample, byKey);
} finally {
  await closeModelAdmissionLimiter();
  await closeDatabase();
}

