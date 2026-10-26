import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { config } from "../src/config.js";
import { chartText, checkChart } from "../src/charts/check.js";
import { measureBars, pageShapes, type LabelBox } from "../src/charts/geometry.js";
import { applyMeasurements } from "../src/charts/measure.js";
import { chartPrompt, extractPage, PROMPT_VERSION, readChart } from "../src/charts/read.js";
import type { ExtractedDocument } from "../src/extraction/types.js";
import type { Chart, ChartReading } from "../src/charts/types.js";
import type { DocumentStructure } from "../src/structure/types.js";

const { values } = parseArgs({
  options: {
    in: { type: "string", default: "data/structure.json" },
    out: { type: "string", default: "data/charts.json" },
    force: { type: "boolean", default: false },
  },
});

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const structure = JSON.parse(await readFile(values.in!, "utf8")) as DocumentStructure;
const pages = JSON.parse(await readFile("data/pages.json", "utf8")) as ExtractedDocument;
const blocks = new Map(pages.pages.flatMap((p) => p.blocks).map((b) => [b.id, b]));
const pdf = new Uint8Array(await readFile(config.reportPdf));
const fileHash = sha256(pdf);
await mkdir("data/charts", { recursive: true });

const charts: Chart[] = [];
for (const element of structure.elements.filter((e) => e.type === "chart")) {
  const page = element.pdfPages[0]!;
  const prompt = chartPrompt(element.title!, element.text);
  // The page PDF that pdf-lib writes contains timestamps, so the key is built from the source file instead.
  const cacheKey = sha256(JSON.stringify({ fileHash, page, PROMPT_VERSION, prompt }));
  const cachePath = `data/charts/${element.exhibit}.json`;

  let cached: { cacheKey: string; model: string; reading: ChartReading } | null = null;
  try {
    cached = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {}

  let reading: ChartReading;
  let model: string;
  if (cached && cached.cacheKey === cacheKey && !values.force) {
    ({ reading, model } = cached);
    console.log(`${element.exhibit}: cached reading from ${model}`);
  } else {
    const started = Date.now();
    ({ reading, model } = await readChart(await extractPage(pdf, page), prompt));
    await writeFile(cachePath, JSON.stringify({ cacheKey, model, readAt: new Date().toISOString(), reading }, null, 2));
    console.log(`${element.exhibit}: read page ${page} with ${model} in ${Date.now() - started}ms`);
  }

  // Vector charts: replace the model's segment estimates with exact heights from the drawing.
  const labels: LabelBox[] = element.blockIds.map((id) => blocks.get(id)!).map((b) => ({ text: b.text, bbox: b.bbox }));
  const measured = measureBars(await pageShapes(pdf, page), labels);
  const merged = measured.length ? applyMeasurements(reading, measured) : { reading, checks: [] };
  console.log(`${element.exhibit}: ${measured.length} bars drawn as vector shapes${measured.length ? " -> segment values measured" : " -> keeping model estimates"}`);

  const { checks, verified } = checkChart(merged.reading, element.text, merged.checks);
  charts.push({
    ...merged.reading,
    id: element.exhibit!,
    elementId: element.id,
    title: element.title!,
    pdfPage: page,
    sectionPath: element.sectionPath,
    markers: element.markers,
    model,
    cacheKey,
    checks,
    verified,
  });
}

await writeFile(values.out!, JSON.stringify(charts, null, 2));
console.log(`\n${charts.length} chart(s) -> ${values.out}`);

for (const chart of charts) {
  console.log(`\n=== ${chart.id} p${chart.pdfPage} "${chart.title}" — ${chart.chartType}, ${chart.unit} — ${chart.verified ? "VERIFIED" : "NEEDS REVIEW"}`);
  for (const bar of chart.bars) {
    console.log(`  ${bar.label} ${bar.footnotes.map((n) => `[^${n}]`).join("")}: ${bar.totalRaw}`);
    for (const s of bar.segments) {
      console.log(`      ${s.kind === "reduction" ? "-" : "+"} ${s.label.padEnd(36)} ${s.printed ? "" : "≈"}${String(s.value).padEnd(6)} ${s.method}${s.footnotes.length ? `  [^${s.footnotes.join("][^")}]` : ""}`);
    }
  }
  console.log("");
  for (const c of chart.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  console.log(`\n--- text for retrieval ---\n${chartText(chart)}`);
}
