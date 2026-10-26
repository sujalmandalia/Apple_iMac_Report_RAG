import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ExtractedDocument } from "../src/extraction/types.js";
import { buildStructure } from "../src/structure/build.js";

const { values } = parseArgs({
  options: {
    in: { type: "string", default: "data/pages.json" },
    out: { type: "string", default: "data/structure.json" },
    outline: { type: "boolean", default: false },
    endnote: { type: "string" },
    element: { type: "string" },
  },
});

const doc = JSON.parse(await readFile(values.in!, "utf8")) as ExtractedDocument;
const structure = buildStructure(doc);
await writeFile(values.out!, JSON.stringify(structure, null, 2));

const count = (type: string) => structure.elements.filter((e) => e.type === type).length;
const linked = structure.endnotes.filter((e) => e.usedBy.length).length;

console.log(`Structure of ${structure.meta.product} ${structure.meta.title} (introduced ${structure.meta.dateIntroduced}) -> ${values.out}`);
console.log(`  sections:   ${structure.sections.map((s) => `${s.title} (p${s.pdfPages.join(",")})`).join(" | ")}`);
console.log(
  `  elements:   ${structure.elements.length} (${["paragraph", "highlight", "definition", "table", "chart", "endnote", "legal"].map((t) => `${t} ${count(t)}`).join(", ")})`,
);
console.log(`  exhibits:   ${structure.exhibits.map((e) => `${e.id} p${e.pdfPage} "${e.title}"`).join(" | ")}`);
console.log(`  glossary:   ${Object.keys(structure.glossary).join(", ")}`);
console.log(`  endnotes:   ${structure.endnotes.length}, ${linked} linked to at least one claim`);
console.log(`  issues:     ${structure.issues.length ? "\n    - " + structure.issues.join("\n    - ") : "none"}`);

if (values.outline) {
  for (const section of structure.sections) {
    console.log(`\n# ${section.title} (p${section.pdfPages.join(",")})`);
    for (const e of structure.elements.filter((x) => x.sectionPath[0] === section.title)) {
      const where = e.sectionPath.slice(1).join(" > ");
      const tags = [e.exhibit, e.markers.length ? `notes ${e.markers.join(",")}` : "", e.include ? "" : "excluded"].filter(Boolean).join(" ");
      console.log(`  ${e.id.padEnd(4)} ${e.type.padEnd(10)} ${where ? `[${where}] ` : ""}${e.text.replace(/\n/g, " / ").slice(0, 90)}${tags ? `  {${tags}}` : ""}`);
    }
  }
}

if (values.endnote) {
  const note = structure.endnotes.find((e) => e.num === Number(values.endnote));
  if (!note) throw new Error(`No endnote ${values.endnote}`);
  console.log(`\n[^${note.num}] (p${note.pdfPage})\n${note.text}\n\nQualifies:`);
  for (const u of note.usedBy) console.log(`  - ${u.elementId} p${u.pdfPage}: ${u.sentence}`);
}

if (values.element) {
  const element = structure.elements.find((e) => e.id === values.element);
  if (!element) throw new Error(`No element ${values.element}`);
  console.log(`\n${JSON.stringify(element, null, 2)}`);
}
