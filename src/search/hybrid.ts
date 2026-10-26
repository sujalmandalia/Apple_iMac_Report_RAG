import { exhibitSearch, expandQuery, keywordSearch, type RankedId } from "./keyword.js";
import { fetchHits, vectorSearch, type SearchHit, type SearchOptions } from "./vector.js";

export type SearchMode = "vector" | "keyword" | "hybrid";

export interface HybridHit extends SearchHit {
  score: number;
  ranks: { vector: number | null; keyword: number | null; exhibit: number | null };
  matchedTerms: string[];
}

export interface HybridOptions extends SearchOptions {
  mode?: SearchMode;
  candidates?: number;
  weights?: { vector: number; keyword: number; exhibit: number };
}

const RRF_K = 60;
const DEFAULT_WEIGHTS = { vector: 1, keyword: 0.5, exhibit: 1 };

// RRF only looks at positions, so cosine similarities and BM25 scores never have to be put on the same scale.
function fuse(lists: Record<keyof typeof DEFAULT_WEIGHTS, RankedId[]>, weights: typeof DEFAULT_WEIGHTS) {
  const fused = new Map<string, { score: number; ranks: HybridHit["ranks"]; matched: string[] }>();
  for (const [name, list] of Object.entries(lists) as [keyof typeof DEFAULT_WEIGHTS, RankedId[]][]) {
    list.forEach((item, index) => {
      const entry = fused.get(item.id) ?? { score: 0, ranks: { vector: null, keyword: null, exhibit: null }, matched: [] };
      entry.score += weights[name] / (RRF_K + index + 1);
      entry.ranks[name] = index + 1;
      if (item.matched) entry.matched = item.matched;
      fused.set(item.id, entry);
    });
  }
  return [...fused].sort((a, b) => b[1].score - a[1].score);
}

export async function search(query: string, opts: HybridOptions): Promise<HybridHit[]> {
  const mode = opts.mode ?? "hybrid";
  const candidates = Math.max(opts.candidates ?? 30, opts.k);
  const weights = opts.weights ?? DEFAULT_WEIGHTS;

  const expanded = mode === "vector" ? query : expandQuery(query);
  const [vectorHits, keywordIds, exhibitIds] = await Promise.all([
    mode === "keyword" ? Promise.resolve([]) : vectorSearch(query, { ...opts, k: mode === "vector" ? opts.k : candidates }),
    mode === "vector" ? Promise.resolve([]) : keywordSearch(expanded, candidates, opts.filters),
    mode === "vector" ? Promise.resolve([]) : exhibitSearch(query, opts.filters),
  ]);

  const ranked = fuse(
    { vector: vectorHits.map((h) => ({ id: h.id, score: h.similarity })), keyword: keywordIds, exhibit: exhibitIds },
    weights,
  ).slice(0, opts.k);

  const known = new Map(vectorHits.map((h) => [h.id, h]));
  const missing = ranked.map(([id]) => id).filter((id) => !known.has(id));
  for (const [id, hit] of await fetchHits(missing, query, opts.withParent)) known.set(id, hit);

  return ranked.map(([id, f]) => ({
    ...known.get(id)!,
    score: Number(f.score.toFixed(5)),
    ranks: f.ranks,
    matchedTerms: f.matched,
  }));
}
