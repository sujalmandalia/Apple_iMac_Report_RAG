import { ApiError, GoogleGenAI } from "@google/genai";
import { config } from "../config.js";

export const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

const MAX_ATTEMPTS = 6;
const MAX_RETRY_WAIT_MS = 90_000;

export class QuotaExhaustedError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(err: unknown, attempt: number): number | null {
  const status = err instanceof ApiError ? err.status : null;
  if (status !== 429 && (status === null || status < 500)) return null;
  const hinted = /retryDelay[\\"\s:]*(\d+(?:\.\d+)?)s/.exec(String((err as Error).message));
  return hinted ? Number(hinted[1]) * 1000 + 1000 : Math.min(2 ** attempt * 1000, 60_000);
}

export async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = retryDelayMs(err, attempt);
      if (delay !== null && delay > MAX_RETRY_WAIT_MS) {
        throw new QuotaExhaustedError(`Gemini quota exhausted for ${label}; retry suggested in ${Math.round(delay / 60_000)} min.`, delay);
      }
      if (delay === null || attempt >= MAX_ATTEMPTS) throw err;
      console.warn(`  ${label} failed (${(err as Error).message.slice(0, 80)}), retry ${attempt} in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
}
