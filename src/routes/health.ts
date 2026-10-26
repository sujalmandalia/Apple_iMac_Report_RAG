import { Router } from "express";
import { access } from "node:fs/promises";
import { pool } from "../db/pool.js";
import { config } from "../config.js";

export const healthRouter = Router();

// Gemini is not called here: polling would burn free-tier quota.
healthRouter.get("/health", async (_req, res) => {
  const checks: Record<string, unknown> = {};
  let ok = true;

  try {
    const { rows } = await pool.query<{ vector: string | null }>(
      `SELECT (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector`,
    );
    const vector = rows[0]?.vector ?? null;
    checks.postgres = "ok";
    checks.pgvector = vector ?? "missing - run npm run db:setup";
    if (!vector) ok = false;
  } catch (err) {
    ok = false;
    checks.postgres = `error: ${(err as Error).message}`;
  }

  try {
    await access(config.reportPdf);
    checks.reportPdf = config.reportPdf;
  } catch {
    ok = false;
    checks.reportPdf = `not found: ${config.reportPdf}`;
  }

  checks.embedding = `${config.gemini.embeddingModel} @ ${config.gemini.embeddingDimensions}d`;
  checks.chatModel = config.gemini.chatModel;
  checks.chatFallbackModel = config.gemini.chatFallbackModel ?? null;
  checks.visionModel = config.gemini.visionModel;

  res.status(ok ? 200 : 503).json({ ok, checks });
});
