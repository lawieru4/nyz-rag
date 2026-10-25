// 用法：pnpm --filter @nyz-rag/processing evaluate:answer --dataset=<路径> --name=<运行名> [--split=dev|test] [--context=topk|budget|section] [--variant=fused|rerank]
//         [--schema=eval_<名称>] [--limit=N] [--concurrency=2]
//       pnpm --filter @nyz-rag/processing evaluate:answer --compare <运行A> <运行B> [--json]
// 回答层评估：每道题按问答的方式检索（retrieve()，最近创建的知识库参数与业务模型配置），按 --context 组装上下文后调用 Chat 模型回答（不保存问答记录），
// 统计来源文章被引用的比例，再由审核模型（业务模型 review）评审回答是否忠实于参考资料、是否完整、引用是否恰当。会调用模型，产生费用。
// 结果逐题追加到 .nyz-data/eval-answers/<运行名>/items.jsonl，中断后用同样的参数重新运行即从未完成的题目继续；--compare 逐题对比两次运行。方案见 docs/evaluation-plan.md 第九节。
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase } from "../db.js";
import {
  ANSWER_EVAL_VERSION, answeredItems, citationStats, compareAnswerRuns, JUDGE_CRITERIA, judgeMessages, parseJudgement, summarizeAnswers,
  type AnswerChange, type AnswerItem, type AnswerMetrics, type AnswerSummary,
} from "../evaluation-answer.js";
import { assertSupportedEvaluationInputs, filterSplit, readEvaluationDataset, SPLITS, validateEvaluationDataset, type CorpusSnapshot, type EvaluationQuestion, type Split } from "../evaluation.js";
import { CONTEXT_MODES, runVariantWithContext, sourceLabels, type ContextMode } from "../evaluation-run.js";
import { closeModelAdmissionLimiter } from "../model-admission.js";
import { createChatModel, createEmbeddingModel, createRerankModel, type ChatMessage, type ChatModel } from "../models.js";
import { usableModel, type ModelSelection } from "../provider.js";
import { buildChatMessages, DEFAULT_RETRIEVAL_SETTINGS, NO_MATCH_ANSWER, referenceText, type RetrievalDependencies, type RetrievalSettings } from "../rag.js";
import { getModelSelections, keywordSearchChunks, listKnowledgeBases, listSectionContexts, summarySearchChunks, vectorSearchChunks } from "../repository.js";
import { parseModelJson } from "../synthetic-questions.js";
import { loadCorpus, staleQuestionReason, useEvaluationSchema, withRetry } from "./evaluation-corpus.js";

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
const answersDir = join(repoRoot, ".nyz-data/eval-answers");
// pnpm 在包目录运行脚本，相对路径按调用命令时的目录解析。
const invocationDir = process.env.INIT_CWD ?? process.cwd();

const ANSWER_VARIANTS = ["fused", "rerank"] as const;
type AnswerVariant = (typeof ANSWER_VARIANTS)[number];

interface ModelInfo { provider: string; model: string; temperature?: number; maxTokens?: number }

/** run.json：首次运行时写入；续跑时除 createdAt、corpus 外必须一致。 */
interface AnswerRun {
  version: typeof ANSWER_EVAL_VERSION;
  name: string;
  createdAt: string;
  dataset: { name: string; version: string; path: string; split: Split | "all" };
  corpus: CorpusSnapshot;
  settings: {
    knowledgeBase: { id: string; name: string } | null; retrieval: RetrievalSettings; prompt: string; context: ContextMode; variant: AnswerVariant; schema: string | null;
    /** 知识库的引用校验开关，决定回答要求用严格还是宽松版本（本命令不做生成后的引用校验）；引入开关之前的运行没有该字段。 */
    citationCheck?: boolean;
  };
  models: { embedding: ModelInfo | null; rerank: ModelInfo | null; chat: ModelInfo; judge: ModelInfo };
}

const message = (error: unknown) => error instanceof Error ? error.message : "unknown error";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const ms = (started: number) => Math.round((performance.now() - started) * 10) / 10;
const modelInfo = (selection: ModelSelection, chat = false): ModelInfo => ({
  provider: selection.provider.name, model: selection.model.trim(), ...(chat ? { temperature: selection.temperature, maxTokens: selection.maxTokens } : {}),
});

/** 收集流式输出，记录首 Token 与总耗时；临时故障与空回答最多重试 2 次，重试时重新计时。 */
async function complete(model: ChatModel, messages: ChatMessage[]) {
  for (let retry = 0; ; retry += 1) {
    const started = performance.now();
    const usage = { promptTokens: 0, completionTokens: 0 };
    let firstTokenMs: number | null = null;
    try {
      let text = "";
      for await (const chunk of model.streamChat(messages)) {
        if (chunk.type === "token") {
          firstTokenMs ??= ms(started);
          text += chunk.text;
        } else {
          usage.promptTokens += chunk.promptTokens;
          usage.completionTokens += chunk.completionTokens;
        }
      }
      if (!text.trim()) throw new Error("模型返回了空回答");
      return { text: text.trim(), firstTokenMs, totalMs: ms(started), ...usage };
    } catch (error) {
      if (retry >= 2) throw error;
      await sleep(5_000 * (retry + 1) ** 2);
    }
  }
}

async function readItems(path: string): Promise<Map<string, AnswerItem>> {
  const items = new Map<string, AnswerItem>();
  if (!existsSync(path)) return items;
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const item = JSON.parse(line) as AnswerItem;
    items.set(item.id, item);
  }
  return items;
}

// ---- 运行 ----

async function run() {
  const name = arg("name");
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("--name is required (lowercase letters, digits and dashes), e.g. --name=answer-topk");
  const datasetArg = arg("dataset");
  if (!datasetArg) throw new Error("--dataset is required, e.g. --dataset=packages/processing/test/evaluation/nyz-rag-synthetic-v1.json");
  const datasetPath = resolve(invocationDir, datasetArg);
  const split = arg("split") as Split | undefined;
  if (split !== undefined && !SPLITS.includes(split)) throw new Error("--split must be dev or test");
  const contextMode = (arg("context") ?? "topk") as ContextMode;
  if (!CONTEXT_MODES.includes(contextMode)) throw new Error(`--context must be one of ${CONTEXT_MODES.join(", ")}`);
  const variantArg = arg("variant") as AnswerVariant | undefined;
  if (variantArg !== undefined && !ANSWER_VARIANTS.includes(variantArg)) throw new Error(`--variant must be one of ${ANSWER_VARIANTS.join(", ")}`);
  const schema = arg("schema") ?? null;
  if (schema) useEvaluationSchema(schema);
  const limit = positiveInt("limit");
  const concurrency = positiveInt("concurrency", 2)!;

  const fullDataset = await readEvaluationDataset(datasetPath);
  const errors = validateEvaluationDataset(fullDataset);
  if (errors.length) throw new Error(`Evaluation dataset invalid:\n${errors.join("\n")}`);
  const dataset = filterSplit(fullDataset, split);
  assertSupportedEvaluationInputs(dataset.questions);
  const selected = dataset.questions.slice(0, limit);
  if (!selected.length) throw new Error(`No questions in split ${split}`);

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
  const chatSelection = usableModel(selections.chat);
  const judgeSelection = usableModel(selections.review);
  if (!embeddingSelection) throw new Error("未配置可用的 Embedding 模型");
  if (!chatSelection) throw new Error("未配置可用的 Chat 模型（业务模型 chat）");
  if (!judgeSelection) throw new Error("未配置可用的审核模型（业务模型 review），不会改用 Chat 模型");
  // 默认与线上一致：知识库开启 Rerank 且配置了 Rerank 模型时为 rerank。
  const variant: AnswerVariant = variantArg ?? (settings.rerankEnabled && rerankSelection ? "rerank" : "fused");
  if (variant === "rerank" && !rerankSelection) throw new Error("未配置可用的 Rerank 模型，请改用 --variant=fused");
  if (chatSelection.provider.id === judgeSelection.provider.id && chatSelection.model.trim() === judgeSelection.model.trim()) console.warn("审核模型与 Chat 模型相同，建议选用不同的模型，避免同一模型评审自己的回答。");
  const embedding = createEmbeddingModel(embeddingSelection);
  const reranker = variant === "rerank" ? createRerankModel(rerankSelection!) : null;
  const chat = createChatModel(chatSelection);
  const judge = createChatModel(judgeSelection);

  const current: AnswerRun = {
    version: ANSWER_EVAL_VERSION, name, createdAt: new Date().toISOString(),
    dataset: { name: dataset.name, version: dataset.version, path: relative(repoRoot, datasetPath).replaceAll("\\", "/"), split: split ?? "all" },
    corpus: snapshot,
    settings: { knowledgeBase: knowledgeBase ? { id: knowledgeBase.id, name: knowledgeBase.name } : null, retrieval: settings, prompt: knowledgeBase?.prompt ?? "", context: contextMode, variant, schema, citationCheck: knowledgeBase?.citationCheck ?? true },
    models: {
      embedding: modelInfo(embeddingSelection), rerank: reranker ? modelInfo(rerankSelection!) : null, chat: modelInfo(chatSelection, true), judge: modelInfo(judgeSelection, true),
    },
  };
  const workDir = join(answersDir, name);
  const runPath = join(workDir, "run.json");
  const itemsPath = join(workDir, "items.jsonl");
  let runFile = current;
  if (existsSync(runPath)) {
    runFile = JSON.parse(await readFile(runPath, "utf8")) as AnswerRun;
    const comparable = ({ version, dataset, settings, models }: AnswerRun) => JSON.stringify({ version, dataset, settings, models });
    if (comparable(runFile) !== comparable(current)) throw new Error(`运行 ${name} 已存在且参数、模型或评估版本不同，不能续跑；请换用新的 --name（已有参数见 ${runPath}）`);
    if (runFile.corpus.fingerprint !== snapshot.fingerprint) console.warn("语料已在上次运行后变化：已完成的题目不重新运行，结果可能混合了两份语料。");
  } else {
    await mkdir(workDir, { recursive: true });
    await writeFile(runPath, `${JSON.stringify(current, null, 2)}\n`);
  }
  if (snapshot.embeddingCoverage < 1) console.warn(`向量化覆盖率 ${(snapshot.embeddingCoverage * 100).toFixed(2)}%，结果不完整。`);

  const items = await readItems(itemsPath);
  const pending = selected.filter((question) => { const item = items.get(question.id); return !item || item.error; });
  console.info(`数据集 ${dataset.name}@${dataset.version}，${split ?? "全部"} ${selected.length} 道题，待处理 ${pending.length} 道；${variant}，上下文 ${contextMode}/${settings.maxContextLength} 字（topK=${settings.topK}）；`
    + `Chat ${chat.model}，审核 ${judge.model}；索引 ${schema ?? "业务库"}`);

  let writes = Promise.resolve();
  const save = (item: AnswerItem) => {
    items.set(item.id, item);
    writes = writes.then(() => appendFile(itemsPath, `${JSON.stringify(item)}\n`));
    return writes;
  };

  async function processQuestion(question: EvaluationQuestion) {
    const labels = sourceLabels(question);
    const previous = items.get(question.id);
    const base: AnswerItem = {
      id: question.id, question: question.question, type: question.type, split: question.split,
      ...(question.specificity ? { specificity: question.specificity } : {}),
      ...(question.lexicalOverlap !== undefined ? { lexicalOverlap: question.lexicalOverlap } : {}),
      sourceArticleKeys: labels.map((label) => label.articleKey), at: new Date().toISOString(),
    };
    const excluded = staleQuestionReason(question, byKey);
    if (excluded) return save({ ...base, excluded });

    // 只有评审失败时保留回答重新评审；检索或生成失败时整题重跑。
    let item: AnswerItem = previous?.error?.stage === "judge" && previous.answer !== undefined ? { ...previous, at: base.at, error: undefined } : base;
    if (item.answer === undefined) {
      let retrieved: Awaited<ReturnType<typeof runVariantWithContext>>;
      let embeddingMs: number;
      try {
        const started = performance.now();
        const vector = await withRetry(() => embedding.embedQuery(question.question));
        embeddingMs = ms(started);
        const dependencies: RetrievalDependencies = {
          keywordSearch: (terms, count) => keywordSearchChunks(terms, count),
          vectorSearch: (_text, count) => vectorSearchChunks(vector, embedding, count),
          summarySearch: (_text, count) => summarySearchChunks(vector, embedding, count),
          ...(reranker ? { rerank: (query: string, texts: string[], topN: number) => withRetry(() => reranker.rerank(query, texts, topN)) } : {}),
        };
        retrieved = await runVariantWithContext(question, variant, settings, dependencies, articleKeyOf, { mode: contextMode, loadSections: (ids) => listSectionContexts(ids) });
      } catch (error) {
        return save({ ...base, error: { stage: "retrieval", message: message(error) } });
      }
      const { result, context } = retrieved;
      item = {
        ...base,
        retrieval: {
          rank: result.rank, contextHit: result.contextHit, evidenceHit: result.evidenceHit, evidenceFull: result.evidenceFull ?? null, contextChars: result.contextChars ?? 0,
          context: context.chunks.map((chunk) => ({ chunkId: chunk.chunkId, articleKey: articleKeyOf(chunk.documentId), citation: chunk.citation })),
          references: referenceText(context), retrievalMs: result.retrievalMs, embeddingMs, warnings: result.warnings,
        },
      };
      if (!context.chunks.length) return save({ ...item, answerMode: "no-context", answer: NO_MATCH_ANSWER });
      try {
        const generated = await complete(chat, buildChatMessages(current.settings.prompt, question.question, context, [], current.settings.citationCheck));
        item.answerMode = "generated";
        item.answer = generated.text;
        item.generation = { model: chat.model, firstTokenMs: generated.firstTokenMs, totalMs: generated.totalMs, promptTokens: generated.promptTokens, completionTokens: generated.completionTokens };
        item.citations = citationStats(generated.text, context.sources.map((source) => ({ articleKey: articleKeyOf(source.documentId) })), base.sourceArticleKeys);
      } catch (error) {
        return save({ ...item, error: { stage: "generation", message: message(error) } });
      }
    }
    try {
      const judged = await complete(judge, judgeMessages({
        question: question.question, ...(question.answer ? { referenceAnswer: question.answer } : {}), evidence: labels.flatMap((label) => label.evidence),
        references: item.retrieval!.references, answer: item.answer!,
      }));
      item.judgeUsage = { promptTokens: judged.promptTokens, completionTokens: judged.completionTokens };
      // 评审输出无法解析记为 judge 阶段失败，下次运行只重新评审。
      item.judgement = parseJudgement(parseModelJson(judged.text));
    } catch (error) {
      return save({ ...item, judgement: undefined, error: { stage: "judge", message: message(error) } });
    }
    return save(item);
  }

  const queue = [...pending];
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let question = queue.shift(); question; question = queue.shift()) {
      await processQuestion(question);
      done += 1;
      const item = items.get(question.id)!;
      const status = item.excluded ? "排除" : item.error ? `${item.error.stage} 失败：${item.error.message}` : item.judgement
        ? JUDGE_CRITERIA.map((key) => `${key} ${item.judgement!.scores[key] ?? "-"}`).join(" / ") : item.answerMode ?? "-";
      console.info(`[${done}/${pending.length}] ${question.id} ${status}`);
    }
  }));
  await writes;

  const scoped = selected.flatMap((question) => items.get(question.id) ? [items.get(question.id)!] : []);
  const summary = summarizeAnswers(scoped);
  await writeFile(join(workDir, "report.json"), `${JSON.stringify({ ...runFile, scope: { questions: selected.length, ...(limit ? { limit } : {}) }, summary }, null, 2)}\n`);
  await writeFile(join(workDir, "preview.md"), preview(runFile, scoped, selected));
  printSummary(runFile, summary);
  console.info(`报告：${join(workDir, "report.json")}；逐题预览：${join(workDir, "preview.md")}`);
  if (summary.reliability.errors) console.warn(`${summary.reliability.errors} 道题调用失败，重新运行同一命令即可补齐。`);
}

function preview(runFile: AnswerRun, items: AnswerItem[], questions: EvaluationQuestion[]): string {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const lines = [`# ${runFile.name} 回答预览`, "", `${runFile.dataset.name}@${runFile.dataset.version}（${runFile.dataset.split}），${runFile.settings.variant}，上下文 ${runFile.settings.context}；Chat ${runFile.models.chat.model}，审核 ${runFile.models.judge.model}`, ""];
  for (const item of items) {
    const scores = item.judgement ? JUDGE_CRITERIA.map((key) => `${key} ${item.judgement!.scores[key] ?? "-"}`).join(" / ") : "未评审";
    lines.push(`## ${item.id}｜${item.type}/${item.specificity ?? "-"}｜${scores}`, "", `- 问题：${item.question}`);
    if (byId.get(item.id)?.answer) lines.push(`- 参考答案：${byId.get(item.id)!.answer}`);
    if (item.excluded) { lines.push(`- 排除：${item.excluded}`, ""); continue; }
    if (item.retrieval) {
      const sources = [...new Map(item.retrieval.context.map((chunk) => [chunk.citation, chunk.articleKey])).entries()];
      lines.push(`- 上下文：${sources.map(([citation, key]) => `[${citation}] ${key}${item.sourceArticleKeys.includes(key) ? "（来源）" : ""}`).join("、") || "无"}；来源文章名次 ${item.retrieval.rank ?? "无"}，${item.retrieval.contextChars} 字`);
    }
    if (item.citations) lines.push(`- 引用：${item.citations.cited.map((value) => `[${value}]`).join("") || "无"}${item.citations.invalid.length ? `，无效编号 ${item.citations.invalid.join("、")}` : ""}；来源文章${item.citations.sourceCited ? "已" : "未"}被引用`);
    if (item.error) lines.push(`- ${item.error.stage} 失败：${item.error.message}`);
    if (item.answer !== undefined) lines.push("", "回答：", "", ...item.answer.split("\n").map((line) => `> ${line}`), "");
    if (item.judgement) {
      if (item.judgement.refused) lines.push("- 评审：表示资料不足");
      lines.push(`- 评审分析：${item.judgement.analysis}`);
      for (const text of item.judgement.unsupported) lines.push(`- 缺乏依据：${text}`);
      for (const text of item.judgement.missing) lines.push(`- 遗漏：${text}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ---- 输出 ----

const pct = (value: number | null) => value === null ? "-" : (value * 100).toFixed(1);
const signed = (value: number | null, scale = 100, digits = 1) => value === null ? "-" : `${value > 0 ? "+" : ""}${(value * scale).toFixed(digits)}`;
const num = (value: number | null, digits = 0) => value === null ? "-" : value.toFixed(digits);
const diff = (a: number | null, b: number | null) => a === null || b === null ? null : b - a;

/** [标签, 值, 格式]：rate 为比例（输出 %），score 为平均分，count 为数值。 */
function metricRows(summary: AnswerSummary): Array<[string, number | null, "rate" | "score" | "count"]> {
  const metrics: AnswerMetrics = summary.overall;
  return [
    ["上下文命中", metrics.contextHit, "rate"], ["证据命中", metrics.evidenceHit, "rate"],
    ["有引用", metrics.hasCitation, "rate"], ["无效引用", metrics.invalidCitation, "rate"],
    ["来源被引用", metrics.sourceCited, "rate"], ["来源被引用（在上下文中）", metrics.sourceCitedInContext, "rate"],
    ...JUDGE_CRITERIA.flatMap((key): Array<[string, number | null, "rate" | "score"]> => [[`${key} 通过`, metrics.pass[key], "rate"], [`${key} 平均分`, metrics.scores[key], "score"]]),
    ["表示资料不足", metrics.refused, "rate"],
    ["上下文字数", summary.contextChars, "count"], ["输入 Token", summary.generation.promptTokens, "count"], ["输出 Token", summary.generation.completionTokens, "count"],
    ["首 Token p50 ms", summary.generation.firstTokenMs.p50, "count"], ["首 Token p95 ms", summary.generation.firstTokenMs.p95, "count"],
    ["生成 p50 ms", summary.generation.totalMs.p50, "count"], ["生成 p95 ms", summary.generation.totalMs.p95, "count"],
  ];
}

const format = (value: number | null, kind: "rate" | "score" | "count") => kind === "rate" ? pct(value) : kind === "score" ? num(value, 2) : num(value);

function printSummary(runFile: AnswerRun, summary: AnswerSummary) {
  const { reliability, usage } = summary;
  console.info(`\n${runFile.name}：${runFile.dataset.name}@${runFile.dataset.version}（${runFile.dataset.split}），${runFile.settings.variant}，上下文 ${runFile.settings.context}（比例为 %，得分为 1～5 分均值）`);
  for (const [label, value, kind] of metricRows(summary)) console.info(`${label.padEnd(14)}${format(value, kind).padStart(8)}`);
  console.info(`题目 ${reliability.total}：已回答 ${summary.overall.questions}、已评审 ${summary.overall.judged}、排除 ${reliability.excluded}、调用失败 ${reliability.errors}、无上下文 ${reliability.noContext}、检索降级 ${reliability.degraded}`);
  console.info(`Token 合计：生成输入 ${usage.generate.promptTokens}、输出 ${usage.generate.completionTokens}；评审输入 ${usage.judge.promptTokens}、输出 ${usage.judge.completionTokens}。按题型、具体度与词面重叠分组的指标见 report.json。`);
}

async function loadRun(ref: string): Promise<{ run: AnswerRun; items: AnswerItem[] }> {
  const dir = join(answersDir, ref);
  if (!existsSync(join(dir, "run.json"))) throw new Error(`Answer run not found: ${ref} (expected .nyz-data/eval-answers/${ref}/run.json)`);
  const run = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as AnswerRun;
  if (run.version !== ANSWER_EVAL_VERSION) throw new Error(`运行 ${ref} 的评估版本为 ${run.version}，当前为 ${ANSWER_EVAL_VERSION}，不能对比`);
  return { run, items: [...(await readItems(join(dir, "items.jsonl"))).values()] };
}

async function compare() {
  const refs = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  if (refs.length !== 2) throw new Error("Usage: evaluate:answer --compare <run A> <run B> [--json]");
  const [a, b] = await Promise.all(refs.map(loadRun));
  if (a.run.dataset.name !== b.run.dataset.name || a.run.dataset.version !== b.run.dataset.version || a.run.dataset.split !== b.run.dataset.split) {
    throw new Error(`Datasets differ: ${a.run.dataset.name}@${a.run.dataset.version}（${a.run.dataset.split}）vs ${b.run.dataset.name}@${b.run.dataset.version}（${b.run.dataset.split}）`);
  }
  const warnings: string[] = [];
  if (JSON.stringify(a.run.models.judge) !== JSON.stringify(b.run.models.judge)) warnings.push("两次运行的审核模型不同，评审得分不能直接比较。");
  if (a.run.corpus.fingerprint !== b.run.corpus.fingerprint) warnings.push("两次运行的语料快照不同。");
  const comparison = compareAnswerRuns(a.items, b.items);
  if (flag("json")) {
    console.log(JSON.stringify({ a: a.run, b: b.run, warnings, comparison }, null, 2));
    return;
  }
  const setup = ({ settings, models }: AnswerRun) => `${settings.variant}，上下文 ${settings.context}/${settings.retrieval.maxContextLength} 字（topK=${settings.retrieval.topK}），Chat ${models.chat.model}，索引 ${settings.schema ?? "业务库"}${settings.citationCheck === undefined ? "" : `，引用校验${settings.citationCheck ? "开启" : "关闭"}`}`;
  console.info(`A：${a.run.name}（${setup(a.run)}）`);
  console.info(`B：${b.run.name}（${setup(b.run)}）`);
  for (const warning of warnings) console.warn(`注意：${warning}`);
  console.info(`\n两边都已评审的题目 ${comparison.questions} 道（比例为 %，得分为 1～5 分均值）`);
  console.info(`${"指标".padEnd(14)}${"A".padStart(8)}${"B".padStart(8)}${"差值".padStart(8)}`);
  const rowsB = metricRows(comparison.b);
  for (const [index, [label, value, kind]] of metricRows(comparison.a).entries()) {
    const other = rowsB[index][1];
    const delta = kind === "rate" ? signed(diff(value, other)) : kind === "score" ? signed(diff(value, other), 1, 2) : signed(diff(value, other), 1, 0);
    console.info(`${label.padEnd(14)}${format(value, kind).padStart(8)}${format(other, kind).padStart(8)}${delta.padStart(8)}`);
  }
  for (const [dimension, title] of [["specificity", "按具体度"], ["type", "按题型"]] as const) {
    const groups = Object.keys(comparison.a.groups[dimension]).map((key) => {
      const [x, y] = [comparison.a.groups[dimension][key], comparison.b.groups[dimension][key]];
      return `${key}（${x.judged} 道）${JUDGE_CRITERIA.slice(0, 2).map((criterion) => signed(diff(x.pass[criterion], y?.pass[criterion] ?? null))).join(" / ")}`;
    });
    console.info(`${title}（faithful / complete 通过率差值）：${groups.join("；")}`);
  }
  const list = (title: string, changes: AnswerChange[]) => {
    console.info(`${title}（${changes.length} 道）${changes.length ? "：" : ""}`);
    for (const change of changes.slice(0, 20)) console.info(`  ${change.id} ${change.from ?? "-"} → ${change.to ?? "-"}  ${change.question}`);
    if (changes.length > 20) console.info(`  ……另有 ${changes.length - 20} 道，完整清单用 --json 输出`);
  };
  for (const key of JUDGE_CRITERIA) {
    list(`${key} 由通过变为未通过`, comparison.changes[key].lost);
    list(`${key} 由未通过变为通过`, comparison.changes[key].gained);
  }
  list("来源文章不再被引用（引用编号）", comparison.sourceCited.lost);
  list("来源文章开始被引用（引用编号）", comparison.sourceCited.gained);
  const unjudged = (items: AnswerItem[]) => answeredItems(items).filter((item) => !item.judgement).length;
  if (unjudged(a.items) || unjudged(b.items)) console.warn(`没有检索到上下文（未评审）的题目不参与对比：A ${unjudged(a.items)} 道，B ${unjudged(b.items)} 道。`);
}

try {
  if (flag("compare")) await compare();
  else await run();
} finally {
  await closeModelAdmissionLimiter();
  await closeDatabase();
}
