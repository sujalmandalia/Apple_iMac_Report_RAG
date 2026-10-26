import { pool } from "../db/pool.js";
import { filterSql, type SearchFilters } from "./vector.js";

export interface RankedId {
  id: string;
  score: number;
  matched?: string[];
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

// Abbreviations and everyday words for the report's terms; added to the keyword query so either form matches.
const ALIASES: Record<string, string> = {
  ghg: "greenhouse gas",
  lca: "life cycle assessment",
  co2: "carbon emissions",
  co2e: "carbon emissions",
  epeat: "Electronic Product Environmental Assessment Tool",
  aasp: "Apple Authorized Service Providers",
  "carbon footprint": "greenhouse gas emissions",
  "power use": "power consumption",
  "electricity use": "power consumption",
  idle: "Idle Display On",
  "energy star": "ENERGY STAR",
  "two-port": "two ports",
  "four-port": "four ports",
  "trade-in": "Trade In",
  recycling: "Recover recycle",
  // "off" is an English stopword, so the Off row is only reachable through its mode definition.
  "switched off": "lowest power mode shut down",
  "turned off": "lowest power mode shut down",
  sea: "non-air shipping transportation",
  rail: "non-air shipping transportation",
  ocean: "non-air shipping transportation",
  shipping: "transportation",
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function expandQuery(query: string): string {
  const additions = new Set<string>();
  for (const [alias, meaning] of Object.entries(ALIASES)) {
    if (new RegExp(`\\b${escapeRegex(alias)}\\b`, "i").test(query)) additions.add(meaning);
  }
  return additions.size ? `${query} ${[...additions].join(" ")}` : query;
}

// Postgres ts_rank has no notion of term rarity, so "iMac" would outweigh "230V"; BM25 adds IDF and length normalization.
export async function keywordSearch(query: string, k: number, filters?: SearchFilters): Promise<RankedId[]> {
  const params: unknown[] = [query];
  const where = filterSql(filters, params).join(" AND ");
  params.push(k);
  const limit = `$${params.length}`;

  const { rows } = await pool.query<{ id: string; score: number; matched: string[] }>(
    `WITH terms AS (
       SELECT DISTINCT lexeme FROM unnest(to_tsvector('english', $1))
     ),
     q AS (
       SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery AS query FROM terms
     ),
     corpus AS (
       SELECT count(*)::float AS n, avg(length(c.tsv))::float AS avglen FROM chunks c WHERE ${where}
     ),
     df AS (
       SELECT u.lexeme, count(*)::float AS df
       FROM chunks c, unnest(c.tsv) u
       WHERE u.lexeme IN (SELECT lexeme FROM terms) AND ${where}
       GROUP BY u.lexeme
     ),
     matched AS (
       SELECT c.id, length(c.tsv)::float AS len, u.lexeme,
              cardinality(u.positions) + (SELECT count(*) FROM unnest(u.weights) w WHERE w = 'A') AS tf
       FROM chunks c, q, unnest(c.tsv) u
       WHERE c.tsv @@ q.query AND u.lexeme IN (SELECT lexeme FROM terms) AND ${where}
     )
     SELECT m.id::text AS id,
            sum(ln(1 + (s.n - d.df + 0.5) / (d.df + 0.5))
                * m.tf * ${BM25_K1 + 1} / (m.tf + ${BM25_K1} * (1 - ${BM25_B} + ${BM25_B} * m.len / s.avglen))) AS score,
            array_agg(m.lexeme ORDER BY m.lexeme) AS matched
     FROM matched m JOIN df d USING (lexeme) CROSS JOIN corpus s
     GROUP BY m.id
     ORDER BY score DESC
     LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => ({ id: r.id, score: Number(r.score), matched: r.matched }));
}

const EXHIBIT_REF = /\b(table|chart|graph|figure|endnote|footnote|note)\s*(\d+)?\b/gi;

/**
 * Direct lookups the embedding can't do reliably: "table 3" -> that table and its rows, "the chart" -> the chart,
 * "endnote 14" / "footnote 14" -> that endnote.
 */
export async function exhibitSearch(query: string, filters?: SearchFilters): Promise<RankedId[]> {
  const ids: RankedId[] = [];
  for (const m of query.matchAll(EXHIBIT_REF)) {
    const kind = m[1]!.toLowerCase();
    const num = m[2];
    const params: unknown[] = [];
    const where = filterSql(filters, params);
    if (/note/.test(kind)) {
      if (!num) continue;
      params.push(Number(num));
      where.push(`c.type = 'endnote' AND $${params.length} = ANY(c.endnotes)`);
    } else if (kind === "table") {
      if (!num) continue;
      params.push(`table-${num}`);
      where.push(`c.exhibit = $${params.length}`);
    } else {
      params.push(num ? `chart-${num}` : "chart-%");
      where.push(`c.type = 'chart' AND c.exhibit LIKE $${params.length}`);
    }
    // The whole table first, then its rows in order.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT c.id::text AS id FROM chunks c WHERE ${where.join(" AND ")} ORDER BY (c.type = 'table_row'), c.ordinal LIMIT 10`,
      params,
    );
    ids.push(...rows.map((r) => ({ id: r.id, score: 1 })));
  }
  return ids;
}
