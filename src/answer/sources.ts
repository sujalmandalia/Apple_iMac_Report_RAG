import { estimateTokens } from "../chunking/chunk.js";
import type { ChunkType } from "../chunking/types.js";
import { pool } from "../db/pool.js";
import type { RetrievedHit } from "../search/retrieve.js";
import { citationOf } from "../search/vector.js";

export interface Source {
  id: string;
  citation: string;
  context: string;
  pdfPages: number[];
  type: ChunkType | "endnote_full" | "section";
  exhibit: string | null;
  endnotes: number[];
  score: number;
  chunkKeys: string[];
  usedParent: boolean;
  text: string;
}

export const CONTEXT_TOKEN_BUDGET = 6000;

const MARKER = /\[\^(\d+)\]/g;

// Prefer the parent (section, whole table, chart with its page text), but fall back to the chunk when it would blow the budget.
export function buildSources(hits: RetrievedHit[], budget = CONTEXT_TOKEN_BUDGET, firstId = 1): Source[] {
  const sources: Source[] = [];
  const byParent = new Map<string, Source>();
  let used = 0;

  for (const hit of hits) {
    const parentKey = hit.parent?.key;
    const existing = parentKey ? byParent.get(parentKey) : undefined;
    if (existing) {
      existing.chunkKeys.push(hit.key);
      existing.endnotes = [...new Set([...existing.endnotes, ...hit.endnotes])];
      continue;
    }

    const useParent = !!hit.parent && used + hit.parent.tokens <= budget;
    const text = useParent ? hit.parent!.text : hit.text;
    const tokens = estimateTokens(text);
    if (used + tokens > budget && sources.length) break;
    used += tokens;

    const pdfPages = useParent ? hit.parent!.pdfPages : hit.pdfPages;
    const source: Source = {
      id: `S${sources.length + firstId}`,
      citation: citationOf({ ...hit, pdfPages }),
      context: hit.context,
      pdfPages,
      type: hit.type,
      exhibit: hit.exhibit,
      endnotes: [...new Set([...hit.endnotes, ...[...text.matchAll(MARKER)].map((m) => Number(m[1]))])],
      score: hit.rerankScore,
      chunkKeys: [hit.key],
      usedParent: useParent,
      text,
    };
    sources.push(source);
    if (useParent && parentKey) byParent.set(parentKey, source);
  }
  return sources;
}

/**
 * Chunks carry only the first sentence of each endnote; the full endnote is what qualifies a number
 * (test conditions, configuration, baseline). Every endnote referenced by a source becomes a source of its own.
 */
export async function endnoteSources(sources: Source[], budget: number): Promise<Source[]> {
  const present = new Set(sources.filter((s) => s.type === "endnote").flatMap((s) => s.endnotes));
  const wanted = [...new Set(sources.flatMap((s) => s.endnotes))].filter((n) => !present.has(n)).sort((a, b) => a - b);
  if (!wanted.length) return [];

  const { rows } = await pool.query<{ num: number; pdf_page: number; text: string }>(
    `SELECT num, pdf_page, text FROM endnotes WHERE num = ANY($1::int[]) ORDER BY num`,
    [wanted],
  );
  const out: Source[] = [];
  let used = 0;
  for (const row of rows) {
    const text = `Endnote ${row.num}: ${row.text}`;
    used += estimateTokens(text);
    if (used > budget) break;
    out.push({
      id: `S${sources.length + out.length + 1}`,
      citation: `[Endnote ${row.num}, p. ${row.pdf_page}]`,
      context: `Endnote ${row.num}`,
      pdfPages: [row.pdf_page],
      type: "endnote_full",
      exhibit: null,
      endnotes: [row.num],
      score: 0,
      chunkKeys: [],
      usedParent: false,
      text,
    });
  }
  return out;
}

export function formatSources(sources: Source[]): string {
  // The report does not number its tables; the exhibit label lets "table 3" or "the chart" be matched to a source.
  return sources
    .map((s) => `[${s.id}]${s.exhibit ? ` (${s.exhibit.replace("-", " ")})` : ""} ${s.context} ${s.citation}\n${s.text}`)
    .join("\n\n---\n\n");
}
