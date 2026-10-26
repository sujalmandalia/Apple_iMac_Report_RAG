export interface ParsedValue {
  raw: string;
  value: number | null;
  unit: string | null;
  /** "<1%" -> "<", ">20%" -> ">". */
  qualifier: "<" | ">" | null;
  /** "↓>20%" is a reduction. */
  direction: "down" | "up" | null;
}

export interface TableRow {
  label: string;
  /** Bullet rows ("• Production") break down the row above them ("Life cycle product emissions (scope 3)"). */
  parent: string | null;
  markers: number[];
  values: Record<string, ParsedValue>;
}

export interface TableCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Table {
  id: string;
  elementId: string;
  title: string;
  pdfPage: number;
  sectionPath: string[];
  labelHeader: string;
  columns: string[];
  rows: TableRow[];
  notes: string[];
  markers: number[];
  checks: TableCheck[];
}
