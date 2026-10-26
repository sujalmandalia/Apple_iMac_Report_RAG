import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

type Matrix = [number, number, number, number, number, number];

export interface Shape {
  /** Page coordinates, y up. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  paint: "fill" | "stroke";
  color: string;
  dashed: boolean;
}

interface GraphicsState {
  ctm: Matrix;
  fill: string;
  stroke: string;
  dashed: boolean;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m applied first, then n (PDF concatenation order for "cm"). */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function transformBox(ctm: Matrix, [x0, y0, x1, y1]: number[]): [number, number, number, number] {
  const points = [
    [x0!, y0!],
    [x1!, y0!],
    [x0!, y1!],
    [x1!, y1!],
  ].map(([x, y]) => [ctm[0] * x! + ctm[2] * y! + ctm[4], ctm[1] * x! + ctm[3] * y! + ctm[5]]);
  const xs = points.map((p) => p[0]!);
  const ys = points.map((p) => p[1]!);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const FILL_OPS = new Set<number>([pdfjs.OPS.fill, pdfjs.OPS.eoFill, pdfjs.OPS.fillStroke, pdfjs.OPS.eoFillStroke, pdfjs.OPS.closeFillStroke, pdfjs.OPS.closeEOFillStroke]);
const STROKE_OPS = new Set<number>([pdfjs.OPS.stroke, pdfjs.OPS.closeStroke, pdfjs.OPS.fillStroke, pdfjs.OPS.eoFillStroke, pdfjs.OPS.closeFillStroke, pdfjs.OPS.closeEOFillStroke]);

/**
 * Every filled or stroked path on a page with its bounding box in page coordinates. Vector charts are drawn this way,
 * so bar segments can be measured exactly instead of estimated from an image.
 */
export async function pageShapes(pdf: Uint8Array, pdfPage: number): Promise<Shape[]> {
  const task = pdfjs.getDocument({ data: pdf.slice(), verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pdfPage);
    const { fnArray, argsArray } = await page.getOperatorList();

    const shapes: Shape[] = [];
    const stack: GraphicsState[] = [];
    let gs: GraphicsState = { ctm: IDENTITY, fill: "#000000", stroke: "#000000", dashed: false };

    fnArray.forEach((fn, i) => {
      const args = argsArray[i] as any[];
      switch (fn) {
        case pdfjs.OPS.save:
        case pdfjs.OPS.paintFormXObjectBegin:
          stack.push(gs);
          gs = { ...gs };
          if (fn === pdfjs.OPS.paintFormXObjectBegin && Array.isArray(args?.[0])) gs.ctm = multiply(args[0] as Matrix, gs.ctm);
          break;
        case pdfjs.OPS.restore:
        case pdfjs.OPS.paintFormXObjectEnd:
          gs = stack.pop() ?? gs;
          break;
        case pdfjs.OPS.transform:
          gs.ctm = multiply(args as Matrix, gs.ctm);
          break;
        case pdfjs.OPS.setFillRGBColor:
          gs.fill = String(args[0]);
          break;
        case pdfjs.OPS.setStrokeRGBColor:
          gs.stroke = String(args[0]);
          break;
        case pdfjs.OPS.setDash:
          gs.dashed = Array.isArray(args[0]) ? args[0].length > 0 : ArrayBuffer.isView(args[0]) && (args[0] as Float32Array).length > 0;
          break;
        case pdfjs.OPS.constructPath: {
          // pdfjs 5+: [paintOp, [pathData], minMax]
          const [paintOp, , minMax] = args as [number, unknown, number[] | null];
          if (!minMax) break;
          const [x0, y0, x1, y1] = transformBox(gs.ctm, Array.from(minMax));
          if (FILL_OPS.has(paintOp)) shapes.push({ x0, y0, x1, y1, paint: "fill", color: gs.fill, dashed: false });
          if (STROKE_OPS.has(paintOp)) shapes.push({ x0, y0, x1, y1, paint: "stroke", color: gs.stroke, dashed: gs.dashed });
          break;
        }
      }
    });
    page.cleanup();
    return shapes;
  } finally {
    await task.destroy();
  }
}

export interface LabelBox {
  text: string;
  /** [x0, yTop, x1, yBottom] as in the extracted blocks. */
  bbox: [number, number, number, number];
}

export interface MeasuredSegment {
  y0: number;
  y1: number;
  height: number;
  color: string;
  /** Drawn with a dashed outline: emissions that were removed. */
  reduction: boolean;
  labels: string[];
}

export interface MeasuredBar {
  x0: number;
  x1: number;
  /** Bottom to top. */
  segments: MeasuredSegment[];
}

const MIN_BAR_WIDTH = 30;
const MIN_SEGMENT_HEIGHT = 0.5;
const COLUMN_TOLERANCE = 2;
const REGION_MARGIN = 30;

/**
 * Bars are columns of filled rectangles inside the chart's label area. Each label is assigned to the segment that
 * contains its centre; a dashed outline on top of a segment marks it as a reduction.
 */
export function measureBars(shapes: Shape[], labels: LabelBox[]): MeasuredBar[] {
  const region = {
    x0: Math.min(...labels.map((l) => l.bbox[0])) - REGION_MARGIN,
    x1: Math.max(...labels.map((l) => l.bbox[2])) + REGION_MARGIN,
    y0: Math.min(...labels.map((l) => l.bbox[3])) - REGION_MARGIN,
    y1: Math.max(...labels.map((l) => l.bbox[1])) + REGION_MARGIN,
  };
  const inside = (s: Shape) => s.x0 >= region.x0 && s.x1 <= region.x1 && s.y0 >= region.y0 && s.y1 <= region.y1;

  const seen = new Set<string>();
  const fills = shapes.filter((s) => {
    if (s.paint !== "fill" || !inside(s) || /^#f{6}$/i.test(s.color)) return false;
    if (s.x1 - s.x0 < MIN_BAR_WIDTH || s.y1 - s.y0 < MIN_SEGMENT_HEIGHT) return false;
    const key = [s.x0, s.y0, s.x1, s.y1].map((n) => Math.round(n * 2)).join();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dashed = shapes.filter((s) => s.paint === "stroke" && s.dashed && inside(s));

  const bars: MeasuredBar[] = [];
  for (const fill of [...fills].sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0)) {
    let bar = bars.find((b) => Math.abs(b.x0 - fill.x0) <= COLUMN_TOLERANCE && Math.abs(b.x1 - fill.x1) <= COLUMN_TOLERANCE);
    if (!bar) bars.push((bar = { x0: fill.x0, x1: fill.x1, segments: [] }));
    const within = (s: Shape) => s.x0 >= fill.x0 - 2 && s.x1 <= fill.x1 + 2 && s.y0 >= fill.y0 - 2 && s.y1 <= fill.y1 + 2;
    bar.segments.push({
      y0: fill.y0,
      y1: fill.y1,
      height: fill.y1 - fill.y0,
      color: fill.color,
      reduction: dashed.some(within),
      labels: [],
    });
  }

  for (const label of labels) {
    const cx = (label.bbox[0] + label.bbox[2]) / 2;
    const cy = (label.bbox[1] + label.bbox[3]) / 2;
    for (const bar of bars) {
      if (cx < bar.x0 || cx > bar.x1) continue;
      bar.segments.find((s) => cy >= s.y0 - 1 && cy <= s.y1 + 1)?.labels.push(label.text);
    }
  }
  for (const bar of bars) bar.segments.sort((a, b) => a.y0 - b.y0);
  return bars;
}
