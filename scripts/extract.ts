import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config } from "../src/config.js";
import { extractDocument } from "../src/extraction/extract.js";

const { values } = parseArgs({
  options: {
    page: { type: "string", short: "p" },
    markers: { type: "boolean", default: false },
    out: { type: "string", default: "data/pages.json" },
  },
});

const started = Date.now();
const { stats, ...doc } = await extractDocument(config.reportPdf);
const ms = Date.now() - started;

await mkdir("data", { recursive: true });
await writeFile(values.out!, JSON.stringify(doc, null, 2));

const uses = doc.markers.filter((m) => m.form !== "definition");
const defined = new Set(doc.markers.filter((m) => m.form === "definition").map((m) => m.num));
const used = new Set(uses.map((m) => m.num));
const byForm = (form: string) => doc.markers.filter((m) => m.form === form).length;
const missing = (a: Set<number>, b: Set<number>) => [...a].filter((n) => !b.has(n)).sort((x, y) => x - y);

console.log(`Extracted ${doc.pageCount} pages from ${doc.source} in ${ms}ms -> ${values.out}`);
console.log(`  body font size:         ${doc.bodyFontSize}pt`);
console.log(`  running footers removed: ${stats.footersRemoved}/${doc.pageCount}`);
console.log(`  rotated spans dropped:  ${stats.rotatedSpansDropped}`);
console.log(`  blocks:                 ${stats.blocks} (${Object.entries(stats.byKind).map(([k, n]) => `${k} ${n}`).join(", ")})`);
console.log(`  characters:             ${stats.characters.toLocaleString()}`);
console.log(`  endnote markers:        ${uses.length} uses (superscript ${byForm("superscript")}, glued ${byForm("glued")}), ${defined.size} definitions`);
console.log(`  endnotes used but not defined: ${missing(used, defined).join(", ") || "none"}`);
console.log(`  endnotes defined but never used: ${missing(defined, used).join(", ") || "none"}`);

if (values.markers) {
  console.log("\n  num  page  form         anchor");
  for (const m of [...doc.markers].sort((a, b) => a.num - b.num || a.pdfPage - b.pdfPage)) {
    console.log(`  ${String(m.num).padStart(3)}  ${String(m.pdfPage).padStart(4)}  ${m.form.padEnd(11)}  ${m.anchor}`);
  }
}

if (values.page) {
  const page = doc.pages.find((p) => p.pdfPage === Number(values.page));
  if (!page) throw new Error(`No PDF page ${values.page}`);
  console.log(`\n=== PDF page ${page.pdfPage} | printed ${page.printedNumber ?? "-"} | footer: ${page.footer ?? "-"}\n`);
  for (const b of page.blocks) {
    const [x0, top, x1, bottom] = b.bbox.map(Math.round);
    console.log(`[${b.id} ${b.kind} ${b.size}pt ${b.font} x ${x0}-${x1} y ${top}-${bottom}${b.markers.length ? ` markers ${b.markers.join(",")}` : ""}]`);
    console.log(`${b.text}\n`);
  }
}
