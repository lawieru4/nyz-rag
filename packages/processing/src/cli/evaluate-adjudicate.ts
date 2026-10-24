// 用法：pnpm --filter @nyz-rag/processing evaluate:adjudicate <运行> [--variant=rerank,fused] [--ids=s0152,s0163] [--limit=N] [--concurrency=2] [--dry-run]
// 失败题复判：对来源文章没有排在第 1 的题目，由审核模型（业务模型 review）判断排在来源文章之前（最多前 10 篇）的其他文章能否回答该问题，
// 据此计算宽松 Hit@K / MRR，与严格指标并列写入运行记录的 adjudication 字段（evaluate:compare 随之对比宽松指标）。会调用模型，产生费用；--dry-run 只统计待复判的文章。
// 运行写运行名（取该名称最新的一次）或运行记录的路径；--variant 默认取运行中的 rerank、fused。复判结论按「题目 + 文章」缓存在
// .nyz-data/eval-adjudications/<数据集>@<版本>.jsonl，文章正文、复判版本与审核模型不变时各次运行与变体共用，中断后重新运行即继续。方案见 docs/evaluation-plan.md 第 7.3 节。
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { closeDatabase } from "../db.js";
import {
  ADJUDICATION_DEPTH, ADJUDICATION_VERSION, adjudicationMessages, adjudicationTargets, countsAsAnswer, lenientRank, parseAdjudication, summarizeLenient,
  verifyEvidence, type Adjudication, type AdjudicationTable, type LenientMetrics, type RunAdjudication,
} from "../evaluation-adjudication.js";
import { evaluatedResults, HIT_KS, RETRIEVAL_VARIANTS, type RetrievalVariant, type RunQuestion } from "../evaluation-run.js";
import { closeModelAdmissionLimiter } from "../model-admission.js";
import { createChatModel, type ChatMessage, type ChatModel } from "../models.js";
import { usableModel } from "../provider.js";
import { getModelSelections } from "../repository.js";
import { parseModelJson } from "../synthetic-questions.js";
import { loadRunRecord, repoRoot } from "./eval-runs.js";
import { loadCorpus, useEvaluationSchema, type EvaluationCorpusArticle } from "./evaluation-corpus.js";

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const positiveInt = (name: string, fallback?: number) => {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
  return value;
};

const cacheDir = join(repoRoot, ".nyz-data/eval-adjudications");
const DEFAULT_VARIANTS: RetrievalVariant[] = ["fused", "rerank"];

interface Usage { promptTokens: number; completionTokens: number }

/** 复判缓存的一行；同一题同一文章以最后一条为准，复判版本、审核模型与文章 content_hash 都相同才复用。 */
interface CacheEntry {
  questionId: string;
  articleKey: string;
  contentHash: string | null;
  version: number;
  model: { provider: string; model: string };
  at: string;
  question: string;
  title: string;
  adjudication?: Adjudication;
  usage?: Usage;
  error?: string;
}

const message = (error: unknown) => error instanceof Error ? error.message : "unknown error";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const pairKey = (questionId: string, articleKey: string) => `${questionId}\u0000${articleKey}`;

/** 收集流式输出；临时故障、空输出与无法解析的输出最多重试 2 次。 */
async function judge(model: ChatModel, messages: ChatMessage[], article: EvaluationCorpusArticle) {
  for (let retry = 0; ; retry += 1) {
    const usage = { promptTokens: 0, completionTokens: 0 };
    try {
      let text = "";
      for await (const chunk of model.streamChat(messages)) {
        if (chunk.type === "token") text += chunk.text;
        else {
          usage.promptTokens += chunk.promptTokens;
          usage.completionTokens += chunk.completionTokens;
        }
      }
      if (!text.trim()) throw new Error("模型返回了空输出");
      return { adjudication: parseAdjudication(parseModelJson(text), article), usage };
    } catch (error) {
      if (retry >= 2) throw error;
      await sleep(5_000 * (retry + 1) ** 2);
    }
  }
}

async function readCache(path: string): Promise<Map<string, CacheEntry>> {
  const entries = new Map<string, CacheEntry>();
  if (!existsSync(path)) return entries;
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as CacheEntry;
    entries.set(pairKey(entry.questionId, entry.articleKey), entry);
  }
  return entries;
}

const pct = (value: number) => (value * 100).toFixed(1);
const rankText = (rank: number | null) => rank === null ? "无" : String(rank);

function printMetrics(variant: RetrievalVariant, metrics: LenientMetrics) {
  const cells = [...HIT_KS.map((k) => `Hit@${k} ${pct(metrics.strictHitAt[String(k)])} → ${pct(metrics.hitAt[String(k)])}`), `MRR ${pct(metrics.strictMrr)} → ${pct(metrics.mrr)}`];
  console.info(`${variant.padEnd(8)}${cells.join("；")}；挽回 ${metrics.rescued} 道${metrics.unjudged ? `，仍有 ${metrics.unjudged} 道题有待复判的文章（宽松指标偏低）` : ""}`);
}

const refs = process.argv.slice(2).filter((value) => !value.startsWith("--"));
if (refs.length !== 1) throw new Error("Usage: evaluate:adjudicate <run> [--variant=rerank,fused] [--ids=s0152,s0163] [--limit=N] [--concurrency=2] [--dry-run]");
const { path: runPath, run } = await loadRunRecord(refs[0]);
const variantArg = arg("variant");
const variants = variantArg
  ? [...new Set(variantArg.split(",").map((value) => value.trim()).filter(Boolean))] as RetrievalVariant[]
  : DEFAULT_VARIANTS.filter((variant) => run.variants.includes(variant));
if (!variants.length) throw new Error(`运行 ${run.name} 没有 rerank 或 fused 变体，请用 --variant 指定（运行中有 ${run.variants.join(", ")}）`);
for (const variant of variants) {
  if (!RETRIEVAL_VARIANTS.includes(variant)) throw new Error(`Unknown variant in --variant=${variantArg}`);
  if (!run.variants.includes(variant)) throw new Error(`运行 ${run.name} 没有 ${variant} 变体`);
}
const ids = arg("ids") ? new Set(arg("ids")!.split(",").map((value) => value.trim()).filter(Boolean)) : null;
const unknownIds = ids ? [...ids].filter((id) => !run.questions.some((question) => question.id === id)) : [];
if (unknownIds.length) throw new Error(`运行 ${run.name} 中没有题目 ${unknownIds.join(", ")}`);
const limit = positiveInt("limit");
const concurrency = positiveInt("concurrency", 2)!;
const dryRun = flag("dry-run");
if (run.settings.schema) useEvaluationSchema(run.settings.schema);

async function adjudicate() {
  // 待复判的「题目 + 文章」：各变体中来源文章没有排在第 1 的题目，排在来源文章之前的文章（最多前 10 篇），跨变体去重。
  const questionsById = new Map(run.questions.map((question) => [question.id, question]));
  const failing = [...new Set(variants.flatMap((variant) => evaluatedResults(run.questions, variant)
    .filter(([question, result]) => (!ids || ids.has(question.id)) && adjudicationTargets(result).length)
    .map(([question]) => question.id)))];
  const scope = new Set(run.questions.map((question) => question.id).filter((id) => failing.includes(id)).slice(0, limit));
  const pairs = new Map<string, { question: RunQuestion; articleKey: string }>();
  for (const variant of variants) {
    for (const [question, result] of evaluatedResults(run.questions, variant)) {
      if (!scope.has(question.id)) continue;
      for (const articleKey of adjudicationTargets(result)) pairs.set(pairKey(question.id, articleKey), { question, articleKey });
    }
  }

  const { articles, snapshot } = await loadCorpus();
  const byKey = new Map(articles.map((article) => [article.articleKey, article]));
  if (snapshot.fingerprint !== run.corpus.fingerprint) console.warn("当前语料与运行时不同：复判按当前正文进行，已删除的文章不复判。");
  const missing = [...pairs.values()].filter((pair) => !byKey.has(pair.articleKey));

  const selections = await getModelSelections();
  const judgeSelection = usableModel(selections.review);
  if (!judgeSelection && !dryRun) throw new Error("未配置可用的审核模型（业务模型 review），不会改用 Chat 模型");
  const model = judgeSelection ? { provider: judgeSelection.provider.name, model: judgeSelection.model.trim() } : null;
  const cachePath = join(cacheDir, `${run.dataset.name}@${run.dataset.version}.jsonl`.replace(/[^\w.@-]/g, "_"));
  const cache = await readCache(cachePath);
  const reusable = (entry: CacheEntry | undefined): entry is CacheEntry & { adjudication: Adjudication } => Boolean(
    entry?.adjudication && !entry.error && entry.version === ADJUDICATION_VERSION && model && entry.model.provider === model.provider && entry.model.model === model.model
    && entry.contentHash === (byKey.get(entry.articleKey)?.contentHash ?? null),
  );
  // 证据按当前规则重新校验，不沿用缓存中的 verified。
  const verdictOf = (entry: CacheEntry & { adjudication: Adjudication }): Adjudication => ({ ...entry.adjudication, verified: verifyEvidence(entry.adjudication.evidence, byKey.get(entry.articleKey)!) });
  const pending = [...pairs.entries()].filter(([key, pair]) => byKey.has(pair.articleKey) && !reusable(cache.get(key)));
  const chars = pending.reduce((sum, [, pair]) => sum + byKey.get(pair.articleKey)!.content.length, 0);
  console.info(`运行 ${run.name}（${run.dataset.name}@${run.dataset.version}，${run.dataset.split}）；变体 ${variants.join(", ")}；`
    + `需复判 ${scope.size} 道题、${pairs.size} 篇次，已有结论 ${pairs.size - pending.length - missing.length}，待复判 ${pending.length}（正文约 ${chars} 字）${missing.length ? `，${missing.length} 篇已不在语料中` : ""}；审核模型 ${model?.model ?? "-"}`);
  if (dryRun) return;

  const judgeModel = createChatModel(judgeSelection!);
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let writes = Promise.resolve();
  const save = (entry: CacheEntry) => {
    cache.set(pairKey(entry.questionId, entry.articleKey), entry);
    writes = writes.then(async () => {
      await mkdir(cacheDir, { recursive: true });
      await appendFile(cachePath, `${JSON.stringify(entry)}\n`);
    });
    return writes;
  };
  const queue = [...pending];
  let done = 0;
  let failures = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [, { question, articleKey }] = next;
      const article = byKey.get(articleKey)!;
      const base = { questionId: question.id, articleKey, contentHash: article.contentHash, version: ADJUDICATION_VERSION, model: model!, at: new Date().toISOString(), question: question.question, title: article.title };
      let status: string;
      try {
        const result = await judge(judgeModel, adjudicationMessages(question.question, article), article);
        usage.promptTokens += result.usage.promptTokens;
        usage.completionTokens += result.usage.completionTokens;
        await save({ ...base, adjudication: result.adjudication, usage: result.usage });
        status = `${result.adjudication.verdict}${result.adjudication.verdict !== "no" && !result.adjudication.verified ? "（证据未找到）" : ""}`;
      } catch (error) {
        failures += 1;
        await save({ ...base, error: message(error) });
        status = `失败：${message(error)}`;
      }
      done += 1;
      console.info(`[${done}/${pending.length}] ${question.id} ${articleKey} ${status}`);
    }
  }));
  await writes;

  // 运行记录保存这次运行全部变体与题目中已有结论的文章，未请求的变体若恰好被覆盖也能计算宽松指标。
  const judgements: AdjudicationTable = {};
  for (const variant of run.variants) {
    for (const [question, result] of evaluatedResults(run.questions, variant)) {
      for (const articleKey of adjudicationTargets(result)) {
        const entry = cache.get(pairKey(question.id, articleKey));
        if (!reusable(entry)) continue;
        const { verdict, verified } = verdictOf(entry);
        (judgements[question.id] ??= {})[articleKey] = { verdict, verified };
      }
    }
  }
  const previous = run.adjudication?.version === ADJUDICATION_VERSION && JSON.stringify(run.adjudication.model) === JSON.stringify(model) ? run.adjudication.variants : [];
  const adjudicated = RETRIEVAL_VARIANTS.filter((variant) => previous.includes(variant) || variants.includes(variant));
  const record: RunAdjudication = {
    version: ADJUDICATION_VERSION, model: model!, updatedAt: new Date().toISOString(), depth: ADJUDICATION_DEPTH, variants: adjudicated, judgements,
    summary: Object.fromEntries(adjudicated.map((variant) => [variant, summarizeLenient(run.questions, variant, judgements)])),
  };
  await writeFile(runPath, `${JSON.stringify({ ...run, adjudication: record })}\n`);

  console.info(`\n宽松指标（严格 → 宽松，%；前 ${ADJUDICATION_DEPTH} 篇中排在来源文章之前、复判为 yes 且证据可在原文找到的文章也算命中）：`);
  for (const variant of adjudicated) printMetrics(variant, record.summary[variant]!.overall);
  const low = adjudicated.map((variant) => `${variant} ${pct(record.summary[variant]!.groups.specificity.low?.strictHitAt["1"] ?? 0)} → ${pct(record.summary[variant]!.groups.specificity.low?.hitAt["1"] ?? 0)}`);
  console.info(`low 题 Hit@1：${low.join("；")}。按划分、题型、具体度与词面重叠分组的指标见运行记录的 adjudication.summary。`);

  // 逐题明细：--ids 指定的题，或来源文章不在前 10、宽松名次有变化的题；列出各变体的名次变化与每篇待复判文章的结论。
  const notable = (question: RunQuestion) => variants.some((variant) => {
    const result = question.results[variant];
    return result && !result.error && (result.rank === null || result.rank > ADJUDICATION_DEPTH || lenientRank(result, judgements[question.id]) !== result.rank);
  });
  for (const id of scope) {
    const question = questionsById.get(id)!;
    if (!ids && !notable(question)) continue;
    console.info(`\n${id}（${question.type}/${question.specificity ?? "-"}）${question.question}`);
    for (const variant of variants) {
      const result = question.results[variant];
      if (!result || result.error) continue;
      const targets = adjudicationTargets(result);
      if (!targets.length) continue;
      console.info(`  ${variant}：来源文章名次 ${rankText(result.rank)} → 宽松 ${rankText(lenientRank(result, judgements[id]))}`);
    }
    const articleKeys = [...pairs.values()].filter((pair) => pair.question.id === id).map((pair) => pair.articleKey);
    for (const articleKey of articleKeys) {
      const entry = cache.get(pairKey(id, articleKey));
      const verdict = reusable(entry) ? verdictOf(entry) : null;
      const label = !byKey.has(articleKey) ? "不在语料中" : !verdict ? `未复判${entry?.error ? `（${entry.error}）` : ""}` : `${verdict.verdict}${countsAsAnswer(verdict) ? "（计入）" : verdict.verdict === "yes" ? "（证据未找到，不计入）" : ""}`;
      console.info(`    ${articleKey} ${label}《${byKey.get(articleKey)?.title ?? "-"}》${verdict?.answer ? `：${verdict.answer}` : ""}`);
    }
  }
  console.info(`\n复判 ${pending.length - failures} 篇次，失败 ${failures}；Token：输入 ${usage.promptTokens}、输出 ${usage.completionTokens}。运行记录已更新：${runPath}；复判明细：${cachePath}`);
  if (failures) console.warn(`${failures} 篇次复判失败，重新运行同一命令即可补齐。`);
}

try {
  await adjudicate();
} finally {
  await closeModelAdmissionLimiter();
  await closeDatabase();
}
