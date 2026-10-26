import type { MeasuredBar } from "./geometry.js";
import type { ChartCheck, ChartReading, ChartSegment } from "./types.js";

const SCALE_TOLERANCE = 0.02;
const MARKER = /\[\^(\d+)\]/g;
const strip = (s: string) => s.replace(MARKER, "").replace(/\s+/g, " ").trim();
const markersIn = (s: string) => [...s.matchAll(MARKER)].map((m) => Number(m[1]));

/**
 * Replaces the model's estimated segment values with values measured from the vector drawing.
 * The scale (units per point) comes from the bars whose totals are printed; it must agree across bars.
 * The model's reading still supplies bar labels, chart type, notes and the names of segments that carry no label
 * inside them (the 1 pt "Renewable energy emissions" sliver is labelled from outside the bar).
 */
export function applyMeasurements(reading: ChartReading, measured: MeasuredBar[]): { reading: ChartReading; checks: ChartCheck[] } {
  const checks: ChartCheck[] = [];
  if (measured.length !== reading.bars.length) {
    checks.push({ name: "measured bars match the model's bars", ok: false, detail: `${measured.length} drawn bars, ${reading.bars.length} read` });
    return { reading, checks };
  }

  // Positive bars are fully drawn: total height <-> printed total.
  const scales = reading.bars
    .map((bar, i) => ({ bar, height: measured[i]!.segments.reduce((n, s) => n + s.height, 0) }))
    .filter(({ bar, height }) => bar.totalValue > 0 && height > 0)
    .map(({ bar, height }) => ({ label: bar.label, scale: bar.totalValue / height }));
  const scale = scales.reduce((n, s) => n + s.scale, 0) / scales.length;
  const spread = Math.max(...scales.map((s) => Math.abs(s.scale - scale) / scale));
  checks.push({
    name: "one scale fits every printed total (vector drawing)",
    ok: scales.length > 0 && spread <= SCALE_TOLERANCE,
    detail: scales.map((s) => `${s.label} ${s.scale.toFixed(4)}`).join(", ") + ` ${reading.unit}/pt`,
  });

  const bars = reading.bars.map((bar, i) => {
    const drawn = measured[i]!;
    const named = new Set(drawn.segments.flatMap((s) => s.labels.map(strip)));
    const unnamed = bar.segments.filter((s) => !named.has(strip(s.label)));
    const segments: ChartSegment[] = drawn.segments.map((s) => {
      const label = s.labels.length ? s.labels.map(strip).join(" ") : (unnamed.shift()?.label ?? "(unlabelled)");
      const fromModel = bar.segments.find((m) => strip(m.label) === strip(label));
      return {
        label: strip(label),
        kind: s.reduction ? "reduction" : "emissions",
        value: Math.round(s.height * scale * 10) / 10,
        printed: false,
        method: "measured",
        footnotes: [...new Set([...s.labels.flatMap(markersIn), ...(fromModel?.footnotes ?? [])])],
      };
    });
    return { ...bar, segments };
  });

  for (const bar of bars) {
    const reduction = bar.totalValue < 0;
    const parts = bar.segments.filter((s) => s.kind === (reduction ? "reduction" : "emissions"));
    const sum = parts.reduce((n, s) => n + s.value, 0);
    checks.push({
      name: `"${bar.label}" measured ${reduction ? "reductions" : "segments"} add up to the printed total (±2%)`,
      ok: Math.abs(sum - Math.abs(bar.totalValue)) / Math.abs(bar.totalValue) <= SCALE_TOLERANCE,
      detail: `${parts.map((s) => s.value).join(" + ")} = ${sum.toFixed(1)}; printed ${bar.totalRaw}`,
    });
  }
  const unlabelled = bars.flatMap((b) => b.segments).filter((s) => s.label === "(unlabelled)");
  checks.push({
    name: "every measured segment has a label",
    ok: unlabelled.length === 0,
    detail: unlabelled.length ? `${unlabelled.length} without a label` : "all labelled",
  });

  return { reading: { ...reading, bars }, checks };
}
