import type { RequestHandler } from "express";

// In-memory sliding window per client IP; enough for a single process protecting a small free-tier quota.
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, number[]>();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - recent[0]!)) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: `Too many questions; try again in ${retryAfter}s.` });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.clear();
    next();
  };
}
