import { parseArgs } from "node:util";
import { answerStream } from "../src/answer/answer.js";
import { pool } from "../src/db/pool.js";
import type { RerankerName } from "../src/search/rerank.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rerank: { type: "string" },
    sources: { type: "boolean", default: false },
  },
});

const question = positionals.join(" ");
if (!question) throw new Error('Usage: npm run ask -- "your question" [--sources] [--rerank minilm]');

for await (const event of answerStream(question, { reranker: values.rerank as RerankerName | undefined })) {
  if (event.type === "sources") {
    console.log(`route: ${event.route.kind} - ${event.route.reason}`);
    console.log(`retrieved ${event.sources.length} sources (top score ${event.topScore.toFixed(3)})${event.answerable ? "" : " -> below the relevance gate"}`);
    if (values.sources) for (const s of event.sources) console.log(`  ${s.id} ${s.citation} ${s.type}${s.usedParent ? " (parent)" : ""} ${s.score.toFixed(3)} ${s.context.slice(0, 100)}`);
    console.log("");
  } else if (event.type === "delta") {
    process.stdout.write(event.text);
  } else {
    const { promptTokens, outputTokens, thoughtTokens } = event.usage;
    console.log(`\n\n[${event.ms}ms | ${event.model ?? "no LLM call"} | cited ${event.cited.join(", ") || "none"}${event.invalidCitations.length ? ` | invalid ${event.invalidCitations.join(", ")}` : ""}` +
      ` | grounded ${event.grounded} | unverified numbers ${event.unverifiedNumbers.join(", ") || "none"} | tokens in ${promptTokens}, out ${outputTokens}, thinking ${thoughtTokens}]`);
  }
}

await pool.end();
