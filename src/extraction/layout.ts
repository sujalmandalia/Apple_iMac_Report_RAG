import { joinLines, normalizeText, type Vocabulary } from "./text.js";
import type { Block, BlockKind, Line, Span } from "./types.js";

const ROW_TOLERANCE = 2;
const CELL_GAP_MIN = 12;
const TABLE_ROW_GAP = 30;
const TABLE_COLUMN_TOLERANCE = 4;
const BLOCK_GAP_RATIO = 1.75;
const CUT_MIN_GAP = 6;

// A table cell value: "346 kg CO2e", "50%", "<1%", "↓ >20%", "0.27W", "91.1%".
export const VALUE = /^[↓↑]?\s*[<>–-]?\s*\d[\d,.]*\s*(%|W|kg(\s+CO2e)?|GB)?$/;

// GreenMarker is the hand-drawn face of the life-cycle stage names ("Design and Source", "Make", ...).
export const isBold = (font: string) => /bold|semibold|black|heavy|greenmarker/i.test(font);

export function dominantFontSize(spans: Span[]): number {
  const weight = new Map<number, number>();
  for (const s of spans) weight.set(s.size, (weight.get(s.size) ?? 0) + s.text.length);
  return [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 8.5;
}

export function groupRows(spans: Span[]): Span[][] {
  const rows: { y: number; spans: Span[] }[] = [];
  for (const span of [...spans].sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r.y - span.y) <= ROW_TOLERANCE);
    if (row) row.spans.push(span);
    else rows.push({ y: span.y, spans: [span] });
  }
  for (const row of rows) row.spans.sort((a, b) => a.x0 - b.x0);
  return rows.map((r) => r.spans);
}

function makeLine(spans: Span[], cells: string[]): Line {
  const main = spans.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  return {
    text: cells.join("\t"),
    cells,
    x0: Math.min(...spans.map((s) => s.x0)),
    x1: Math.max(...spans.map((s) => s.x1)),
    y: Math.max(...spans.map((s) => s.y)),
    size: main.size,
    font: main.font,
    // Only a fully bold line is a heading; "**Rare earth elements.** We use ..." is body text with a bold lead-in.
    bold: spans.every((s) => isBold(s.font) || !/[a-z]/i.test(s.text)),
  };
}

function joinSpans(spans: Span[]): string {
  let text = "";
  spans.forEach((s, i) => {
    const prev = spans[i - 1];
    if (prev && s.x0 - prev.x1 > s.size * 0.15 && !/\s$/.test(text)) text += " ";
    text += s.text;
  });
  return normalizeText(text).replace(/\s+/g, " ").trim();
}

/** Splits a row wherever the gap is wider than a word space: columns, cards and table cells become separate lines. */
export function splitRow(row: Span[]): Line[] {
  const groups: Span[][] = [];
  for (const span of row) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && span.x0 - prev.x1 <= Math.max(span.size * 1.5, CELL_GAP_MIN)) last!.push(span);
    else groups.push([span]);
  }
  return groups.map((g) => makeLine(g, [joinSpans(g)])).filter((l) => l.text);
}

interface TableRegion {
  top: number;
  bottom: number;
  columns: number[];
}

/**
 * Tables have no ruling lines in this report, only cells aligned on a few x positions.
 * Value rows ("label  346 kg CO2e") whose value cells line up are grouped; header rows directly above are
 * pulled in while every cell sits on a table column and the row looks like a header (several cells, bold,
 * or a single cell over a value column). A group needs two value rows, or one value row plus a header.
 */
function findTables(rows: Line[][]): TableRegion[] {
  const valueRows = rows
    .map((lines) => ({ lines, y: lines[0]!.y, valueXs: lines.slice(1).filter((l) => VALUE.test(l.text)).map((l) => l.x0) }))
    .filter((r) => r.lines.length >= 2 && r.valueXs.length >= 1);

  const near = (a: number, b: number) => Math.abs(a - b) <= TABLE_COLUMN_TOLERANCE;
  const groups: (typeof valueRows)[] = [];
  for (const row of valueRows) {
    const last = groups.at(-1)?.at(-1);
    const aligned = last && last.y - row.y <= TABLE_ROW_GAP && row.valueXs.some((x) => last.valueXs.some((lx) => near(x, lx)));
    if (aligned) groups.at(-1)!.push(row);
    else groups.push([row]);
  }

  const tables: TableRegion[] = [];
  for (const group of groups) {
    const labelX = Math.min(...group.map((r) => r.lines[0]!.x0));
    const valueXs = group.flatMap((r) => r.valueXs);
    const onColumn = (l: Line) => near(l.x0, labelX) || valueXs.some((x) => near(l.x0, x));
    const isHeader = (lines: Line[]) =>
      lines.every(onColumn) && (lines.length >= 2 || lines[0]!.bold || valueXs.some((x) => near(lines[0]!.x0, x)));

    let top = group[0]!.y;
    let headers = 0;
    for (const lines of rows.filter((r) => r[0]!.y > top).reverse()) {
      if (lines[0]!.y - top > TABLE_ROW_GAP || !isHeader(lines)) break;
      top = lines[0]!.y;
      headers++;
    }
    if (group.length >= 2 || headers >= 1) tables.push({ top, bottom: group.at(-1)!.y, columns: [labelX, ...valueXs] });
  }
  return tables;
}

function newBlock(kind: BlockKind, line: Line): Block {
  return {
    id: "",
    kind,
    bbox: [line.x0, line.y + line.size, line.x1, line.y],
    size: line.size,
    font: line.font,
    lines: [line.text],
    text: line.text,
    markers: [],
  };
}

function extend(block: Block, line: Line) {
  block.bbox = [Math.min(block.bbox[0], line.x0), block.bbox[1], Math.max(block.bbox[2], line.x1), Math.min(block.bbox[3], line.y)];
  block.lines.push(line.text);
}

const overlapsX = (block: Block, line: Line) => line.x0 < block.bbox[2] - 1 && line.x1 > block.bbox[0] + 1;

/**
 * Lines are attached to the block directly above them (same size, overlapping horizontally, close vertically),
 * so each column or card grows into its own block without having to find column boundaries first.
 */
export function buildBlocks(rows: Span[][], bodySize: number, vocab: Vocabulary): Block[] {
  const lineRows = rows.map(splitRow).filter((r) => r.length);
  const tables = findTables(lineRows);

  const blocks: Block[] = [];
  const open: { block: Block; last: Line }[] = [];

  for (const lines of lineRows) {
    const y = lines[0]!.y;
    const table = tables.find((t) => y <= t.top + 0.5 && y >= t.bottom - 0.5);
    if (table) {
      const cells = lines.map((l) => l.text);
      const tableLine: Line = { ...lines[0]!, text: cells.join("\t"), cells, x1: lines.at(-1)!.x1 };
      // Cell x positions decide which column a staggered header line belongs to.
      const row = lines.map((l) => ({ text: l.text, x0: Math.round(l.x0 * 10) / 10, bold: l.bold }));
      const existing = open.find((o) => o.block.kind === "table" && o.last.y - y <= TABLE_ROW_GAP + 1);
      if (existing) {
        extend(existing.block, tableLine);
        existing.block.cells!.push(row);
        existing.last = tableLine;
      } else {
        const block = { ...newBlock("table", tableLine), cells: [row] };
        blocks.push(block);
        open.push({ block, last: tableLine });
      }
      continue;
    }

    for (const line of lines) {
      const candidate = open
        .filter((o) => o.block.kind !== "table")
        .filter((o) => Math.abs(o.last.size - line.size) <= 0.6 && o.last.bold === line.bold)
        .filter((o) => o.last.y - line.y > 0 && o.last.y - line.y <= line.size * BLOCK_GAP_RATIO)
        .filter((o) => overlapsX(o.block, line))
        .sort((a, b) => a.last.y - line.y - (b.last.y - line.y))[0];

      if (candidate) {
        const { block } = candidate;
        block.text = line.text.startsWith("•") ? `${block.text}\n${line.text}` : joinLines(block.text, line.text, vocab);
        extend(block, line);
        candidate.last = line;
      } else {
        const kind: BlockKind = /^(\[\^\d+\])+$/.test(line.text)
          ? "marker"
          : line.bold && line.size >= bodySize
            ? "heading"
            : "text";
        const block = newBlock(kind, line);
        blocks.push(block);
        open.push({ block, last: line });
      }
    }
  }

  for (const block of blocks) {
    if (block.kind === "table") block.text = block.lines.join("\n");
    block.markers = [...new Set([...block.text.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])))];
  }
  return blocks;
}

const CARD_HEADING_MAX_SIZE = 20;
const CARD_GAP = 30;

interface Unit {
  blocks: Block[];
  bbox: Block["bbox"];
}

const unionBox = (blocks: Block[]): Block["bbox"] => [
  Math.min(...blocks.map((b) => b.bbox[0])),
  Math.max(...blocks.map((b) => b.bbox[1])),
  Math.max(...blocks.map((b) => b.bbox[2])),
  Math.min(...blocks.map((b) => b.bbox[3])),
];

const xOverlap = (a: Block["bbox"], b: Block["bbox"]) => a[0] < b[2] - 1 && a[2] > b[0] + 1;

/** A card is a small heading plus the text stacked under it; ordering cards as units keeps title and body together. */
function cardUnits(blocks: Block[]): Unit[] {
  const used = new Set<Block>();
  const units: Unit[] = [];
  const byTop = [...blocks].sort((a, b) => b.bbox[1] - a.bbox[1]);
  for (const head of byTop) {
    if (used.has(head)) continue;
    const members = [head];
    used.add(head);
    if (head.kind === "heading" && head.size < CARD_HEADING_MAX_SIZE) {
      for (;;) {
        const last = members.at(-1)!;
        const next = byTop.find(
          (b) => !used.has(b) && b.kind !== "heading" && xOverlap(b.bbox, last.bbox) && last.bbox[3] - b.bbox[1] >= -1 && last.bbox[3] - b.bbox[1] <= CARD_GAP,
        );
        if (!next) break;
        members.push(next);
        used.add(next);
      }
    }
    units.push({ blocks: members, bbox: unionBox(members) });
  }
  return units;
}

/**
 * Reading order by recursive XY-cut over cards: split at an empty horizontal band if there is one (top to bottom),
 * otherwise at an empty vertical gutter (columns, cards and sidebar headings read left to right), and recurse.
 */
export function readingOrder(blocks: Block[]): Block[] {
  return orderUnits(cardUnits(blocks)).flatMap((u) => u.blocks);
}

function orderUnits(units: Unit[]): Unit[] {
  if (units.length <= 1) return units;
  // Bands: negate y so that "start" is the top of the unit and order is top to bottom. Columns: x runs left to right.
  const bands = cut(units, (u) => [-u.bbox[1], -u.bbox[3]]);
  if (bands) return bands.flatMap(orderUnits);
  const columns = cut(units, (u) => [u.bbox[0], u.bbox[2]]);
  if (columns) return columns.flatMap(orderUnits);
  return [...units].sort((a, b) => b.bbox[1] - a.bbox[1] || a.bbox[0] - b.bbox[0]);
}

/** Groups units along one axis wherever none of them covers a gap of at least CUT_MIN_GAP. */
function cut(units: Unit[], extent: (u: Unit) => [start: number, end: number]): Unit[][] | null {
  const sorted = [...units].sort((a, b) => extent(a)[0] - extent(b)[0]);
  const groups: Unit[][] = [];
  let end = -Infinity;
  for (const unit of sorted) {
    const [lo, hi] = extent(unit);
    if (lo - end >= CUT_MIN_GAP) groups.push([unit]);
    else groups.at(-1)!.push(unit);
    end = Math.max(end, hi);
  }
  return groups.length > 1 ? groups : null;
}
