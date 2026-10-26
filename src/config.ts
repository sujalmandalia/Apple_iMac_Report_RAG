import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  GEMINI_API_KEY: z.string().min(1, "Get a free key at https://aistudio.google.com/apikey"),
  EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(128).max(3072).default(768),
  CHAT_MODEL: z.string().default("gemini-3.6-flash"),
  CHAT_FALLBACK_MODEL: z.string().optional(),
  VISION_MODEL: z.string().optional(),
  REWRITE_MODEL: z.string().optional(),
  REPORT_PDF: z.string().default("iMac_PER_Oct2024.pdf"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  RERANKER: z.enum(["none", "minilm", "bge", "llm"]).default("minilm"),
  RERANK_MODEL: z.string().optional(),
  RELEVANCE_MIN_SCORE: z.coerce.number().min(0).max(1).optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment. Copy .env.example to .env and fix:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  gemini: {
    apiKey: env.GEMINI_API_KEY,
    embeddingModel: env.EMBEDDING_MODEL,
    embeddingDimensions: env.EMBEDDING_DIMENSIONS,
    chatModel: env.CHAT_MODEL,
    chatFallbackModel: env.CHAT_FALLBACK_MODEL,
    // Chart reading runs once at ingestion and is cached, so it can use the stronger chat model by default.
    visionModel: env.VISION_MODEL ?? env.CHAT_MODEL,
    // Follow-up rewriting is a short structured call; the light model keeps the chat model's quota for answers.
    rewriteModel: env.REWRITE_MODEL ?? env.CHAT_FALLBACK_MODEL ?? env.CHAT_MODEL,
  },
  reportPdf: env.REPORT_PDF,
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
  retrieval: {
    reranker: env.RERANKER,
    // The "llm" reranker makes one Gemini call per question; the lighter model keeps the chat model's quota for answers.
    rerankModel: env.RERANK_MODEL ?? env.CHAT_FALLBACK_MODEL ?? env.CHAT_MODEL,
    // Relevance gate per reranker: below this top score the question is treated as not covered by the report.
    // Deliberately lenient (keeps every answerable eval question): cross-encoder scores are unreliable for terse
    // table rows, and the answer step refuses when the sources lack the answer. See README > Retrieval.
    minScores: {
      none: 0.6,
      minilm: 0.002,
      bge: 0.005,
      llm: 0.3,
      ...(env.RELEVANCE_MIN_SCORE !== undefined ? { [env.RERANKER]: env.RELEVANCE_MIN_SCORE } : {}),
    } as Record<"none" | "minilm" | "bge" | "llm", number>,
  },
} as const;
