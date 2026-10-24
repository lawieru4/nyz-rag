// 用法：pnpm --filter @nyz-rag/processing evaluate:compare <运行A> <运行B> [--variant=fused,rerank | --variant=fused:rerank] [--json]
// 运行可以写运行名（取 .nyz-data/eval-runs/ 中该名称最新的一次）或运行记录的路径。--variant 默认取两次运行共有的变体，
// 「a:b」表示 A 的变体 a 对比 B 的变体 b（同一次运行内对比两个变体时两个参数写同一个运行）。方案见 docs/evaluation-plan.md 第 8.3 节。
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareRuns, comparisonWarnings, HIT_KS, RETRIEVAL_VARIANTS, RUN_SCHEMA_VERSION, type HybridMetrics, type MetricsDelta, type RankMove, type RetrievalVariant, type RunComparison, type RunRecord } from "../evaluation-run.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const runsDir = join(repoRoot, ".nyz-data/eval-runs");
const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const LISTED_MOVES = 20;

async function loadRun(ref: string): Promise<{ path: string; run: RunRecord }> {
  // pnpm 在包目录运行脚本，相对路径按调用命令时的目录解析。
  const direct = resolve(process.env.INIT_CWD ?? process.cwd(), ref);
  let path = ref.endsWith(".json") && existsSync(direct) ? direct : undefined;
  if (!path) {
    const matches = existsSync(runsDir) ? (await readdir(runsDir)).filter((file) => file.match(/^\d{8}-\d{6}-(.+)\.json$/)?.[1] === ref).sort() : [];
    if (!matches.length) throw new Error(`Run not found: ${ref} (expected a run name in .nyz-data/eval-runs or a path to a run record)`);
    path = join(runsDir, matches.at(-1)!);
  }
  const run = JSON.parse(await readFile(path, "utf8")) as RunRecord;
  if (run.schemaVersion !== RUN_SCHEMA_VERSION) throw new Error(`Unsupported run record schemaVersion ${String(run.schemaVersion)}: ${path}`);
  return { path, run };
}

function variantPairs(a: RunRecord, b: RunRecord): Array<[RetrievalVariant, RetrievalVariant]> {
  const raw = arg("variant");
  const pairs: Array<[RetrievalVariant, RetrievalVariant]> = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
      const [left, right = left] = value.split(":") as [RetrievalVariant, RetrievalVariant?];
      return [left, right];
    })
    : a.variants.filter((variant) => b.variants.includes(variant)).map((variant) => [variant, variant]);
  if (!pairs.length) throw new Error("The two runs have no variant in common; pass --variant=<A 的变体>:<B 的变体>");
  for (const [left, right] of pairs) {
    if (!RETRIEVAL_VARIANTS.includes(left) || !RETRIEVAL_VARIANTS.includes(right)) throw new Error(`Unknown variant in --variant=${raw}`);
    if (!a.variants.includes(left)) throw new Error(`Run A has no variant ${left}`);
    if (!b.variants.includes(right)) throw new Error(`Run B has no variant ${right}`);
  }
  return pairs;
}

const pct = (value: number | null) => value === null ? "-" : (value * 100).toFixed(1);
const signed = (value: number | null) => value === null ? "-" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}`;
const rankText = (rank: number | null) => rank === null ? "无" : String(rank);

function metricRows(a: HybridMetrics, b: HybridMetrics, delta: MetricsDelta): Array<[string, number | null, number | null, number | null]> {
  return [
    ...HIT_KS.map((k): [string, number, number, number] => [`Hit@${k}`, a.hitAt[String(k)], b.hitAt[String(k)], delta.hitAt[String(k)]]),
    ["MRR", a.mrr, b.mrr, delta.mrr],
    ["证据命中", a.evidenceHit, b.evidenceHit, delta.evidenceHit],
    ["全部证据", a.evidenceFull, b.evidenceFull, delta.evidenceFull],
    ["上下文命中", a.contextHit, b.contextHit, delta.contextHit],
  ];
}

const chars = (value: number | null) => value === null ? "-" : String(Math.round(value));
const signedChars = (value: number | null) => value === null ? "-" : `${value > 0 ? "+" : ""}${Math.round(value)}`;

function printComparison(comparison: RunComparison) {
  const [left, right] = comparison.variants;
  console.info(`\n## ${left} → ${right}：两边都有效的题目 ${comparison.questions} 道（指标为 %）`);
  console.info(`${"指标".padEnd(8)}${"A".padStart(8)}${"B".padStart(8)}${"差值".padStart(8)}`);
  for (const [label, a, b, delta] of metricRows(comparison.a, comparison.b, comparison.delta)) console.info(`${label.padEnd(8)}${pct(a).padStart(8)}${pct(b).padStart(8)}${signed(delta).padStart(8)}`);
  console.info(`${"上下文字数".padEnd(8)}${chars(comparison.a.contextChars).padStart(7)}${chars(comparison.b.contextChars).padStart(8)}${signedChars(comparison.delta.contextChars).padStart(8)}`);
  for (const [dimension, title] of [["specificity", "按具体度"], ["type", "按题型"]] as const) {
    console.info(`${title}（Hit@10 / MRR 差值）：${Object.entries(comparison.groups[dimension]).map(([key, group]) => `${key}（${group.a.questions} 道）${signed(group.delta.hitAt["10"])} / ${signed(group.delta.mrr)}`).join("；")}`);
  }
  console.info(`来源文章名次：上升 ${comparison.ranks.improved}、下降 ${comparison.ranks.worsened}、不变 ${comparison.ranks.unchanged}`);
  const list = (title: string, moves: RankMove[]) => {
    console.info(`${title}（${moves.length} 道）${moves.length ? "：" : ""}`);
    for (const move of moves.slice(0, LISTED_MOVES)) console.info(`  ${move.id} ${rankText(move.from)} → ${rankText(move.to)}  ${move.question}`);
    if (moves.length > LISTED_MOVES) console.info(`  ……另有 ${moves.length - LISTED_MOVES} 道，完整清单用 --json 输出`);
  };
  list("进入前 10", comparison.moves.enteredTop10);
  list("跌出前 10", comparison.moves.leftTop10);
  list("进入前 5", comparison.moves.enteredTop5);
  list("跌出前 5", comparison.moves.leftTop5);
  list("证据由未命中变为命中", comparison.evidence.gained);
  list("证据由命中变为未命中", comparison.evidence.lost);
}

const setup = (run: RunRecord) => `上下文 ${run.settings.context ?? "topk"}/${run.settings.retrieval.maxContextLength} 字，索引 ${run.settings.schema ?? "业务库"}（切片规则 ${run.corpus.chunkerVersion ?? 1}）`;

const refs = process.argv.slice(2).filter((value) => !value.startsWith("--"));
if (refs.length !== 2) throw new Error("Usage: evaluate:compare <run A> <run B> [--variant=fused | --variant=fused:rerank] [--json]");
const [a, b] = await Promise.all(refs.map(loadRun));
const warnings = comparisonWarnings(a.run, b.run);
const comparisons = variantPairs(a.run, b.run).map(([left, right]) => compareRuns(a.run, b.run, left, right));
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ a: a.path, b: b.path, warnings, comparisons }, null, 2));
} else {
  console.info(`A：${a.run.name}（${a.run.createdAt}，${setup(a.run)}）${a.path}`);
  console.info(`B：${b.run.name}（${b.run.createdAt}，${setup(b.run)}）${b.path}`);
  console.info(`数据集 ${a.run.dataset.name}@${a.run.dataset.version}（${a.run.dataset.split}）`);
  for (const warning of warnings) console.warn(`注意：${warning}`);
  comparisons.forEach(printComparison);
}
