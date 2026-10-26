import type { SearchHit } from "../search/vector.js";

export interface RelevantSource {
  pages?: number[];
  section?: string;
  exhibit?: string;
  type?: string;
  endnote?: number;
  contains?: string;
}

export interface EvalQuestion {
  id: string;
  category: string;
  question: string;
  relevant: RelevantSource[];
  answer?: string;
}

export interface QuestionResult {
  id: string;
  category: string;
  question: string;
  firstRelevantRank: number | null;
  topSimilarity: number;
  topScore: number;
  relevantSimilarity: number | null;
  hits: { key: string; type: string; pages: number[]; similarity: number; score: number; relevant: boolean; context: string }[];
}

export type Hit = Pick<SearchHit, "key" | "type" | "pdfPages" | "context" | "exhibit" | "endnotes" | "similarity" | "text"> & {
  rerankScore?: number;
};

// Judged by pages, exhibits, endnotes and text rather than chunk ids, so the set survives re-chunking.
export function isRelevant(hit: Hit, sources: RelevantSource[]): boolean {
  return sources.some(
    (s) =>
      (!s.exhibit || hit.exhibit === s.exhibit) &&
      (!s.type || hit.type === s.type) &&
      (!s.pages || s.pages.some((p) => hit.pdfPages.includes(p))) &&
      (!s.endnote || hit.endnotes.includes(s.endnote)) &&
      (!s.section || hit.context.toLowerCase().includes(s.section.toLowerCase())) &&
      (!s.contains || hit.text.toLowerCase().includes(s.contains.toLowerCase())),
  );
}

export function scoreQuestion(q: EvalQuestion, hits: Hit[]): QuestionResult {
  const judged = hits.map((h) => ({
    key: h.key,
    type: h.type,
    pages: h.pdfPages,
    similarity: h.similarity,
    score: h.rerankScore ?? h.similarity,
    relevant: isRelevant(h, q.relevant),
    context: h.context,
  }));
  const index = judged.findIndex((h) => h.relevant);
  return {
    id: q.id,
    category: q.category,
    question: q.question,
    firstRelevantRank: index >= 0 ? index + 1 : null,
    topSimilarity: judged[0]?.similarity ?? 0,
    topScore: judged[0]?.score ?? 0,
    relevantSimilarity: index >= 0 ? judged[index]!.similarity : null,
    hits: judged,
  };
}

export interface Summary {
  questions: number;
  hitAt1: number;
  recallAt3: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

export function summarize(results: QuestionResult[]): Summary {
  const n = results.length || 1;
  const within = (k: number) => results.filter((r) => r.firstRelevantRank !== null && r.firstRelevantRank <= k).length / n;
  return {
    questions: results.length,
    hitAt1: round(within(1)),
    recallAt3: round(within(3)),
    recallAt5: round(within(5)),
    recallAt10: round(within(10)),
    mrr: round(results.reduce((sum, r) => sum + (r.firstRelevantRank ? 1 / r.firstRelevantRank : 0), 0) / n),
  };
}
