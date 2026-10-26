import { readFile } from "node:fs/promises";
import { readPdf, type RawPage } from "./pdf.js";
import { buildBlocks, dominantFontSize, groupRows, readingOrder } from "./layout.js";
import { rewriteMarkers } from "./markers.js";
import { buildVocabulary, normalizeText } from "./text.js";
import type { ExtractedDocument, ExtractedPage, Marker, Span } from "./types.js";

const FOOTER_ZONE = 42;
const FOOTER = /^(.+?\|.+?)\s+(\d{1,3})$/;
const DECORATIVE_FONT = /GreenMarker/;
const DECORATIVE_MAX_SIZE = 8;

/** The running footer "iMac | Product Environmental Report  N" sits at y ≈ 37.7; the page 1 scope notes just above it are content. */
function splitFooter(spans: Span[]): { body: Span[]; footer: string | null; printedNumber: string | null } {
  for (const row of groupRows(spans.filter((s) => s.y < FOOTER_ZONE))) {
    const text = normalizeText(row.map((s) => s.text).join(" ")).replace(/\s+/g, " ").trim();
    const match = FOOTER.exec(text);
    if (match) {
      return { body: spans.filter((s) => !row.includes(s)), footer: match[1]!, printedNumber: match[2]! };
    }
  }
  return { body: spans, footer: null, printedNumber: null };
}

export async function extractDocument(pdfPath: string): Promise<ExtractedDocument & { stats: ExtractionStats }> {
  const raws = await readPdf(new Uint8Array(await readFile(pdfPath)));
  const bodySize = dominantFontSize(raws.flatMap((r) => r.spans));

  const prepared = raws.map((raw: RawPage) => {
    // The small life-cycle wheel in the page 4-8 sidebars repeats the stage name as decoration.
    const visible = raw.spans.filter((s) => !(DECORATIVE_FONT.test(s.font) && s.size < DECORATIVE_MAX_SIZE));
    const { body, footer, printedNumber } = splitFooter(visible);
    const { spans, markers } = rewriteMarkers(body, raw.pdfPage);
    return { raw, footer, printedNumber, rows: groupRows(spans), markers };
  });

  const vocab = buildVocabulary(prepared.flatMap((p) => p.rows.map((r) => r.map((s) => s.text).join(" "))));
  const markers: Marker[] = prepared.flatMap((p) => p.markers);

  const pages: ExtractedPage[] = prepared.map((p) => {
    const blocks = readingOrder(buildBlocks(p.rows, bodySize, vocab));
    blocks.forEach((b, i) => (b.id = `p${p.raw.pdfPage}-b${i + 1}`));
    return {
      pdfPage: p.raw.pdfPage,
      printedNumber: p.printedNumber,
      footer: p.footer,
      blocks,
      text: blocks.map((b) => b.text).join("\n\n"),
    };
  });

  const allBlocks = pages.flatMap((p) => p.blocks);
  return {
    source: pdfPath,
    pageCount: pages.length,
    bodyFontSize: bodySize,
    pages,
    markers,
    stats: {
      footersRemoved: pages.filter((p) => p.footer).length,
      rotatedSpansDropped: raws.reduce((n, r) => n + r.rotatedDropped, 0),
      blocks: allBlocks.length,
      byKind: Object.fromEntries(
        (["heading", "text", "table", "marker"] as const).map((k) => [k, allBlocks.filter((b) => b.kind === k).length]),
      ),
      characters: pages.reduce((n, p) => n + p.text.length, 0),
    },
  };
}

export interface ExtractionStats {
  footersRemoved: number;
  rotatedSpansDropped: number;
  blocks: number;
  byKind: Record<string, number>;
  characters: number;
}
