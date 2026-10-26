import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { Type } from "@google/genai";
import { embeddingText } from "../chunking/chunk.js";
import { config } from "../config.js";
import { ai, withRetry } from "../services/gemini.js";
import type { SearchHit } from "./vector.js";

export type RerankerName = "none" | "minilm" | "bge" | "llm";
export const RERANKERS: RerankerName[] = ["none", "minilm", "bge", "llm"];

const CROSS_ENCODERS = {
  minilm: "Xenova/ms-marco-MiniLM-L-6-v2",
  bge: "Xenova/bge-reranker-base",
} as const;

env.cacheDir = "data/models";

const loaded = new Map<string, Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }>>();

function loadCrossEncoder(name: keyof typeof CROSS_ENCODERS) {
  const id = CROSS_ENCODERS[name];
  if (!loaded.has(id)) {
    loaded.set(
      id,
      Promise.all([
        AutoTokenizer.from_pretrained(id),
        AutoModelForSequenceClassification.from_pretrained(id, { dtype: "q8" }),
      ]).then(([tokenizer, model]) => ({ tokenizer, model })),
    );
  }
  return loaded.get(id)!;
}

// Attention cost grows with the square of length; 256 is ~3x faster but cuts off the second half of most chunks.
const CROSS_ENCODER_MAX_TOKENS = Number(process.env.CROSS_ENCODER_MAX_TOKENS ?? 512);

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

// A cross-encoder reads query and passage together, so it can judge relevance far better than comparing two separate embeddings.
async function crossEncoderScores(name: keyof typeof CROSS_ENCODERS, query: string, passages: string[]): Promise<number[]> {
  const { tokenizer, model } = await loadCrossEncoder(name);
  const inputs = tokenizer(new Array(passages.length).fill(query), {
    text_pair: passages,
    padding: true,
    truncation: true,
    max_length: CROSS_ENCODER_MAX_TOKENS,
  });
  const { logits } = await model(inputs);
  return (logits.tolist() as number[][]).map((row) => sigmoid(row[0]!));
}

const LLM_PASSAGE_CHARS = 1500;

async function llmScores(query: string, passages: string[]): Promise<number[]> {
  const numbered = passages.map((p, i) => `[${i}] ${p.slice(0, LLM_PASSAGE_CHARS)}`).join("\n\n");
  const prompt =
    `Rate how useful each passage is for answering the question, from 0 (unrelated) to 10 ` +
    `(directly contains the answer). Judge only the passage text, not general knowledge.\n\n` +
    `Question: ${query}\n\nPassages:\n${numbered}`;

  const res = await withRetry("rerank", () =>
    ai.models.generateContent({
      model: config.retrieval.rerankModel,
      contents: prompt,
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: { id: { type: Type.INTEGER }, score: { type: Type.NUMBER } },
            required: ["id", "score"],
          },
        },
      },
    }),
  );
  const scores = new Array<number>(passages.length).fill(0);
  for (const { id, score } of JSON.parse(res.text ?? "[]") as { id: number; score: number }[]) {
    if (id >= 0 && id < passages.length) scores[id] = Math.max(0, Math.min(10, score)) / 10;
  }
  return scores;
}

export async function scorePassages(query: string, passages: string[], reranker: Exclude<RerankerName, "none">): Promise<number[]> {
  if (!passages.length) return [];
  return reranker === "llm" ? llmScores(query, passages) : crossEncoderScores(reranker, query, passages);
}

export async function rerank<T extends SearchHit>(query: string, hits: T[], reranker: RerankerName): Promise<(T & { rerankScore: number })[]> {
  if (reranker === "none" || !hits.length) return hits.map((h) => ({ ...h, rerankScore: h.similarity }));
  const scores = await scorePassages(query, hits.map(embeddingText), reranker);
  return hits
    .map((h, i) => ({ ...h, rerankScore: Number(scores[i]!.toFixed(4)) }))
    .sort((a, b) => b.rerankScore - a.rerankScore);
}
