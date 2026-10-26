export type SegmentKind = "emissions" | "reduction";

export interface ChartSegment {
  label: string;
  kind: SegmentKind;
  /** In the chart's unit. Estimated from the drawing unless printed is true. */
  value: number;
  printed: boolean;
  /** "measured" from the vector drawing, or "estimated" by the vision model from the image. */
  method: "measured" | "estimated";
  footnotes: number[];
}

export interface ChartBar {
  label: string;
  totalRaw: string;
  totalValue: number;
  footnotes: number[];
  /** Bottom to top. */
  segments: ChartSegment[];
}

/** What the vision model returns (validated with zod before use). */
export interface ChartReading {
  chartType: string;
  unit: string;
  description: string;
  bars: ChartBar[];
  notes: string[];
}

export interface ChartCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Chart extends ChartReading {
  id: string;
  elementId: string;
  title: string;
  pdfPage: number;
  sectionPath: string[];
  /** Endnotes referenced by the chart's labels in the PDF text layer. */
  markers: number[];
  model: string;
  cacheKey: string;
  checks: ChartCheck[];
  /** true when every printed number matched the PDF text and the arithmetic holds. */
  verified: boolean;
}
