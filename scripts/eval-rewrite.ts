import { readFile } from "node:fs/promises";
import { rewriteQuestion } from "../src/chat/rewrite.js";
import { sleep } from "../src/services/gemini.js";

interface Case {
  history: [string, string][];
  message: string;
  mustInclude?: string[];
  standalone?: boolean;
  kind?: "question" | "chitchat";
}

const cases = JSON.parse(await readFile("eval/conversations.json", "utf8")) as Case[];
let passed = 0;
for (const [i, c] of cases.entries()) {
  if (i) await sleep(2000);
  const history = c.history.map(([question, answer]) => ({ question, standalone: question, answer }));
  const r = await rewriteQuestion(history, c.message);
  const missing = (c.mustInclude ?? []).filter((w) => !r.question.toLowerCase().includes(w.toLowerCase()));
  const ok = missing.length === 0 && r.kind === (c.kind ?? "question") && (!c.standalone || !r.rewritten);
  if (ok) passed++;
  console.log(`${ok ? "ok " : "!! "}"${c.message}" -> [${r.kind}] ${r.question}${missing.length ? `  (missing: ${missing.join(", ")})` : ""}`);
}
console.log(`\nRewrite checks passed: ${passed}/${cases.length}`);
