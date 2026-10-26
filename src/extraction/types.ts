export interface Span {
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
  font: string;
}

/** A run of spans on one baseline with no wide gap inside it: a line of one column, card or table cell. */
export interface Line {
  text: string;
  cells: string[];
  x0: number;
  x1: number;
  y: number;
  size: number;
  font: string;
  bold: boolean;
}

export type BlockKind = "heading" | "text" | "table" | "marker";

/** How an endnote marker was found: a raised small span, a number glued to a word, or the number before an endnote. */
export type MarkerForm = "superscript" | "glued" | "definition";

export interface Marker {
  num: number;
  form: MarkerForm;
  pdfPage: number;
  /** The word the marker follows (or the start of the endnote it defines). */
  anchor: string;
}

export interface Block {
  id: string;
  kind: BlockKind;
  /** [x0, yTop, x1, yBottom] in PDF points, y measured from the bottom of the page. */
  bbox: [number, number, number, number];
  size: number;
  font: string;
  lines: string[];
  text: string;
  markers: number[];
  /** Table blocks only: each row's cells with their left edge. */
  cells?: TableCell[][];
}

export interface TableCell {
  text: string;
  x0: number;
  bold: boolean;
}

export interface ExtractedPage {
  pdfPage: number;
  printedNumber: string | null;
  footer: string | null;
  blocks: Block[];
  text: string;
}

export interface ExtractedDocument {
  source: string;
  pageCount: number;
  bodyFontSize: number;
  pages: ExtractedPage[];
  markers: Marker[];
}
