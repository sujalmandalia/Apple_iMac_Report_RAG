import type { Block, ExtractedDocument, ExtractedPage } from "../extraction/types.js";
import { isBold } from "../extraction/layout.js";
import { tableTitle } from "../tables/parse.js";
import type { DocumentStructure, Element, ElementType, Endnote, Exhibit, MarkerUse, Section } from "./types.js";

const SECTION_MIN_SIZE = 20;
const LEAD_MIN_SIZE = 11.5;
const HERO_MIN_SIZE = 15;
const SHORT_STAT_MAX_CHARS = 90;
const CHART_MIN_LABELS = 8;
const CHART_LABEL_MAX_CHARS = 40;

const MARKER = /\[\^(\d+)\]/g;
const ENDNOTE_START = /^\[\^(\d+)\]:\s*/;
const NUMBER_HEADING = /^[<>–-]?\d[\d.,]*\s*(%|kg)?$/;
const URL = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
const TERM = /^([A-Z][A-Za-z -]{2,40}):\s+/;

export const stripMarkers = (text: string) => text.replace(MARKER, "").replace(/\s+([.,;:])/g, "$1").trim();
export const markersIn = (text: string) => [...new Set([...text.matchAll(MARKER)].map((m) => Number(m[1])))];

const xOverlap = (a: Block["bbox"], b: Block["bbox"]) => a[0] < b[2] - 1 && a[2] > b[0] + 1;
const center = (b: Block["bbox"]) => (b[0] + b[2]) / 2;

/** A block sits under a subheading when it shares its column: left-aligned with it (body text) or centered under it (cards). */
const underHeading = (heading: Block["bbox"], block: Block["bbox"]) =>
  xOverlap(heading, block) && (Math.abs(heading[0] - block[0]) <= 5 || Math.abs(center(heading) - center(block)) <= 60);

/** A marker after the full stop ("Apple.[^7] This ...") belongs to the sentence before it. */
export function sentences(text: string): string[] {
  // Sentences may also start with a product name in lower camel case ("iMac consumes ...").
  return text.split(/(?<=[.!?](?:\[\^\d+\])*)\s+(?=[A-Z0-9"(•]|i[A-Z])|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** A run of many short labels below the text is a chart drawn with vector graphics (the page 2 emissions bridge). */
function chartRun(blocks: Block[]): [start: number, end: number] | null {
  const isLabel = (b: Block) => b.kind !== "table" && b.size < SECTION_MIN_SIZE && stripMarkers(b.text).length <= CHART_LABEL_MAX_CHARS;
  let start = -1;
  for (let i = 0; i <= blocks.length; i++) {
    if (i < blocks.length && isLabel(blocks[i]!)) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= CHART_MIN_LABELS) return [start, i];
    start = -1;
  }
  return null;
}

export function buildStructure(doc: ExtractedDocument): DocumentStructure {
  const elements: Element[] = [];
  const sections: Section[] = [];
  const exhibits: Exhibit[] = [];
  const glossary: Record<string, string> = {};
  const issues: string[] = [];
  const meta: DocumentStructure["meta"] = { title: "", product: "", dateIntroduced: null, pageCount: doc.pageCount };

  let section: Section | null = null;
  let sub: { title: string; bbox: Block["bbox"]; markers: number[]; linked: boolean } | null = null;
  let endnote: Element | null = null;
  let definition: Element | null = null;
  const orphanMarkers: { num: number; pdfPage: number }[] = [];

  const path = (block: Block) => (sub && underHeading(sub.bbox, block.bbox) ? [section!.title, sub.title] : [section!.title]);

  const add = (type: ElementType, blocks: Block[], text: string, page: ExtractedPage, extra: Partial<Element> = {}): Element => {
    const inSub = sub && underHeading(sub.bbox, blocks[0]!.bbox) ? sub : null;
    const element: Element = {
      id: `e${elements.length + 1}`,
      type,
      sectionPath: extra.sectionPath ?? path(blocks[0]!),
      pdfPages: [page.pdfPage],
      text,
      markers: [...new Set([...markersIn(text), ...(inSub?.markers ?? [])])],
      blockIds: blocks.map((b) => b.id),
      include: true,
      ...extra,
    };
    elements.push(element);
    return element;
  };

  const append = (element: Element, block: Block, page: ExtractedPage, separator = "\n") => {
    element.text += separator + block.text;
    element.blockIds.push(block.id);
    if (!element.pdfPages.includes(page.pdfPage)) element.pdfPages.push(page.pdfPage);
    element.markers = [...new Set([...element.markers, ...markersIn(block.text)])];
  };

  const startSection = (title: string, pdfPage: number) => {
    if (section?.title === title) {
      if (!section.pdfPages.includes(pdfPage)) section.pdfPages.push(pdfPage);
    } else {
      section = { title, pdfPages: [pdfPage], subsections: [] };
      sections.push(section);
    }
    sub = null;
    endnote = null;
    definition = null;
  };

  for (const page of doc.pages) {
    const blocks = page.blocks;
    const chart = chartRun(blocks);

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const next = blocks[i + 1];
      const plain = stripMarkers(block.text);

      if (block.kind === "heading" && block.size >= SECTION_MIN_SIZE) {
        if (page.pdfPage === 1 && !meta.title) {
          meta.title = plain;
          startSection("Overview", page.pdfPage);
        } else {
          startSection(plain, page.pdfPage);
        }
        continue;
      }
      if (!section) startSection("Overview", page.pdfPage);

      if (chart && i === chart[0]) {
        const labels = blocks.slice(chart[0], chart[1]);
        const id = `chart-${exhibits.filter((e) => e.kind === "chart").length + 1}`;
        const element = add("chart", labels, labels.map((b) => b.text).join("\n"), page, {
          exhibit: id,
          title: section!.title,
          sectionPath: [section!.title],
        });
        exhibits.push({ id, kind: "chart", title: section!.title, pdfPage: page.pdfPage, elementId: element.id });
        i = chart[1] - 1;
        continue;
      }

      // Cover page: product name and launch date become document metadata.
      if (page.pdfPage === 1 && !meta.product && block.kind === "text" && block.size >= 14) {
        meta.product = plain;
        continue;
      }
      const date = /^Date introduced\s+(.+)$/.exec(plain);
      if (date) {
        meta.dateIntroduced = date[1]!;
        add("paragraph", [block], `${meta.product} ${meta.title}. Date introduced: ${date[1]}.`, page, { sectionPath: ["Overview"] });
        continue;
      }

      if (block.kind === "marker") {
        for (const num of block.markers) orphanMarkers.push({ num, pdfPage: page.pdfPage });
        continue;
      }

      if (block.text.startsWith("©")) {
        add("legal", [block], block.text, page, { include: false, sectionPath: [section!.title] });
        continue;
      }

      if (section!.title === "Endnotes") {
        const start = ENDNOTE_START.exec(block.text);
        if (start) {
          const num = Number(start[1]);
          endnote = add("endnote", [block], block.text, page, { sectionPath: ["Endnotes", `Endnote ${num}`], markers: [num] });
          continue;
        }
        // Content between two endnotes belongs to the first: the power-mode bullets and table under endnote 18.
        const owner: Element | null = endnote;
        if (block.kind === "table") {
          addTable(block, page, owner ? ["Endnotes", `Endnote ${owner.markers[0]}`] : ["Endnotes"], owner?.markers ?? [], blocks[i - 1]);
          continue;
        }
        if (next?.kind === "table" && isBold(block.font) && plain.length < 60) continue; // table caption, used by addTable
        if (owner) append(owner, block, page);
        else issues.push(`Endnotes text before any endnote on page ${page.pdfPage}: ${plain.slice(0, 60)}`);
        continue;
      }

      if (section!.title === "Definitions") {
        const term = TERM.exec(plain);
        if (term) {
          definition = add("definition", [block], block.text, page, { term: term[1]!, sectionPath: ["Definitions", term[1]!] });
          continue;
        }
        if (definition) {
          append(definition, block, page);
          continue;
        }
      }

      if (block.kind === "table") {
        const notes: string[] = [];
        while (blocks[i + 1] && /^Note:/.test(blocks[i + 1]!.text)) notes.push(blocks[++i]!.text);
        addTable(block, page, path(block), [], undefined, notes);
        continue;
      }

      if (block.kind === "heading") {
        if (URL.test(plain)) {
          const previous = elements.at(-1);
          if (previous) append(previous, block, page, " ");
          continue;
        }
        if (NUMBER_HEADING.test(plain) && next && next.kind === "text") {
          add("highlight", [block, next], `${block.text} ${next.text}`, page);
          i++;
          continue;
        }
        if (block.size >= HERO_MIN_SIZE && /\d/.test(plain)) {
          add("highlight", [block], block.text, page);
          continue;
        }
        if (/[.!?]$/.test(plain) && plain.length > 40) {
          add("paragraph", [block], block.text, page); // pull quote
          continue;
        }
        sub = { title: plain, bbox: block.bbox, markers: block.markers, linked: false };
        if (!section!.subsections.includes(plain)) section!.subsections.push(plain);
        continue;
      }

      const isStat = plain.length <= SHORT_STAT_MAX_CHARS && /\d\s*%/.test(plain);
      add(block.size >= LEAD_MIN_SIZE || isStat ? "highlight" : "paragraph", [block], block.text, page);
    }
  }

  function addTable(block: Block, page: ExtractedPage, sectionPath: string[], markers: number[], captionBlock?: Block, notes: string[] = []) {
    const id = `table-${exhibits.filter((e) => e.kind === "table").length + 1}`;
    const caption = captionBlock && isBold(captionBlock.font) && !captionBlock.text.includes("\t") && stripMarkers(captionBlock.text).length < 60 ? stripMarkers(captionBlock.text) : null;
    const cells = block.cells ?? [];
    const title = tableTitle(cells, caption);
    const element = add("table", captionBlock && caption ? [captionBlock, block] : [block], block.text, page, {
      exhibit: id,
      title,
      cells,
      notes,
      sectionPath,
      markers: [...new Set([...markers, ...markersIn(block.text), ...notes.flatMap(markersIn)])],
    });
    exhibits.push({ id, kind: "table", title, pdfPage: page.pdfPage, elementId: element.id });
  }

  // Link every marker to the sentence it qualifies.
  const uses = new Map<number, MarkerUse[]>();
  const use = (num: number, u: MarkerUse) => {
    if (!uses.has(num)) uses.set(num, []);
    uses.get(num)!.push(u);
  };
  for (const element of elements) {
    if (element.type === "endnote") continue;
    for (const sentence of sentences(element.text)) {
      for (const num of markersIn(sentence)) {
        use(num, { elementId: element.id, pdfPage: element.pdfPages[0]!, sentence: stripMarkers(sentence).replace(/\t/g, " | ") });
      }
    }
  }
  // Markers on card headings ("Smarter chemistry[^5]") qualify the whole card.
  for (const element of elements) {
    const heading = element.sectionPath[1];
    for (const num of element.markers) {
      if (element.type === "endnote" || markersIn(element.text).includes(num) || !heading) continue;
      if ((uses.get(num) ?? []).some((u) => u.elementId === element.id)) continue;
      const what = element.type === "table" ? `Table: ${element.title}` : `${heading}: ${stripMarkers(element.text).replace(/\n/g, "; ").slice(0, 200)}`;
      use(num, { elementId: element.id, pdfPage: element.pdfPages[0]!, sentence: what });
    }
  }
  // A marker with no text next to it (beside a logo) is attached to the first element of its page.
  for (const orphan of orphanMarkers) {
    const element = elements.find((e) => e.pdfPages.includes(orphan.pdfPage) && e.include);
    if (!element) continue;
    element.markers = [...new Set([...element.markers, orphan.num])];
    use(orphan.num, { elementId: element.id, pdfPage: orphan.pdfPage, sentence: `(marker beside an image on page ${orphan.pdfPage})` });
    issues.push(`Endnote ${orphan.num} marker on page ${orphan.pdfPage} has no adjacent text; attached to ${element.id}.`);
  }

  const endnotes: Endnote[] = elements
    .filter((e) => e.type === "endnote")
    .map((e) => {
      const num = e.markers[0]!;
      return { num, pdfPage: e.pdfPages[0]!, text: e.text.replace(ENDNOTE_START, ""), usedBy: uses.get(num) ?? [] };
    })
    .sort((a, b) => a.num - b.num);

  for (const term of elements.filter((e) => e.type === "definition")) {
    glossary[term.term!] = stripMarkers(term.text.replace(TERM, "")).split("\n")[0]!;
  }

  const defined = new Set(endnotes.map((e) => e.num));
  for (const num of uses.keys()) if (!defined.has(num)) issues.push(`Marker [^${num}] is used but endnote ${num} is not defined.`);
  for (const e of endnotes) if (!e.usedBy.length) issues.push(`Endnote ${e.num} is never referenced.`);

  return { source: doc.source, meta, sections, elements, endnotes, exhibits, glossary, issues };
}
