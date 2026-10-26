import { chartText } from "../charts/check.js";
import type { Chart } from "../charts/types.js";
import { markersIn, sentences, stripMarkers } from "../structure/build.js";
import type { DocumentStructure, Element } from "../structure/types.js";
import { rowText, tableMarkdown } from "../tables/parse.js";
import type { Table, TableRow } from "../tables/types.js";
import type { Chunk, ChunkOptions, ChunkSet, ChunkType, Parent } from "./types.js";

// Smaller than the World Bank chunks (400/600): sections here are short and dense with separate claims.
export const DEFAULT_OPTIONS: ChunkOptions = {
  targetTokens: 250,
  maxTokens: 400,
  minTokens: 60,
  parentMaxTokens: 1500,
  endnoteSummaryChars: 220,
};

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export const embeddingText = (chunk: Pick<Chunk, "context" | "text">) => `${chunk.context}\n\n${chunk.text}`;

const VARIANT = /iMac \((two|four) ports\)(?:\s*(?:with\s*)?(\d+\s?GB))?/g;

export function variantsIn(text: string): string[] {
  return [...new Set([...text.matchAll(VARIANT)].map((m) => `iMac (${m[1]} ports)${m[2] ? ` ${m[2].replace(/\s/g, "")}` : ""}`))];
}

function pack<T>(items: T[], size: (item: T) => number, target: number, max: number, min: number): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length && tokens + n > max) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(item);
    tokens += n;
    if (tokens >= target) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
  }
  if (current.length) {
    const last = groups.at(-1);
    const lastTokens = last?.reduce((n, item) => n + size(item), 0) ?? 0;
    if (last && tokens < min && lastTokens + tokens <= max * 1.25) last.push(...current);
    else groups.push(current);
  }
  return groups;
}

export function chunkDocument(structure: DocumentStructure, tables: Table[], charts: Chart[], opts: ChunkOptions = DEFAULT_OPTIONS): ChunkSet {
  const parents: Parent[] = [];
  const chunks: Chunk[] = [];
  const doc = `${structure.meta.product} environmental report`;
  const contextOf = (path: string[]) => [doc, ...path].join(" > ");

  const endnotes = new Map(structure.endnotes.map((e) => [e.num, e]));
  const summary = (num: number) => {
    const first = sentences(endnotes.get(num)?.text ?? "")[0] ?? "";
    const text = stripMarkers(first);
    return text.length > opts.endnoteSummaryChars ? `${text.slice(0, opts.endnoteSummaryChars).replace(/\s\S*$/, "")}…` : text;
  };
  // The chunk keeps its [^n] markers; a short line per endnote tells the embedding what qualifies the claim.
  const withEndnotes = (text: string, nums: number[]) =>
    nums.length ? `${text}\n${nums.map((n) => `[^${n}] ${summary(n)}`).join("\n")}` : text;

  const addParent = (kind: Parent["kind"], sectionPath: string[], pdfPages: number[], text: string): Parent => {
    const parent: Parent = { id: `p${parents.length + 1}`, kind, sectionPath, pdfPages, text, tokens: estimateTokens(text) };
    parents.push(parent);
    return parent;
  };

  const addChunk = (
    type: ChunkType,
    elements: Element[],
    body: string,
    extra: { parentId?: string | null; sectionPath?: string[]; exhibit?: string | null; endnotes?: number[]; context?: string } = {},
  ): Chunk => {
    const sectionPath = extra.sectionPath ?? elements[0]!.sectionPath;
    const nums = extra.endnotes ?? [...new Set(elements.flatMap((e) => e.markers))].sort((a, b) => a - b);
    const text = type === "endnote" ? body : withEndnotes(body, nums);
    const chunk: Chunk = {
      id: `c${chunks.length + 1}`,
      parentId: extra.parentId ?? null,
      type,
      elementIds: elements.map((e) => e.id),
      exhibit: extra.exhibit ?? null,
      endnotes: nums,
      variants: variantsIn(body),
      sectionPath,
      pdfPages: [...new Set(elements.flatMap((e) => e.pdfPages))].sort((a, b) => a - b),
      context: extra.context ?? contextOf(sectionPath),
      text,
      tokens: estimateTokens(text),
    };
    chunks.push(chunk);
    return chunk;
  };

  // A paragraph under a card or sub-heading carries the heading inline, since a chunk may hold several cards.
  const rendered = (e: Element) => (e.sectionPath[1] ? `${e.sectionPath[1]}: ${e.text}` : e.text);

  const tableById = new Map(tables.map((t) => [t.id, t]));
  const chartById = new Map(charts.map((c) => [c.id, c]));

  for (const section of structure.sections) {
    const elements = structure.elements.filter((e) => e.include && e.sectionPath[0] === section.title);
    const prose = elements.filter((e) => e.type === "paragraph" || e.type === "highlight");

    // The section parent gives the answer step the surrounding text of any chunk in the section.
    const sectionText = prose.map(rendered).join("\n\n");
    const sectionParent =
      prose.length && estimateTokens(sectionText) <= opts.parentMaxTokens
        ? addParent("section", [section.title], section.pdfPages, `${section.title}\n\n${sectionText}`)
        : null;

    // Paragraphs: packed in reading order, split at sentences when one is too long.
    const pieces = elements
      .filter((e) => e.type === "paragraph")
      .flatMap((e) => {
        const text = rendered(e);
        if (estimateTokens(text) <= opts.maxTokens) return [{ element: e, text }];
        return pack(sentences(text), estimateTokens, opts.targetTokens, opts.maxTokens, opts.minTokens).map((g) => ({ element: e, text: g.join(" ") }));
      });
    for (const group of pack(pieces, (p) => estimateTokens(p.text), opts.targetTokens, opts.maxTokens, opts.minTokens)) {
      const els = [...new Set(group.map((p) => p.element))];
      const subs = new Set(els.map((e) => e.sectionPath[1] ?? ""));
      addChunk("text", els, group.map((p) => p.text).join("\n\n"), {
        parentId: sectionParent?.id,
        sectionPath: subs.size === 1 ? els[0]!.sectionPath : [section.title],
      });
    }

    for (const e of elements) {
      if (e.type === "highlight") addChunk("highlight", [e], rendered(e), { parentId: sectionParent?.id });

      if (e.type === "definition") {
        // A long definition is split at its bullets ("• Use: Apple assumes a four-year period ..."), each keeping the term.
        if (estimateTokens(e.text) <= opts.maxTokens) {
          addChunk("definition", [e], e.text, { endnotes: markersIn(e.text) });
        } else {
          const lines = e.text.split("\n");
          const intro = lines.filter((l) => !l.startsWith("•")).join("\n");
          addChunk("definition", [e], intro, { endnotes: markersIn(intro) });
          for (const bullet of lines.filter((l) => l.startsWith("•"))) {
            const item = bullet.slice(1).trim();
            const name = item.split(":")[0]!;
            addChunk("definition", [e], `${e.term} — ${item}`, {
              endnotes: markersIn(item),
              sectionPath: [...e.sectionPath, name],
            });
          }
        }
      }

      if (e.type === "endnote") {
        const note = endnotes.get(e.markers[0]!)!;
        const uses = note.usedBy.map((u) => `"${u.sentence.slice(0, 120)}" (p. ${u.pdfPage})`);
        addChunk("endnote", [e], `Endnote ${note.num}: ${note.text}`, {
          endnotes: [note.num],
          context: `${doc} > Endnotes > Endnote ${note.num}, which qualifies: ${uses.join("; ")}`,
        });
      }

      if (e.type === "table") {
        const table = tableById.get(e.exhibit!);
        if (!table) throw new Error(`No parsed table for ${e.exhibit}; run npm run tables first.`);
        addTableChunks(e, table);
      }

      if (e.type === "chart") {
        const chart = chartById.get(e.exhibit!);
        if (!chart) throw new Error(`No chart reading for ${e.exhibit}; run npm run charts first.`);
        const text = chartText(chart);
        const parent = addParent("chart", e.sectionPath, e.pdfPages, sectionText ? `${sectionText}\n\n${text}` : text);
        addChunk("chart", [e], text, { parentId: parent.id, exhibit: chart.id, endnotes: chart.markers });
      }
    }
  }

  function addTableChunks(e: Element, table: Table) {
    const markdown = tableMarkdown(table);
    const parent = addParent("table", e.sectionPath, e.pdfPages, markdown);
    // "Endnotes > Endnote 18" says where the table is printed; the table's own title says what it is.
    const context = `${contextOf(e.sectionPath)} > ${table.title}`;
    const tableNotes = [...new Set([...table.markers, ...table.rows.flatMap((r) => r.markers)])].sort((a, b) => a - b);
    addChunk("table", [e], markdown, { parentId: parent.id, exhibit: table.id, endnotes: tableNotes, context });

    // Endnote bullets that define a row ("• Idle—Display on: System is on ...") travel with that row.
    const bullets = table.markers.flatMap((n) => (endnotes.get(n)?.text ?? "").split("\n").filter((l) => l.startsWith("•")));
    const key = (s: string) => s.toLowerCase().replace(/[—–-]/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    const definitionOf = (row: TableRow) => bullets.find((b) => key(b.slice(1).split(":")[0]!) === key(row.label));

    for (const row of table.rows) {
      const definition = definitionOf(row);
      const text = definition ? `${rowText(table, row)}\nMode definition: ${definition.slice(1).trim()}` : rowText(table, row);
      const rowNotes = [...new Set([...table.markers, ...row.markers])].sort((a, b) => a - b);
      addChunk("table_row", [e], text, { parentId: parent.id, exhibit: table.id, endnotes: rowNotes, context });
    }
  }

  return { source: structure.source, options: opts, parents, chunks };
}
