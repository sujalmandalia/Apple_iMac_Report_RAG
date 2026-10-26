import { VALUE } from "../extraction/layout.js";
import type { TableCell } from "../extraction/types.js";
import type { Element } from "../structure/types.js";
import type { ParsedValue, Table, TableCheck, TableRow } from "./types.js";

const COLUMN_TOLERANCE = 6;
const MARKER = /\[\^(\d+)\]/g;
const BULLET = /^•\s*/;
const PARSE_VALUE = /^([↓↑])?\s*([<>])?\s*([–-])?\s*(\d[\d,]*(?:\.\d+)?)\s*(.*)$/;

const strip = (text: string) => text.replace(MARKER, "").trim();
const markersIn = (text: string) => [...text.matchAll(MARKER)].map((m) => Number(m[1]));
const isValue = (text: string) => VALUE.test(strip(text));

export function parseValue(raw: string): ParsedValue {
  const m = PARSE_VALUE.exec(strip(raw));
  if (!m) return { raw, value: null, unit: null, qualifier: null, direction: null };
  const sign = m[3] ? -1 : 1;
  return {
    raw: strip(raw),
    value: sign * Number(m[4]!.replace(/,/g, "")),
    unit: m[5]?.trim() || null,
    qualifier: (m[2] as "<" | ">" | undefined) ?? null,
    direction: m[1] === "↓" ? "down" : m[1] === "↑" ? "up" : null,
  };
}

interface Layout {
  labelX: number;
  valueXs: number[];
  headerRows: TableCell[][];
  dataRows: TableCell[][];
}

/** Data rows have a value in a non-label cell; everything above the first one is header. */
function layout(cells: TableCell[][]): Layout {
  const isData = (row: TableCell[]) => row.slice(1).some((c) => isValue(c.text));
  const first = cells.findIndex(isData);
  const dataRows = first < 0 ? [] : cells.slice(first);
  const headerRows = first < 0 ? cells : cells.slice(0, first);
  const labelX = Math.min(...dataRows.map((r) => r[0]!.x0));

  const valueXs: number[] = [];
  for (const x of dataRows.flatMap((r) => r.slice(1).map((c) => c.x0)).sort((a, b) => a - b)) {
    if (!valueXs.length || x - valueXs.at(-1)! > COLUMN_TOLERANCE) valueXs.push(x);
  }
  return { labelX, valueXs, headerRows, dataRows };
}

/** -1 for the label column, otherwise the index of the nearest value column. */
function columnOf(x: number, { labelX, valueXs }: Layout): number {
  if (Math.abs(x - labelX) <= COLUMN_TOLERANCE) return -1;
  let best = 0;
  valueXs.forEach((vx, i) => {
    if (Math.abs(x - vx) < Math.abs(x - valueXs[best]!)) best = i;
  });
  return best;
}

/** Header lines sit at staggered heights ("iMac (two ports)" above "Greenhouse gas emissions" above "256GB"); join them per column. */
function headers(l: Layout): { labelHeader: string; columns: string[] } {
  const parts: string[][] = l.valueXs.map(() => []);
  const label: string[] = [];
  for (const row of l.headerRows) {
    for (const cell of row) {
      const col = columnOf(cell.x0, l);
      (col < 0 ? label : parts[col]!).push(strip(cell.text));
    }
  }
  return {
    labelHeader: label.join(" ") || "Item",
    columns: parts.map((p, i) => p.join(" ") || (l.valueXs.length === 1 ? "Value" : `Column ${i + 1}`)),
  };
}

export function tableTitle(cells: TableCell[][], caption: string | null): string {
  if (caption) return caption;
  const { labelHeader, columns } = headers(layout(cells));
  return `${labelHeader} — ${columns.join(", ")}`;
}

export function parseTable(element: Element): Table {
  const cells = element.cells ?? [];
  const l = layout(cells);
  const { labelHeader, columns } = headers(l);

  const rows: TableRow[] = [];
  let parent: string | null = null;
  for (const row of l.dataRows) {
    const labelCell = row.find((c) => columnOf(c.x0, l) < 0);
    const rawLabel = labelCell?.text ?? "";
    const bullet = BULLET.test(rawLabel);
    const label = strip(rawLabel.replace(BULLET, ""));
    const values: Record<string, ParsedValue> = {};
    for (const cell of row) {
      const col = columnOf(cell.x0, l);
      if (col >= 0) values[columns[col]!] = parseValue(cell.text);
    }
    rows.push({ label, parent: bullet ? parent : null, markers: markersIn(rawLabel), values });
    if (!bullet) parent = label;
  }

  const table: Table = {
    id: element.exhibit!,
    elementId: element.id,
    title: element.title ?? tableTitle(cells, null),
    pdfPage: element.pdfPages[0]!,
    sectionPath: element.sectionPath,
    labelHeader,
    columns,
    rows,
    notes: (element.notes ?? []).map(strip),
    markers: element.markers,
    checks: [],
  };
  table.checks = checkTable(table);
  return table;
}

/** Bounds of a rounded value: "45%" is 44.5-45.5, "<1%" is 0-1. */
function bounds(v: ParsedValue): [number, number] {
  if (v.value === null) return [NaN, NaN];
  if (v.qualifier === "<") return [0, v.value];
  const half = v.raw.includes(".") ? 0.05 : 0.5;
  return [v.value - half, v.value + half];
}

export function checkTable(table: Table): TableCheck[] {
  const checks: TableCheck[] = [];

  const missing = table.rows.flatMap((r) => table.columns.filter((c) => !r.values[c]).map((c) => `${r.label} / ${c}`));
  checks.push({
    name: "every row has a value in every column",
    ok: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join("; ")}` : `${table.rows.length} rows x ${table.columns.length} columns`,
  });

  for (const column of table.columns) {
    // Percentage breakdowns under a parent row must add up to 100 within rounding.
    const parents = [...new Set(table.rows.map((r) => r.parent).filter((p): p is string => !!p))];
    for (const parent of parents) {
      const parts = table.rows.filter((r) => r.parent === parent).map((r) => r.values[column]).filter((v): v is ParsedValue => !!v);
      if (!parts.length || parts.some((v) => v.unit !== "%")) continue;
      const lo = parts.reduce((n, v) => n + bounds(v)[0], 0);
      const hi = parts.reduce((n, v) => n + bounds(v)[1], 0);
      checks.push({
        name: `"${parent}" breakdown adds up to 100%`,
        ok: lo <= 100 && hi >= 100,
        detail: `${parts.map((v) => v.raw).join(" + ")} -> between ${lo.toFixed(1)} and ${hi.toFixed(1)}`,
      });
    }

    // A "Total ..." row must equal the sum of the scope rows with the same unit.
    const total = table.rows.find((r) => /^total/i.test(r.label))?.values[column];
    const scopes = table.rows.filter((r) => /\(scope \d\)/i.test(r.label)).map((r) => r.values[column]).filter((v): v is ParsedValue => !!v);
    if (total?.value != null && scopes.length && scopes.every((v) => v.unit === total.unit)) {
      const sum = scopes.reduce((n, v) => n + (v.value ?? 0), 0);
      checks.push({
        name: "total equals the sum of scopes",
        ok: Math.abs(sum - total.value) < 0.5,
        detail: `${scopes.map((v) => v.raw).join(" + ")} = ${sum} ${total.unit}; total ${total.raw}`,
      });
    }
  }
  return checks;
}

/** One self-contained line per row, for embedding: the table, the row (with its parent) and every column. */
export function rowText(table: Table, row: TableRow): string {
  const label = row.parent ? `${row.parent} > ${row.label}` : row.label;
  const cells = table.columns.map((c) => `${c}: ${row.values[c]?.raw ?? "-"}`);
  return [`Table: ${table.title}`, `${table.labelHeader}: ${label}`, ...cells].join(" | ");
}

export function tableMarkdown(table: Table): string {
  const head = `| ${table.labelHeader} | ${table.columns.join(" | ")} |`;
  const rule = `|${" --- |".repeat(table.columns.length + 1)}`;
  const body = table.rows.map((r) => {
    const label = r.parent ? `  ${r.label} (of ${r.parent})` : r.label;
    return `| ${label}${r.markers.map((m) => `[^${m}]`).join("")} | ${table.columns.map((c) => r.values[c]?.raw ?? "").join(" | ")} |`;
  });
  return [`**${table.title}** (p. ${table.pdfPage})`, "", head, rule, ...body, ...table.notes.map((n) => `\n${n}`)].join("\n");
}
