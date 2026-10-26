import { readdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import type { ChunkSet } from "../src/chunking/types.js";
import { isRelevant, scoreQuestion, summarize, type EvalQuestion, type Hit, type QuestionResult, type Summary } from "../src/eval/metrics.js";
import { search } from "../src/search/hybrid.js";
import type { SearchMode } from "../src/search/hybrid.js";
import { RERANKERS, type RerankerName } from "../src/search/rerank.js";
import { retrieve as retrievePipeline } from "../src/search/retrieve.js";
import { primeQueryCache, queryCacheEntries } from "../src/search/vector.js";

const { values } = parseArgs({
  options: {
    questions: { type: "string", default: "eval/questions.json" },
    retriever: { type: "string", default: "vector" },
    label: { type: "string" },
    k: { type: "string", default: "10" },
    verbose: { type: "boolean", short: "v", default: false },
    compare: { type: "string" },
    "keyword-weight": { type: "string", default: "0.5" },
    candidates: { type: "string", default: "30" },
    reranker: { type: "string", default: "none" },
    "rerank-candidates": { type: "string", default: "24" },
  },
});

const RETRIEVERS: Record<string, (query: string, k: number) => Promise<Hit[]>> = {
  vector: (query, k) => search(query, { k, mode: "vector" }),
  keyword: (query, k) => search(query, { k, mode: "keyword" }),
  hybrid: (query, k) =>
    search(query, {
      k,
      mode: "hybrid",
      candidates: Number(values.candidates),
      weights: { vector: 1, keyword: Number(values["keyword-weight"]), exhibit: 1 },
    }),
};

const baseRetriever = RETRIEVERS[values.retriever!];
if (!baseRetriever) throw new Error(`Unknown retriever "${values.retriever}". Options: ${Object.keys(RETRIEVERS).join(", ")}`);
const reranker = values.reranker as RerankerName;
if (!RERANKERS.includes(reranker)) throw new Error(`Unknown reranker "${reranker}". Options: ${RERANKERS.join(", ")}`);

const retrieve = async (query: string, k: number): Promise<Hit[]> => {
  if (reranker === "none") return baseRetriever(query, k);
  const result = await retrievePipeline(query, {
    k,
    mode: values.retriever as SearchMode,
    reranker,
    candidates: Number(values["rerank-candidates"]),
    minScore: 0,
  });
  return result.candidates.slice(0, k);
};

const CACHE_FILE = "data/query-embeddings.json";
const cacheTag = `${config.gemini.embeddingModel}@${config.gemini.embeddingDimensions}`;
try {
  const cache = JSON.parse(await readFile(CACHE_FILE, "utf8")) as { tag: string; entries: [string, number[]][] };
  if (cache.tag === cacheTag) primeQueryCache(cache.entries);
} catch {}

const questions = JSON.parse(await readFile(values.questions!, "utf8")) as EvalQuestion[];
const { chunks } = JSON.parse(await readFile("data/chunks.json", "utf8")) as ChunkSet;
const unanswerable = questions.filter(
  (q) => q.relevant.length && !chunks.some((c) => isRelevant({ ...c, key: c.id, similarity: 0 }, q.relevant)),
);
if (unanswerable.length) {
  console.error(`No chunk matches the expected sources of: ${unanswerable.map((q) => q.id).join(", ")}. Fix eval/questions.json.`);
  process.exit(1);
}

const k = Number(values.k);
const started = Date.now();
const results: QuestionResult[] = [];
for (const q of questions) results.push(scoreQuestion(q, await retrieve(q.question, k)));
await writeFile(CACHE_FILE, JSON.stringify({ tag: cacheTag, entries: queryCacheEntries() }));

const answerable = results.filter((r) => r.category !== "negative");
const negatives = results.filter((r) => r.category === "negative");
const overall = summarize(answerable);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(6);
const row = (name: string, s: Summary) =>
  `  ${name.padEnd(10)} ${String(s.questions).padStart(3)}  ${pct(s.hitAt1)}  ${pct(s.recallAt3)}  ${pct(s.recallAt5)}  ${pct(s.recallAt10)}  ${s.mrr.toFixed(3)}`;

console.log(`Retriever "${values.retriever}", reranker "${reranker}", k=${k}, ${questions.length} questions, ${Date.now() - started}ms\n`);
console.log("  category     n   hit@1     r@3     r@5    r@10    MRR");
console.log(row("ALL", overall));
for (const category of [...new Set(answerable.map((r) => r.category))].sort()) {
  console.log(row(category, summarize(answerable.filter((r) => r.category === category))));
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? `min ${s[0]!.toFixed(3)}  median ${s[Math.floor(s.length / 2)]!.toFixed(3)}  max ${s.at(-1)!.toFixed(3)}` : "-";
};
const answerableTop = answerable.map((r) => r.topScore);
const negativeTop = negatives.map((r) => r.topScore);
console.log(`\nTop-1 ${reranker === "none" ? "similarity" : `${reranker} score`} (relevance gate input):`);
console.log(`  answerable:   ${stats(answerableTop)}`);
console.log(`  out-of-scope: ${stats(negativeTop)}`);

const thresholds = [...new Set([...answerableTop, ...negativeTop].map((x) => Math.round(x * 100) / 100))].sort((a, b) => a - b);
const gate = thresholds.map((t) => {
  const kept = answerableTop.filter((x) => x >= t).length / (answerableTop.length || 1);
  const refused = negativeTop.filter((x) => x < t).length / (negativeTop.length || 1);
  return { t, kept, refused, balanced: (kept + refused) / 2 };
});
const best = Math.max(...gate.map((g) => g.balanced));
const chosen = gate.filter((g) => g.balanced === best);
const suggestion = chosen[Math.floor((chosen.length - 1) / 2)];
if (negatives.length && suggestion) {
  console.log(
    `  gate at ${suggestion.t.toFixed(2)}: answers ${pct(suggestion.kept)} of answerable questions, refuses ${pct(suggestion.refused)} of out-of-scope` +
      ` (range with the same accuracy: ${chosen[0]!.t.toFixed(2)}-${chosen.at(-1)!.t.toFixed(2)})`,
  );
}

const misses = answerable.filter((r) => r.firstRelevantRank === null || r.firstRelevantRank > 5);
if (misses.length) {
  console.log(`\nMissed in top 5 (${misses.length}):`);
  for (const r of misses) {
    console.log(`  ${r.id} [${r.category}] ${r.question}  -> first relevant at ${r.firstRelevantRank ?? `>${k}`}`);
    if (values.verbose) {
      for (const h of r.hits.slice(0, 3)) console.log(`      ${h.score.toFixed(3)} ${h.key} ${h.type} p.${h.pages.join(",")} ${h.context.slice(0, 90)}`);
    }
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const label = values.label ?? (reranker === "none" ? values.retriever! : `${values.retriever}+${reranker}`);
const outFile = `eval/results/${stamp}-${label}.json`;
await writeFile(outFile, JSON.stringify({ label, retriever: values.retriever, reranker, k, summary: overall, gate: suggestion, results }, null, 2));
console.log(`\nSaved ${outFile}`);

const previous = values.compare
  ? values.compare
  : (await readdir("eval/results")).filter((f) => f.endsWith(".json") && `eval/results/${f}` !== outFile).sort().at(-1);
if (previous) {
  const path = previous.includes("/") ? previous : `eval/results/${previous}`;
  const base = JSON.parse(await readFile(path, "utf8")) as { label: string; summary: Summary };
  const delta = (key: keyof Summary) => {
    const d = (overall[key] as number) - (base.summary[key] as number);
    return `${key} ${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}`;
  };
  console.log(`vs ${path} (${base.label}): ${(["hitAt1", "recallAt5", "mrr"] as const).map(delta).join(", ")}`);
}

await pool.end();
