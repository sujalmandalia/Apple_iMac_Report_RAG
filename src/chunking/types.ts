export type ChunkType = "text" | "highlight" | "definition" | "table" | "table_row" | "chart" | "endnote";

export interface ChunkLocation {
  /** [section, subsection?] */
  sectionPath: string[];
  pdfPages: number[];
}

export interface Parent extends ChunkLocation {
  id: string;
  kind: "section" | "table" | "chart";
  text: string;
  tokens: number;
}

export interface Chunk extends ChunkLocation {
  id: string;
  parentId: string | null;
  type: ChunkType;
  elementIds: string[];
  /** table-1, chart-1 ... */
  exhibit: string | null;
  /** Endnotes that qualify this chunk; their first sentence is in `text`, the full text is added at answer time. */
  endnotes: number[];
  /** Product configurations the chunk names, e.g. "iMac (four ports) 512GB". */
  variants: string[];
  /** Prefix that locates the chunk ("iMac environmental report > Carbon Footprint"); embedded with the text. */
  context: string;
  text: string;
  tokens: number;
}

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
  parentMaxTokens: number;
  endnoteSummaryChars: number;
}

export interface ChunkSet {
  source: string;
  options: ChunkOptions;
  parents: Parent[];
  chunks: Chunk[];
}
