import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { answer, REFUSAL } from "../src/answer/answer.js";
import { numbersIn } from "../src/answer/numbers.js";
import { pool } from "../src/db/pool.js";
import { isRelevant, type EvalQuestion } from "../src/eval/metrics.js";
import { sleep } from "../src/services/gemini.js";

const { values } = parseArgs({
  options: {
    questions: { type: "string", default: "eval/questions.json" },
    "per-category": { type: "string", default: "3" },
    negatives: { type: "string", default: "12" },
    delay: { type: "string", default: "4000" },
    only: { type: "string" },
  },
});

const all = JSON.parse(await readFile(values.questions!, "utf8")) as EvalQuestion[];
const perCategory = Number(values["per-category"]);
const categories = [...new Set(all.filter((q) => q.category !== "negative").map((q) => q.category))];
const picked = values.only
  ? all.filter((q) => values.only!.split(",").includes(q.id))
  : [
      ...categories.flatMap((c) => all.filter((q) => q.category === c && q.answer).slice(0, perCategory)),
      ...all.filter((q) => q.category === "negative").slice(0, Number(values.negatives)),
    ];

const rows = [];
for (const [i, q] of picked.entries()) {
  if (i) await sleep(Number(values.delay));
  const res = await answer(q.question);
  const negative = q.category === "negative";
  const refused = res.answer.trim() === REFUSAL;
  const expected = q.answer ? numbersIn(q.answer) : [];
  const found = numbersIn(res.answer);
  const present = expected.filter((n) => found.includes(n));
  const citedSources = res.sources.filter((s) => res.cited.includes(s.id));
  const citedRelevant = citedSources.some((s) =>
    isRelevant(
      { key: s.id, type: (s.type === "endnote_full" ? "endnote" : s.type) as never, pdfPages: s.pdfPages, context: s.context, exhibit: s.exhibit, endnotes: s.endnotes, similarity: 0, text: s.excerpt },
      q.relevant,
    ),
  );

  const row = {
    id: q.id,
    category: q.category,
    question: q.question,
    reference: q.answer ?? null,
    answer: res.answer,
    model: res.model,
    refusalCorrect: negative ? refused : !refused,
    numbersFound: expected.length ? present.length / expected.length : null,
    headlineFound: expected.length ? present.includes(expected[0]!) : null,
    missingNumbers: expected.filter((n) => !present.includes(n)),
    unverifiedNumbers: res.unverifiedNumbers,
    grounded: res.grounded,
    invalidCitations: res.invalidCitations,
    citedRelevantSource: negative ? null : citedRelevant,
    ms: res.ms,
  };
  rows.push(row);
  const ok =
    row.refusalCorrect &&
    row.invalidCitations.length === 0 &&
    row.unverifiedNumbers.length === 0 &&
    (negative || (citedRelevant && (row.numbersFound ?? 1) === 1));
  console.log(`${ok ? "ok " : "!! "}${q.id} [${q.category}] ${q.question}  (${res.model ?? "no LLM call"})`);
  console.log(`     ${res.answer.replace(/\s+/g, " ").slice(0, 300)}`);
  if (row.missingNumbers.length) console.log(`     missing numbers: ${row.missingNumbers.join(", ")} (reference: ${q.answer})`);
  if (row.unverifiedNumbers.length) console.log(`     numbers not in any source: ${row.unverifiedNumbers.join(", ")}`);
  if (!negative && !refused && !citedRelevant) console.log(`     no cited source matches the expected pages/exhibits`);
}

const answerable = rows.filter((r) => r.category !== "negative");
const negatives = rows.filter((r) => r.category === "negative");
const pct = (x: number, n: number) => `${((x / (n || 1)) * 100).toFixed(0)}% (${x}/${n})`;
const withNumbers = answerable.filter((r) => r.numbersFound !== null);
console.log("\nSummary");
console.log(`  answered when answerable:  ${pct(answerable.filter((r) => r.refusalCorrect).length, answerable.length)}`);
console.log(`  refused when out of scope: ${pct(negatives.filter((r) => r.refusalCorrect).length, negatives.length)}`);
console.log(`  answers with citations:    ${pct(answerable.filter((r) => r.grounded).length, answerable.length)}`);
console.log(`  invalid citation ids:      ${rows.reduce((n, r) => n + r.invalidCitations.length, 0)}`);
console.log(`  cites an expected source:  ${pct(answerable.filter((r) => r.citedRelevantSource).length, answerable.length)}`);
console.log(`  headline number present:   ${pct(withNumbers.filter((r) => r.headlineFound).length, withNumbers.length)}`);
console.log(`  all reference figures:     ${pct(withNumbers.filter((r) => r.numbersFound === 1).length, withNumbers.length)}`);
console.log(`  answers with numbers not in sources: ${pct(rows.filter((r) => r.unverifiedNumbers.length).length, rows.length)}`);
console.log(`  models: ${[...new Set(rows.map((r) => r.model ?? "none"))].join(", ")}`);
console.log(`  median latency:            ${[...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]}ms`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
await writeFile(`eval/results/${stamp}-answers.json`, JSON.stringify(rows, null, 2));
console.log(`\nSaved eval/results/${stamp}-answers.json`);
await pool.end();
