import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Span } from "./types.js";

const STANDARD_FONTS = path.join(
  path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
  "standard_fonts/",
);

export interface RawPage {
  pdfPage: number;
  width: number;
  height: number;
  spans: Span[];
  rotatedDropped: number;
}

export async function readPdf(data: Uint8Array): Promise<RawPage[]> {
  const task = pdfjs.getDocument({
    data,
    fontExtraProperties: true,
    standardFontDataUrl: STANDARD_FONTS,
    verbosity: 0,
  });
  const doc = await task.promise;

  try {
    const pages: RawPage[] = [];
    for (let pdfPage = 1; pdfPage <= doc.numPages; pdfPage++) {
      const page = await doc.getPage(pdfPage);
      // Real font names are only available after the operator list has loaded the fonts.
      await page.getOperatorList();
      const { width, height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();

      const spans: Span[] = [];
      let rotatedDropped = 0;
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const [a = 0, b = 0, , d = 0, e = 0, f = 0] = item.transform as number[];
        if (Math.abs(b) > 0.01 || a <= 0) {
          rotatedDropped++;
          continue;
        }
        const font = (page.commonObjs.get(item.fontName) as { name?: string } | undefined)?.name ?? item.fontName;
        spans.push({
          text: item.str,
          x0: e,
          x1: e + item.width,
          y: f,
          size: Math.round(Math.abs(d) * 10) / 10,
          font: font.replace(/^[A-Z]{6}\+/, ""),
        });
      }

      pages.push({ pdfPage, width, height, spans, rotatedDropped });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
