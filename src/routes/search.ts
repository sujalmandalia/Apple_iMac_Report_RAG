import { Router } from "express";
import { z } from "zod";
import { httpError } from "../middleware/errorHandler.js";
import { retrieve } from "../search/retrieve.js";
import { RERANKERS } from "../search/rerank.js";
import { citationOf } from "../search/vector.js";

const CHUNK_TYPES = ["text", "highlight", "definition", "table", "table_row", "chart", "endnote"] as const;

const SearchQuery = z.object({
  q: z.string().trim().min(3).max(500),
  k: z.coerce.number().int().min(1).max(50).default(8),
  type: z
    .string()
    .transform((s) => s.split(",").map((t) => t.trim()))
    .pipe(z.array(z.enum(CHUNK_TYPES)))
    .optional(),
  section: z.string().trim().max(200).optional(),
  variant: z.string().trim().max(100).optional(),
  parent: z.enum(["true", "false"]).transform((v) => v === "true").default(false),
  mode: z.enum(["vector", "keyword", "hybrid"]).default("hybrid"),
  rerank: z.enum(RERANKERS as [string, ...string[]]).optional(),
  minScore: z.coerce.number().min(0).max(1).optional(),
});

export const searchRouter = Router();

searchRouter.get("/search", async (req, res) => {
  const parsed = SearchQuery.safeParse(req.query);
  if (!parsed.success) throw httpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const { q, k, type, section, variant, parent, mode, rerank, minScore } = parsed.data;

  const started = Date.now();
  const result = await retrieve(q, {
    k,
    mode,
    reranker: rerank as (typeof RERANKERS)[number] | undefined,
    minScore,
    filters: { types: type, section, variant },
    withParent: parent,
  });

  res.json({
    query: q,
    mode,
    reranker: result.reranker,
    answerable: result.answerable,
    topScore: result.topScore,
    minScore: result.minScore,
    tookMs: Date.now() - started,
    results: result.hits.map((h) => ({ ...h, citation: citationOf(h) })),
  });
});
