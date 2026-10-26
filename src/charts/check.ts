import type { Chart, ChartCheck, ChartReading, ChartSegment } from "./types.js";

const SEGMENT_TOLERANCE = 0.1;

const MARKER = /\[\^(\d+)\]/g;
const norm = (s: string) => s.replace(MARKER, "").replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
const PRINTED_NUMBER = /^-?\d[\d,.]*\s*\w*$/;

/**
 * The model's reading is trusted only where it can be checked against the page:
 * printed totals must be text in the PDF, labels must exist, the bridge must add up and endnotes must match.
 * Segment values are estimates; they only have to add up to their bar within 10 %.
 */
export function checkChart(reading: ChartReading, textLayer: string, extra: ChartCheck[] = []): { checks: ChartCheck[]; verified: boolean } {
  const labels = textLayer.split("\n").map(norm).filter(Boolean);
  const printed = labels.filter((l) => PRINTED_NUMBER.test(l));
  const checks: ChartCheck[] = [];

  const unmatched = reading.bars.filter((b) => !printed.includes(norm(b.totalRaw)));
  checks.push({
    name: "bar totals are printed in the PDF text",
    ok: unmatched.length === 0 && reading.bars.length === printed.length,
    detail: `model: ${reading.bars.map((b) => b.totalRaw).join(", ")}; text layer: ${printed.join(", ")}`,
  });

  const totals = reading.bars.map((b) => b.totalValue);
  if (totals.length >= 3) {
    const [first, ...rest] = totals;
    const last = rest.pop()!;
    const sum = rest.reduce((n, v) => n + v, first!);
    checks.push({
      name: "bridge adds up (first bar + changes = last bar)",
      ok: Math.abs(sum - last) < 0.5,
      detail: `${totals.slice(0, -1).join(" + ")} = ${sum}; last bar ${last}`,
    });
  }

  const invented = reading.bars.flatMap((b) => [b, ...b.segments]).filter((x) => !labels.includes(norm(x.label)));
  checks.push({
    name: "every bar and segment label is on the page",
    ok: invented.length === 0,
    detail: invented.length ? `not found: ${invented.map((x) => x.label).join(", ")}` : "all labels found",
  });

  const textNotes = [...new Set([...textLayer.matchAll(MARKER)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const modelNotes = [...new Set(reading.bars.flatMap((b) => [...b.footnotes, ...b.segments.flatMap((s) => s.footnotes)]))].sort((a, b) => a - b);
  checks.push({
    name: "endnote markers match the PDF text",
    ok: textNotes.join() === modelNotes.join(),
    detail: `model: ${modelNotes.join(",") || "-"}; text layer: ${textNotes.join(",") || "-"}`,
  });

  // Only model estimates need this sanity check; measured segments are checked against the drawing's scale.
  for (const bar of reading.bars.filter((b) => b.segments.some((seg) => seg.method === "estimated"))) {
    const kind = bar.totalValue < 0 ? "reduction" : "emissions";
    const parts = bar.segments.filter((s) => s.kind === kind);
    const sum = parts.reduce((n, s) => n + Math.abs(s.value), 0);
    const target = Math.abs(bar.totalValue);
    checks.push({
      name: `"${bar.label}" ${kind} segments add up to its total (estimates, ±${SEGMENT_TOLERANCE * 100}%)`,
      ok: target > 0 && Math.abs(sum - target) / target <= SEGMENT_TOLERANCE,
      detail: `${parts.map((s) => Math.round(s.value)).join(" + ")} = ${Math.round(sum)}; printed ${bar.totalRaw}`,
    });
  }

  checks.push(...extra);
  // Estimates can be off without making the chart wrong; printed facts, labels, endnotes and measurements cannot.
  const verified = checks.filter((c) => !c.name.includes("estimates")).every((c) => c.ok);
  return { checks, verified };
}

const fmt = (n: number) => (Math.abs(n) >= 10 ? String(Math.round(n)) : n.toFixed(1));
const notes = (nums: number[]) => nums.map((n) => `[^${n}]`).join("");

/** The text that represents the chart in search and in answers. */
export function chartText(chart: Chart): string {
  const unit = chart.unit.replace(/\s*co2e?/i, "").trim() || chart.unit;
  const segments = chart.bars.flatMap((b) => b.segments);
  const how = segments.every((s) => s.method === "measured")
    ? "segment values are not printed; they were measured from the bar heights in the PDF's vector drawing (approximate)"
    : "segment values are not printed; they are visual estimates from the bar heights (approximate)";
  const lines = [`Chart: ${chart.title} (page ${chart.pdfPage}). ${chart.description}`, `Unit: ${chart.unit}. Bar totals are printed in the report; ${how}.`];
  const part = (s: ChartSegment) => `${s.label}${notes(s.footnotes)} ${s.printed ? "" : "≈ "}${fmt(Math.abs(s.value))} ${unit}`;
  for (const bar of chart.bars) {
    // In a bridge, the reduction bar also draws the emissions that remain; only the reductions make up its total.
    const reduction = bar.totalValue < 0;
    const counted = bar.segments.filter((s) => s.kind === (reduction ? "reduction" : "emissions"));
    const rest = bar.segments.filter((s) => !counted.includes(s));
    let line = `${bar.label}${notes(bar.footnotes)}: ${bar.totalRaw}`;
    if (counted.length) line += ` = ${counted.map(part).join(" + ")}`;
    if (rest.length) line += `. Emissions remaining after these reductions: ${rest.map(part).join(", ")}`;
    lines.push(line);
  }
  for (const note of chart.notes) lines.push(`Note: ${note}`);
  return lines.join("\n");
}
