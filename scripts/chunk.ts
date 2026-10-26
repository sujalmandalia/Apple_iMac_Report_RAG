import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Chart } from "../src/charts/types.js";
import { chunkDocument, embeddingText } from "../src/chunking/chunk.js";
import type { DocumentStructure } from "../src/structure/types.js";
import type { Table } from "../src/tables/types.js";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "data/chunks.json" },
    show: { type: "string" },
    type: { type: "string" },
    section: { type: "string" },
  },
});

const read = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;
const structure = await read<DocumentStructure>("data/structure.json");
const set = chunkDocument(structure, await read<Table[]>("data/tables.json"), await read<Chart[]>("data/charts.json"));
await writeFile(values.out!, JSON.stringify(set, null, 2));

const { chunks, parents, options } = set;
const tokens = chunks.map((c) => c.tokens).sort((a, b) => a - b);
const byType = new Map<string, number>();
for (const c of chunks) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);

const withMarkers = chunks.filter((c) => c.type !== "endnote" && /\[\^\d+\]/.test(c.text));
const summarised = withMarkers.filter((c) => [...c.text.matchAll(/\[\^(\d+)\](?! )/g)].every((m) => c.endnotes.includes(Number(m[1]))));
const linked = new Set(structure.endnotes.filter((e) => e.usedBy.length).map((e) => e.num));
const carried = new Set(chunks.filter((c) => c.type !== "endnote").flatMap((c) => c.endnotes));

console.log(`Chunked ${structure.meta.product} ${structure.meta.title} -> ${values.out}`);
console.log(`  options:  target ${options.targetTokens}, max ${options.maxTokens}, min ${options.minTokens} tokens`);
console.log(`  chunks:   ${chunks.length} (${[...byType].map(([t, n]) => `${t} ${n}`).join(", ")})`);
console.log(`  tokens:   min ${tokens[0]}, median ${tokens[Math.floor(tokens.length / 2)]}, max ${tokens.at(-1)}, total ${tokens.reduce((a, b) => a + b, 0)}`);
console.log(`  parents:  ${parents.length} (${["section", "table", "chart"].map((k) => `${k} ${parents.filter((p) => p.kind === k).length}`).join(", ")}), max ${Math.max(...parents.map((p) => p.tokens))} tokens`);
console.log(`  endnotes: ${summarised.length}/${withMarkers.length} chunks with markers carry a summary of every marker; ${[...linked].filter((n) => carried.has(n)).length}/${linked.size} linked endnotes reach a chunk`);
console.log(`  variants: ${[...new Set(chunks.flatMap((c) => c.variants))].join(", ")}`);
// Tables and charts are never split, so only prose can be over the limit.
const over = chunks.filter((c) => !["table", "chart"].includes(c.type) && c.tokens > options.maxTokens * 1.25);
if (over.length) console.log(`  over max: ${over.map((c) => `${c.id} (${c.type}, ${c.tokens})`).join(", ")}`);

const shown = chunks.filter(
  (c) =>
    (values.show && c.id === values.show) ||
    (values.type && c.type === values.type) ||
    (values.section && c.sectionPath[0]!.toLowerCase().includes(values.section.toLowerCase())),
);
for (const c of shown) {
  console.log(`\n--- ${c.id} ${c.type} p${c.pdfPages.join(",")} ${c.tokens} tokens${c.exhibit ? ` ${c.exhibit}` : ""}${c.parentId ? ` parent ${c.parentId}` : ""}${c.endnotes.length ? ` endnotes ${c.endnotes.join(",")}` : ""}${c.variants.length ? ` [${c.variants.join("; ")}]` : ""}`);
  console.log(embeddingText(c));
}
