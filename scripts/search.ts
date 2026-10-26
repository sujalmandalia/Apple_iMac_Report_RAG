import { parseArgs } from "node:util";
import type { ChunkType } from "../src/chunking/types.js";
import { pool } from "../src/db/pool.js";
import type { SearchMode } from "../src/search/hybrid.js";
import type { RerankerName } from "../src/search/rerank.js";
import { retrieve } from "../src/search/retrieve.js";
import { citationOf } from "../src/search/vector.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    k: { type: "string", default: "5" },
    type: { type: "string" },
    section: { type: "string" },
    variant: { type: "string" },
    full: { type: "boolean", default: false },
    mode: { type: "string", default: "hybrid" },
    rerank: { type: "string" },
  },
});

const query = positionals.join(" ");
if (!query) throw new Error('Usage: npm run search -- "your question" [--k 5] [--type table_row,chart] [--section "carbon"] [--variant "four ports"] [--full]');

const started = Date.now();
const result = await retrieve(query, {
  k: Number(values.k),
  mode: values.mode as SearchMode,
  reranker: values.rerank as RerankerName | undefined,
  filters: { types: values.type?.split(",") as ChunkType[] | undefined, section: values.section, variant: values.variant },
});
const hits = result.hits;
console.log(`"${query}" [${values.mode} + ${result.reranker}] -> ${hits.length} hits in ${Date.now() - started}ms`);
console.log(
  result.answerable
    ? `top score ${result.topScore.toFixed(3)} >= gate ${result.minScore}\n`
    : `NOT ANSWERABLE: top score ${result.topScore.toFixed(3)} < gate ${result.minScore}\n`,
);

for (const [i, h] of hits.entries()) {
  const ranks = Object.entries(h.ranks).filter(([, r]) => r).map(([name, r]) => `${name[0]}#${r}`).join(" ");
  console.log(`${i + 1}. score ${h.rerankScore.toFixed(3)}  sim ${h.similarity.toFixed(3)}  [${ranks}]  ${h.key} ${h.type}  ${citationOf(h)}  ${h.context.slice(0, 120)}`);
  if (h.endnotes.length) console.log(`   endnotes: ${h.endnotes.join(", ")}`);
  if (h.matchedTerms.length) console.log(`   terms: ${h.matchedTerms.join(", ")}`);
  console.log(`   ${values.full ? h.text : h.text.replace(/\s+/g, " ").slice(0, 220) + "..."}\n`);
}

await pool.end();
