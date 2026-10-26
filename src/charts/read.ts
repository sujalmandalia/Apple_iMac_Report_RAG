import { ApiError, Type } from "@google/genai";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { config } from "../config.js";
import { ai, QuotaExhaustedError, withRetry } from "../services/gemini.js";
import type { ChartReading } from "./types.js";

export const PROMPT_VERSION = 1;

/** One page as its own PDF: the model sees only the chart's page, which keeps the request small. */
export async function extractPage(pdf: Uint8Array, pdfPage: number): Promise<Uint8Array> {
  const source = await PDFDocument.load(pdf);
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(source, [pdfPage - 1]);
  out.addPage(page!);
  return out.save();
}

export function chartPrompt(title: string, labels: string): string {
  return `This is one page of Apple's iMac Product Environmental Report. It contains a chart under the heading "${title}".
The PDF text layer has these labels inside the chart, in no particular order (endnote markers are written [^n]):
${labels}

Return the chart as data:
- The chart type, the unit of the bars, and a one-sentence description of what the chart shows.
- Every bar from left to right: its label, its total exactly as printed (for example "445 kg") and that total as a number
  (negative for a reduction), the endnote numbers on its label, and its stacked segments from bottom to top.
- Every segment: its label as printed, kind "emissions" for a solid segment or "reduction" for a dashed or outlined
  segment that stands for emissions removed, the endnote numbers on its label, and its value in the chart's unit.
  Segment values are not printed: estimate each one from the segment's height relative to the bar's printed total
  and set printed to false. Only set printed to true when that exact number appears on the page.
- Notes on anything else the chart shows (arrows, labels pointing at segments too small to see).
Use only labels that appear on the page.`;
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    chartType: { type: Type.STRING },
    unit: { type: Type.STRING },
    description: { type: Type.STRING },
    bars: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          totalRaw: { type: Type.STRING },
          totalValue: { type: Type.NUMBER },
          footnotes: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          segments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                kind: { type: Type.STRING, enum: ["emissions", "reduction"] },
                value: { type: Type.NUMBER },
                printed: { type: Type.BOOLEAN },
                footnotes: { type: Type.ARRAY, items: { type: Type.INTEGER } },
              },
              required: ["label", "kind", "value", "printed", "footnotes"],
              propertyOrdering: ["label", "kind", "value", "printed", "footnotes"],
            },
          },
        },
        required: ["label", "totalRaw", "totalValue", "footnotes", "segments"],
        propertyOrdering: ["label", "totalRaw", "totalValue", "footnotes", "segments"],
      },
    },
    notes: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["chartType", "unit", "description", "bars", "notes"],
  propertyOrdering: ["chartType", "unit", "description", "bars", "notes"],
};

// The response schema shapes generation; zod guards against a truncated or malformed reply anyway.
const ReadingSchema = z.object({
  chartType: z.string(),
  unit: z.string(),
  description: z.string(),
  bars: z
    .array(
      z.object({
        label: z.string(),
        totalRaw: z.string(),
        totalValue: z.number(),
        footnotes: z.array(z.number().int()),
        segments: z.array(
          z.object({
            label: z.string(),
            kind: z.enum(["emissions", "reduction"]),
            value: z.number(),
            printed: z.boolean(),
            footnotes: z.array(z.number().int()),
          }),
        ),
      }),
    )
    .min(1),
  notes: z.array(z.string()),
});

async function readWith(model: string, page: Uint8Array, prompt: string): Promise<ChartReading> {
  const res = await withRetry(`chart (${model})`, () =>
    ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "application/pdf", data: Buffer.from(page).toString("base64") } }, { text: prompt }],
        },
      ],
      config: { responseMimeType: "application/json", responseSchema, temperature: 0 },
    }),
  );
  const parsed = ReadingSchema.parse(JSON.parse(res.text ?? ""));
  return {
    ...parsed,
    bars: parsed.bars.map((b) => ({ ...b, segments: b.segments.map((seg) => ({ ...seg, method: "estimated" as const })) })),
  };
}

const overloaded = (err: unknown) =>
  err instanceof QuotaExhaustedError || (err instanceof ApiError && (err.status === 429 || err.status >= 500));

/** Reads with the vision model and falls back to the fallback model when the first is overloaded or out of quota. */
export async function readChart(page: Uint8Array, prompt: string): Promise<{ reading: ChartReading; model: string }> {
  const models = [...new Set([config.gemini.visionModel, config.gemini.chatFallbackModel].filter((m): m is string => !!m))];
  let lastError: unknown;
  for (const model of models) {
    try {
      return { reading: await readWith(model, page, prompt), model };
    } catch (err) {
      lastError = err;
      if (!overloaded(err)) throw err;
      console.warn(`  ${model} unavailable (${(err as Error).message.slice(0, 80)}); trying the next model`);
    }
  }
  throw lastError;
}
