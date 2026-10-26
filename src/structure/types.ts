import type { TableCell } from "../extraction/types.js";

export type ElementType = "paragraph" | "highlight" | "definition" | "table" | "chart" | "endnote" | "legal";

export interface Element {
  id: string;
  type: ElementType;
  /** [section, subsection?], e.g. ["Overview", "Packaging"] or ["Endnotes", "Endnote 18"]. */
  sectionPath: string[];
  pdfPages: number[];
  text: string;
  /** Endnote numbers this element carries ([^n] in its text, or the endnote it belongs to). */
  markers: number[];
  blockIds: string[];
  /** false for content that should not be retrieved (copyright notice). */
  include: boolean;
  term?: string;
  exhibit?: string;
  title?: string;
  /** Table rows: each cell with its left edge, parsed in the table phase. */
  cells?: TableCell[][];
  notes?: string[];
}

export interface MarkerUse {
  elementId: string;
  pdfPage: number;
  /** The sentence the marker qualifies, with markers stripped. */
  sentence: string;
}

export interface Endnote {
  num: number;
  pdfPage: number;
  text: string;
  usedBy: MarkerUse[];
}

export interface Exhibit {
  id: string;
  kind: "table" | "chart";
  title: string;
  pdfPage: number;
  elementId: string;
}

export interface Section {
  title: string;
  pdfPages: number[];
  subsections: string[];
}

export interface DocumentStructure {
  source: string;
  meta: { title: string; product: string; dateIntroduced: string | null; pageCount: number };
  sections: Section[];
  elements: Element[];
  endnotes: Endnote[];
  exhibits: Exhibit[];
  glossary: Record<string, string>;
  issues: string[];
}
