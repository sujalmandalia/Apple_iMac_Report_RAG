import { pool } from "../db/pool.js";
import { retrieve, type RetrieveOptions } from "../search/retrieve.js";
import { routeQuestion, type Route } from "./router.js";
import { buildSources, CONTEXT_TOKEN_BUDGET, endnoteSources, type Source } from "./sources.js";

export interface Gathered {
  route: Route;
  answerable: boolean;
  topScore: number;
  sources: Source[];
}

const ENDNOTE_BUDGET = 1500;
const BROAD_ENDNOTE_BUDGET = 3000;

/** The whole report as parents in reading order: 9 sections, 3 tables and the chart are about 3,800 tokens. */
async function wholeReport(): Promise<Source[]> {
  const { rows } = await pool.query<{ key: string; kind: string; section_path: string[]; pdf_pages: number[]; text: string }>(
    `SELECT key, kind, section_path, pdf_pages, text FROM parents ORDER BY pdf_pages[1], id`,
  );
  return rows.map((r, i) => ({
    id: `S${i + 1}`,
    citation: `[${r.kind === "table" ? "Table" : r.kind === "chart" ? "Chart" : r.section_path[0]}, p. ${r.pdf_pages[0]}]`,
    context: r.section_path.join(" > "),
    pdfPages: r.pdf_pages,
    type: "section" as const,
    exhibit: null,
    endnotes: [...new Set([...r.text.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])))],
    score: 1,
    chunkKeys: [r.key],
    usedParent: true,
    text: r.text,
  }));
}

export async function gatherSources(question: string, opts: RetrieveOptions = {}): Promise<Gathered> {
  const route = routeQuestion(question);

  if (route.kind === "broad") {
    // A question about "the report" is in scope by definition. Endnotes come along so that a summary keeps their
    // conditions ("recycled copper in the thermal module applies to iMac (four ports) only").
    const sources = await wholeReport();
    sources.push(...(await endnoteSources(sources, BROAD_ENDNOTE_BUDGET)));
    return { route, answerable: true, topScore: 1, sources };
  }

  const retrieval = await retrieve(question, { withParent: true, ...opts });
  const sources = buildSources(retrieval.hits, CONTEXT_TOKEN_BUDGET);
  sources.push(...(await endnoteSources(sources, ENDNOTE_BUDGET)));
  return { route, answerable: retrieval.answerable, topScore: retrieval.topScore, sources };
}
