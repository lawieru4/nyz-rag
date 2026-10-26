// 用法：pnpm --filter @nyz-rag/processing evaluate:multiturn --name=<数据集名> --from=<单轮数据集> [--split=dev|test] [--seed=20261026] [--limit=N] [--concurrency=2]
//       pnpm --filter @nyz-rag/processing evaluate:multiturn --name=<数据集名> --freeze [--out=<JSON 路径>]
// 从已冻结的单轮合成数据集派生多轮追问评估题：每道原问题由 Chat 模型改写为「引出对象的第一轮问答 + 用指代或省略追问的第二轮」，
// 程序校验后由审核模型（业务模型 review）审核，失败时带原因重试；会调用模型，产生费用。
// 首次运行记录来源数据集与题目顺序，每次尝试追加到 .nyz-data/evaluation/<名称>/items.jsonl，中断后重新运行从未完成的题目继续；--limit 只处理前 N 道（试点）。
// --freeze 导出 schemaVersion 2 数据集：通过审核的追问题（type followup），以及同样数量、不调用模型配对的换话题题。方案见 docs/evaluation-plan.md 第 8.10 节。
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase } from "../db.js";
import { filterSplit, readEvaluationDataset, SPLITS, validateEvaluationDataset, type CorpusSnapshot, type EvaluationDataset, type EvaluationQuestion, type Split } from "../evaluation.js";
import { closeModelAdmissionLimiter } from "../model-admission.js";
import { createChatModel, type ChatMessage, type ChatModel } from "../models.js";
import {
  checkFollowup, FOLLOWUP_REVIEW_CRITERIA, followupFailureCategory, followupMessages, followupOrder, followupQuestion, followupReviewMessages, MAX_FOLLOWUP_ATTEMPTS,
  MULTITURN_PROMPT_VERSION, parseFollowup, parseFollowupReview, topicSwitchQuestions, type ApprovedFollowup, type FollowupReview, type FollowupReviewCriterion, type GeneratedFollowup,
} from "../multiturn-questions.js";
import { usableModel } from "../provider.js";
import { getModelSelection } from "../repository.js";
import { evidenceSource, parseModelJson, type CorpusArticle } from "../synthetic-questions.js";
import { loadCorpus, staleQuestionReason } from "./evaluation-corpus.js";

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
// pnpm 在包目录运行脚本，相对路径按调用命令时的目录解析。
const invocationDir = process.env.INIT_CWD ?? process.cwd();
const name = arg("name");
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("--name is required (lowercase letters, digits and dashes), e.g. --name=nyz-rag-multiturn-v1");
const workDir = join(repoRoot, ".nyz-data/evaluation", name);
const sourcePath = join(workDir, "source.json");
const itemsPath = join(workDir, "items.jsonl");

const CRITERION_LABELS: Record<FollowupReviewCriterion, string> = {
  dependent: "追问不依赖历史", resolvable: "指代不能唯一确定", equivalent: "与原问题不等价", natural: "对话不自然或第一轮提前作答",
};

/** source.json：来源数据集、范围与题目顺序，首次运行时写入，之后不变。 */
interface SourceFile {
  name: string;
  from: { path: string; name: string; version: string; corpus?: CorpusSnapshot };
  split: Split | "all";
  seed: number;
  createdAt: string;
  /** 按种子哈希排列的原问题 ID。 */
  order: string[];
}

interface Usage { promptTokens: number; completionTokens: number }

interface AttemptRecord {
  baseId: string;
  /** 失败（error）不计入尝试次数，下次运行重新尝试。 */
  status: "retry" | "approved" | "rejected" | "error";
  attempt: number;
  at: string;
  promptVersion: number;
  generatorModel: string;
  reviewerModel: string;
  generated?: GeneratedFollowup;
  raw?: string;
  failures: string[];
  review?: FollowupReview;
  usage: { generate: Usage; review: Usage };
  error?: string;
}

async function loadOrCreateSource(): Promise<{ source: SourceFile; dataset: EvaluationDataset }> {
  if (existsSync(sourcePath)) {
    const source = JSON.parse(await readFile(sourcePath, "utf8")) as SourceFile;
    if (arg("from") && resolve(invocationDir, arg("from")!) !== resolve(repoRoot, source.from.path)) throw new Error(`Work dir already derives from ${source.from.path}; use a new --name for another dataset`);
    const dataset = await readEvaluationDataset(resolve(repoRoot, source.from.path));
    if (dataset.name !== source.from.name || dataset.version !== source.from.version) throw new Error(`Source dataset changed: ${source.from.name}@${source.from.version} → ${dataset.name}@${dataset.version}; use a new --name`);
    return { source, dataset };
  }
  const from = arg("from");
  if (!from) throw new Error("--from=<frozen single-turn dataset> is required on the first run");
  const path = resolve(invocationDir, from);
  const dataset = await readEvaluationDataset(path);
  const errors = validateEvaluationDataset(dataset);
  if (errors.length) throw new Error(`Source dataset invalid:\n${errors.join("\n")}`);
  const split = arg("split") as Split | undefined;
  if (split !== undefined && !SPLITS.includes(split)) throw new Error("--split must be dev or test");
  // 只从可回答、单轮、有标注的题目派生。
  const eligible = filterSplit(dataset, split).questions.filter((question) => question.answerable && !question.history.length && question.labels.some((label) => label.relevance >= 2));
  if (!eligible.length) throw new Error("No eligible single-turn questions in the source dataset");
  const seed = positiveInt("seed", 20261026)!;
  const source: SourceFile = {
    name: name!, from: { path: relative(repoRoot, path).replaceAll("\\", "/"), name: dataset.name, version: dataset.version, ...(dataset.corpus ? { corpus: dataset.corpus } : {}) },
    split: split ?? "all", seed, createdAt: new Date().toISOString(), order: followupOrder(eligible, seed).map((question) => question.id),
  };
  await mkdir(workDir, { recursive: true });
  await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  console.info(`来源 ${dataset.name}@${dataset.version}（${source.split}），可派生 ${source.order.length} 道，写入 ${sourcePath}`);
  return { source, dataset };
}

/** 只读取当前提示版本的记录；提示或校验规则变化后，旧版本的结果保留在文件中但不再计入。 */
async function readAttempts(): Promise<Map<string, AttemptRecord[]>> {
  const attempts = new Map<string, AttemptRecord[]>();
  if (!existsSync(itemsPath)) return attempts;
  for (const line of (await readFile(itemsPath, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as AttemptRecord;
    if (record.promptVersion !== MULTITURN_PROMPT_VERSION) continue;
    attempts.set(record.baseId, [...(attempts.get(record.baseId) ?? []), record]);
  }
  return attempts;
}

const finalStatus = (records: AttemptRecord[] | undefined) => {
  const last = records?.filter((record) => record.status !== "error").at(-1);
  return last?.status === "approved" || last?.status === "rejected" ? last : undefined;
};

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

async function generate(source: SourceFile, questions: Map<string, EvaluationQuestion>, articles: Map<string, CorpusArticle>) {
  const [chat, review] = await Promise.all([getModelSelection("chat"), getModelSelection("review")]);
  const generatorSelection = usableModel(chat);
  const reviewerSelection = usableModel(review);
  if (!generatorSelection) throw new Error("未配置可用的 Chat 模型（业务模型 chat）");
  if (!reviewerSelection) throw new Error("未配置可用的审核模型（业务模型 review），不会改用 Chat 模型");
  if (generatorSelection.provider.id === reviewerSelection.provider.id && generatorSelection.model.trim() === reviewerSelection.model.trim()) console.warn("审核模型与 Chat 模型相同，建议选用不同的模型。");
  const generator = createChatModel(generatorSelection);
  const reviewer = createChatModel(reviewerSelection);

  const attempts = await readAttempts();
  const scope = source.order.slice(0, positiveInt("limit") ?? source.order.length);
  const pending = scope.filter((id) => !finalStatus(attempts.get(id)));
  console.info(`本次范围 ${scope.length} 道，待处理 ${pending.length} 道；生成 ${generator.model}，审核 ${reviewer.model}`);

  let writes = Promise.resolve();
  const append = (record: AttemptRecord) => {
    attempts.set(record.baseId, [...(attempts.get(record.baseId) ?? []), record]);
    writes = writes.then(() => appendFile(itemsPath, `${JSON.stringify(record)}\n`));
    return writes;
  };

  let done = 0;
  async function processBase(id: string) {
    const base = questions.get(id);
    const stale = base ? staleQuestionReason(base, articles) : "原问题已不在来源数据集中";
    if (!base || stale) {
      console.warn(`跳过 ${id}：${stale}`);
      return;
    }
    const article = articles.get(base.labels.find((label) => label.relevance >= 2)!.articleKey)!;
    const previous = attempts.get(id) ?? [];
    let attempt = previous.filter((record) => record.status !== "error").length;
    let feedback = previous.filter((record) => record.status === "retry").at(-1)?.failures ?? [];
    while (attempt < MAX_FOLLOWUP_ATTEMPTS) {
      attempt += 1;
      const record: AttemptRecord = {
        baseId: id, status: "retry", attempt, at: new Date().toISOString(), promptVersion: MULTITURN_PROMPT_VERSION,
        generatorModel: generator.model, reviewerModel: reviewer.model, failures: [],
        usage: { generate: { promptTokens: 0, completionTokens: 0 }, review: { promptTokens: 0, completionTokens: 0 } },
      };
      try {
        const text = await complete(generator, followupMessages(article, base, feedback), record.usage.generate);
        try {
          record.generated = parseFollowup(parseModelJson(text));
        } catch (error) {
          record.raw = text.slice(0, 1000);
          record.failures.push(`格式错误：${error instanceof Error ? error.message : "无法解析"}，只输出一个 JSON 对象`);
        }
        if (record.generated) record.failures.push(...checkFollowup(record.generated, base));
        if (!record.failures.length) {
          const reviewText = await complete(reviewer, followupReviewMessages(base, record.generated!), record.usage.review);
          // 审核输出无法解析是审核模型的问题，记为 error，下次运行重新处理。
          record.review = parseFollowupReview(parseModelJson(reviewText));
          if (!record.review.passed) {
            const failed = FOLLOWUP_REVIEW_CRITERIA.filter((key) => (record.review!.scores[key] ?? 0) < 4).map((key) => `${CRITERION_LABELS[key]}（${record.review!.scores[key] ?? "无"} 分）`);
            record.failures.push(`审核未通过：${failed.join("、")}${record.review.reason ? `。${record.review.reason}` : ""}`);
          }
        }
      } catch (error) {
        record.status = "error";
        record.error = error instanceof Error ? error.message : "unknown error";
        await append(record);
        console.warn(`${id} 调用失败，下次运行重试：${record.error}`);
        return;
      }
      record.status = record.failures.length ? (attempt >= MAX_FOLLOWUP_ATTEMPTS ? "rejected" : "retry") : "approved";
      await append(record);
      if (record.status !== "retry") break;
      feedback = record.failures;
    }
    done += 1;
    console.info(`[${done}/${pending.length}] ${id} → ${finalStatus(attempts.get(id))?.status ?? "pending"}（第 ${attempt} 次）`);
  }

  const concurrency = positiveInt("concurrency", 2)!;
  const queue = [...pending];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) await processBase(id);
  }));
  await writes;
  await writeReport(scope, questions, attempts);
}

const addUsage = (total: Usage, usage: Usage) => { total.promptTokens += usage.promptTokens; total.completionTokens += usage.completionTokens; };
const count = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };

async function writeReport(scope: string[], questions: Map<string, EvaluationQuestion>, attempts: Map<string, AttemptRecord[]>) {
  const statuses: Record<string, number> = {};
  const failureCategories: Record<string, number> = {};
  const reviewFailures: Record<string, number> = {};
  const usage = { generate: { promptTokens: 0, completionTokens: 0 }, review: { promptTokens: 0, completionTokens: 0 } };
  let errors = 0;
  const preview: string[] = [`# ${name} 生成预览`, "", `范围 ${scope.length} 道；提示版本 ${MULTITURN_PROMPT_VERSION}；生成于 ${new Date().toISOString()}`, ""];
  for (const id of scope) {
    const records = attempts.get(id) ?? [];
    for (const record of records) {
      addUsage(usage.generate, record.usage.generate);
      addUsage(usage.review, record.usage.review);
      if (record.status === "error") { errors += 1; continue; }
      for (const failure of record.failures) count(failureCategories, followupFailureCategory(failure));
      if (record.review) for (const key of FOLLOWUP_REVIEW_CRITERIA) if ((record.review.scores[key] ?? 0) < 4) count(reviewFailures, key);
    }
    const final = finalStatus(records);
    count(statuses, final?.status ?? "pending");
    if (!final) continue;
    preview.push(`## ${final.status === "approved" ? "✅" : "❌"} ${id}｜${questions.get(id)?.type ?? "-"}`, "", `- 原问题：${questions.get(id)?.question ?? "-"}`);
    if (final.generated) {
      const { entity, opening, openingAnswer, followup } = final.generated;
      preview.push(`- 对象：${entity}`, `- 第一轮：${opening}`, `- 第一轮回答：${openingAnswer}`, `- 追问：${followup}`);
    }
    if (final.status === "approved" && final.review) {
      preview.push(`- 审核得分：${FOLLOWUP_REVIEW_CRITERIA.map((key) => `${key} ${final.review!.scores[key] ?? "-"}`).join(" / ")}`, `- 审核分析：${final.review.analysis}`);
    } else preview.push(...final.failures.map((failure) => `- ${failure}`));
    preview.push("");
  }
  const approved = statuses.approved ?? 0;
  const finished = approved + (statuses.rejected ?? 0);
  const report = {
    name, scope: scope.length, promptVersion: MULTITURN_PROMPT_VERSION, statuses,
    passRate: finished ? Math.round((approved / finished) * 1000) / 1000 : null,
    failureCategories, reviewFailures, callErrors: errors, usage,
  };
  await writeFile(join(workDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(workDir, "preview.md"), `${preview.join("\n")}\n`);
  console.info(JSON.stringify(report, null, 2));
  console.info(`报告：${join(workDir, "report.json")}；逐题预览：${join(workDir, "preview.md")}`);
}

async function freeze(source: SourceFile, questions: Map<string, EvaluationQuestion>, articles: Map<string, CorpusArticle>) {
  const attempts = await readAttempts();
  const unfinished = source.order.filter((id) => !finalStatus(attempts.get(id)) && questions.has(id) && !staleQuestionReason(questions.get(id)!, articles));
  if (unfinished.length) throw new Error(`${unfinished.length} 道原问题尚未完成，请先运行生成（不带 --limit）`);
  const approved: ApprovedFollowup[] = [];
  const models = { generator: new Set<string>(), reviewer: new Set<string>() };
  let rejected = 0;
  let stale = 0;
  for (const id of source.order) {
    const base = questions.get(id);
    if (!base || staleQuestionReason(base, articles)) { stale += 1; continue; }
    const final = finalStatus(attempts.get(id))!;
    if (final.status !== "approved") { rejected += 1; continue; }
    models.generator.add(final.generatorModel);
    models.reviewer.add(final.reviewerModel);
    approved.push({ base, generated: final.generated! });
  }
  const followups = approved.map(followupQuestion);
  const switches = topicSwitchQuestions(approved, source.seed);
  const dataset: EvaluationDataset = {
    schemaVersion: 2,
    name: source.name,
    version: new Date().toISOString().slice(0, 10),
    provenance: `Synthetic multi-turn questions derived by an LLM from the synthetic single-turn dataset ${source.from.name}@${source.from.version}, auto-checked and LLM-reviewed; not real user dialogues and not human validated. `
      + "Followups (type followup) replace the core object of the original question with a pronoun or ellipsis after a synthetic first turn; topic-switch items pair an original question with an unrelated first turn. Labels are inherited from the original questions (single-source).",
    ...(source.from.corpus ? { corpus: source.from.corpus } : {}),
    generation: {
      from: `${source.from.name}@${source.from.version}`, split: source.split, seed: source.seed, generatorModel: [...models.generator].join(", "), reviewerModel: [...models.reviewer].join(", "),
      promptVersion: MULTITURN_PROMPT_VERSION, followups: followups.length, topicSwitches: switches.length, rejected, stale,
    },
    questions: [...followups, ...switches],
  };
  const evidenceByArticle = new Map([...articles].map(([key, article]) => [key, evidenceSource(article, "metadata")]));
  const errors = validateEvaluationDataset(dataset, { corpusArticleKeys: articles.keys(), evidenceByArticle });
  if (errors.length) throw new Error(`Frozen dataset invalid:\n${errors.join("\n")}`);
  const out = resolve(invocationDir, arg("out") ?? join(repoRoot, "packages/processing/test/evaluation", `${source.name}.json`));
  await writeFile(out, `${JSON.stringify(dataset, null, 2)}\n`);
  console.info(`已冻结追问 ${followups.length} 道、换话题 ${switches.length} 道（未通过 ${rejected}，跳过 ${stale}）→ ${out}`);
}

try {
  const { source, dataset } = await loadOrCreateSource();
  const questions = new Map(dataset.questions.map((question) => [question.id, question]));
  const { articles } = await loadCorpus();
  const byKey = new Map(articles.map((article) => [article.articleKey, article]));
  if (flag("freeze")) await freeze(source, questions, byKey);
  else await generate(source, questions, byKey);
} finally {
  await closeModelAdmissionLimiter();
  await closeDatabase();
}
