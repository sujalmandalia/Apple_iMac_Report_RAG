import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { DocumentStructure } from "../src/structure/types.js";
import { parseTable, rowText, tableMarkdown } from "../src/tables/parse.js";

const { values } = parseArgs({
  options: {
    in: { type: "string", default: "data/structure.json" },
    out: { type: "string", default: "data/tables.json" },
    table: { type: "string", short: "t" },
    rows: { type: "boolean", default: false },
  },
});

const structure = JSON.parse(await readFile(values.in!, "utf8")) as DocumentStructure;
const tables = structure.elements.filter((e) => e.type === "table").map(parseTable);
await writeFile(values.out!, JSON.stringify(tables, null, 2));

const checks = tables.flatMap((t) => t.checks);
console.log(`Parsed ${tables.length} tables -> ${values.out}`);
for (const t of tables) {
  const failed = t.checks.filter((c) => !c.ok).length;
  console.log(
    `  ${t.id.padEnd(8)} p${t.pdfPage}  ${String(t.rows.length).padStart(2)} rows x ${t.columns.length} cols  ` +
      `checks ${t.checks.length - failed}/${t.checks.length}  "${t.title}"${t.markers.length ? `  endnotes ${t.markers.join(",")}` : ""}`,
  );
}
console.log(`  checks passed: ${checks.filter((c) => c.ok).length}/${checks.length}`);

for (const t of tables.filter((x) => !values.table || x.id === values.table)) {
  if (!values.table && !values.rows) break;
  console.log(`\n${tableMarkdown(t)}\n`);
  for (const c of t.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  if (values.rows) {
    console.log("\n  row texts:");
    for (const r of t.rows) console.log(`    ${rowText(t, r)}`);
  }
}
