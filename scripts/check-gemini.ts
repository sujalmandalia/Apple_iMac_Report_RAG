import { readFile } from "node:fs/promises";
import { Type } from "@google/genai";
import { ai, withRetry } from "../src/services/gemini.js";
import { config } from "../src/config.js";

const { embeddingModel, embeddingDimensions, chatModel, visionModel } = config.gemini;
const skipVision = process.argv.includes("--no-vision");

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (norm(a) * norm(b));
}

async function embed(texts: string[], taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT") {
  const res = await ai.models.embedContent({
    model: embeddingModel,
    contents: texts,
    config: { taskType, outputDimensionality: embeddingDimensions },
  });
  const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
  if (vectors.length !== texts.length) {
    throw new Error(`Sent ${texts.length} texts, got ${vectors.length} embeddings back.`);
  }
  return vectors;
}

console.log(`Embedding model: ${embeddingModel} @ ${embeddingDimensions} dims`);

const [question] = await embed(["How much power does the iMac use when idle?"], "RETRIEVAL_QUERY");
const [related, unrelated] = await embed(
  [
    "Power consumption for iMac | Mode: Idle—Display On | 100V: 20.5W | 115V: 20.6W | 230V: 20.9W",
    "iMac packaging is 100 percent fiber-based and contains no plastic except for inks, coatings, and adhesives.",
  ],
  "RETRIEVAL_DOCUMENT",
);

if (!question || !related || !unrelated) throw new Error("Missing embedding in response.");

console.log(`  vector length: ${question.length}`);
console.log(`  L2 norm (unnormalized): ${norm(question).toFixed(4)}`);
console.log(`  similarity(question, power table row):  ${cosine(question, related).toFixed(4)}`);
console.log(`  similarity(question, packaging passage): ${cosine(question, unrelated).toFixed(4)}`);

console.log(`\nChat model: ${chatModel}`);
let started = Date.now();
const reply = await ai.models.generateContent({
  model: chatModel,
  contents: "In one sentence: what is retrieval-augmented generation?",
});
console.log(`  (${Date.now() - started}ms) ${reply.text?.trim()}`);

if (skipVision) process.exit(0);

// Vision check: the page 2 chart prints only the three bar totals, so the model must read them off the drawing.
console.log(`\nVision model: ${visionModel} (reading the page 2 chart from ${config.reportPdf})`);
const pdf = await readFile(config.reportPdf);
started = Date.now();
const vision = await withRetry("vision", () => ai.models.generateContent({
  model: visionModel,
  contents: [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "application/pdf", data: pdf.toString("base64") } },
        { text: "Look at the bar chart on page 2. Return the chart title and the three bar totals exactly as printed." },
      ],
    },
  ],
  config: {
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        bars: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: { label: { type: Type.STRING }, total: { type: Type.STRING } },
            required: ["label", "total"],
          },
        },
      },
      required: ["title", "bars"],
    },
  },
}));
console.log(`  (${Date.now() - started}ms, ${vision.usageMetadata?.promptTokenCount ?? "?"} prompt tokens)`);
console.log(`  ${vision.text?.trim()}`);
console.log("  expected bars: 445 kg (baseline), –99 kg (reductions), 346 kg (iMac emissions)");
