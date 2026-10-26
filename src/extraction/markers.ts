import type { Marker, Span } from "./types.js";

const MARKER_TEXT = /^\d{1,2}(?:,\d{1,2})*$/;
// "Baseline emissions7", "materials8": chart labels carry the marker inside the same span at full size.
// Requiring lowercase letters right before the digits keeps CO2e, GWP100, AR6 and "ISO 14040" intact.
const GLUED = /^(.*[a-z]{3}[.)]?)(\d{1,2})$/;
const MAX_ENDNOTE = 99;

export const markerToken = (num: number) => `[^${num}]`;

const isSmaller = (marker: Span, base: Span) => marker.size <= base.size * 0.8;
const raised = (marker: Span, base: Span) => marker.y >= base.y - 0.5 && marker.y - base.y < base.size * 0.7;

/**
 * Rewrites endnote markers into [^n] tokens so they survive line joining and can be linked later:
 * - a small raised number right after a word is appended to that word's span;
 * - a small number right before a line of text starts an endnote definition, "[^n]: ...";
 * - a number glued to the end of a label is split off.
 * Markers with no neighbouring text (e.g. next to a logo) are kept as their own span.
 */
export function rewriteMarkers(spans: Span[], pdfPage: number): { spans: Span[]; markers: Marker[] } {
  const markers: Marker[] = [];
  const consumed = new Set<Span>();
  const out = spans.map((s) => ({ ...s }));

  for (const span of out) {
    const text = span.text.trim();
    if (!MARKER_TEXT.test(text)) continue;
    const nums = text.split(",").map(Number);
    if (nums.some((n) => n < 1 || n > MAX_ENDNOTE)) continue;

    const before = out
      .filter((b) => b !== span && !consumed.has(b) && isSmaller(span, b) && raised(span, b))
      .filter((b) => span.x0 - b.x1 > -1.5 && span.x0 - b.x1 < 4)
      .sort((a, b) => Math.abs(span.x0 - a.x1) - Math.abs(span.x0 - b.x1))[0];
    if (before) {
      before.text = before.text.trimEnd() + nums.map(markerToken).join("");
      before.x1 = Math.max(before.x1, span.x1);
      consumed.add(span);
      for (const num of nums) markers.push({ num, form: "superscript", pdfPage, anchor: lastWords(before.text) });
      continue;
    }

    const after = out
      .filter((b) => b !== span && !consumed.has(b) && isSmaller(span, b) && raised(span, b))
      .filter((b) => b.x0 - span.x1 > -1.5 && b.x0 - span.x1 < 4)[0];
    if (after && nums.length === 1) {
      after.text = `${markerToken(nums[0]!)}: ${after.text}`;
      after.x0 = Math.min(after.x0, span.x0);
      consumed.add(span);
      markers.push({ num: nums[0]!, form: "definition", pdfPage, anchor: after.text.slice(0, 60) });
      continue;
    }

    if (span.size < 6) {
      span.text = nums.map(markerToken).join("");
      for (const num of nums) markers.push({ num, form: "superscript", pdfPage, anchor: "(no adjacent text)" });
    }
  }

  for (const span of out) {
    if (consumed.has(span)) continue;
    const glued = GLUED.exec(span.text.trimEnd());
    if (!glued) continue;
    const num = Number(glued[2]);
    if (num < 1 || num > MAX_ENDNOTE) continue;
    span.text = glued[1]! + markerToken(num);
    markers.push({ num, form: "glued", pdfPage, anchor: lastWords(glued[1]!) });
  }

  return { spans: out.filter((s) => !consumed.has(s)), markers };
}

function lastWords(text: string): string {
  return text.replace(/\[\^\d+\]/g, "").trim().split(/\s+/).slice(-4).join(" ");
}
