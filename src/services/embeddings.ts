import { config } from "../config.js";
import { ai, sleep, withRetry } from "./gemini.js";

export type EmbeddingTask = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";

export function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) throw new Error("Cannot normalize a zero vector.");
  return vector.map((x) => x / norm);
}

export const toSqlVector = (vector: number[]) => `[${vector.join(",")}]`;

export async function embedTexts(texts: string[], taskType: EmbeddingTask): Promise<number[][]> {
  const { embeddingModel, embeddingDimensions } = config.gemini;
  return withRetry("embed", async () => {
    const res = await ai.models.embedContent({
      model: embeddingModel,
      contents: texts,
      config: { taskType, outputDimensionality: embeddingDimensions },
    });
    const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== embeddingDimensions)) {
      throw new Error(`Expected ${texts.length} embeddings of ${embeddingDimensions} dims, got ${vectors.length}.`);
    }
    // Gemini only returns unit vectors at 3072 dims; truncated ones must be renormalized.
    return vectors.map(normalize);
  });
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text], "RETRIEVAL_QUERY");
  return vector!;
}

export class TokenRateLimiter {
  private log: { at: number; tokens: number }[] = [];

  constructor(
    private tokensPerMinute: number,
    private requestsPerMinute: number,
  ) {}

  async take(tokens: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.log = this.log.filter((e) => now - e.at < 60_000);
      const used = this.log.reduce((n, e) => n + e.tokens, 0);
      if (this.log.length < this.requestsPerMinute && (used + tokens <= this.tokensPerMinute || this.log.length === 0)) {
        this.log.push({ at: now, tokens });
        return;
      }
      const wait = 60_000 - (now - this.log[0]!.at) + 50;
      console.log(`  rate limit: ${used} tokens in the last minute, waiting ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}
