import { pool, withTransaction } from "../db/pool.js";
import { embedQuery, toSqlVector } from "../services/embeddings.js";
import type { ChunkType } from "../chunking/types.js";

export interface SearchFilters {
  types?: ChunkType[];
  /** Top-level section title, case-insensitive substring ("carbon footprint"). */
  section?: string;
  /** Only chunks that name this product configuration ("four ports"). */
  variant?: string;
}

export interface SearchOptions {
  k: number;
  filters?: SearchFilters;
  withParent?: boolean;
}

export interface SearchHit {
  id: string;
  key: string;
  type: ChunkType;
  similarity: number;
  sectionPath: string[];
  exhibit: string | null;
  endnotes: number[];
  variants: string[];
  pdfPages: number[];
  context: string;
  text: string;
  parent: { key: string; kind: string; text: string; tokens: number; pdfPages: number[] } | null;
}

const QUERY_CACHE_SIZE = 500;
const queryCache = new Map<string, number[]>();

export const queryCacheEntries = () => [...queryCache];

export function primeQueryCache(entries: [string, number[]][]) {
  for (const [key, vector] of entries) queryCache.set(key, vector);
}

export async function cachedQueryEmbedding(query: string): Promise<number[]> {
  const key = query.trim().toLowerCase().replace(/\s+/g, " ");
  const hit = queryCache.get(key);
  if (hit) {
    queryCache.delete(key);
    queryCache.set(key, hit);
    return hit;
  }
  const vector = await embedQuery(query);
  queryCache.set(key, vector);
  if (queryCache.size > QUERY_CACHE_SIZE) queryCache.delete(queryCache.keys().next().value!);
  return vector;
}

export function filterSql(filters: SearchFilters | undefined, params: unknown[]): string[] {
  const where = ["c.embedding IS NOT NULL"];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (filters?.types?.length) add("c.type = ANY(?::text[])", filters.types);
  if (filters?.section) add("c.section_path[1] ILIKE ?", `%${filters.section}%`);
  if (filters?.variant) add("EXISTS (SELECT 1 FROM unnest(c.variants) v WHERE v ILIKE ?)", `%${filters.variant}%`);
  return where;
}

const HIT_COLUMNS = `c.id, c.key, c.type, 1 - (c.embedding <=> $1::vector) AS similarity,
       c.section_path, c.exhibit, c.endnotes, c.variants, c.pdf_pages, c.context, c.text,
       p.key AS parent_key, p.kind AS parent_kind, p.text AS parent_text, p.tokens AS parent_tokens, p.pdf_pages AS parent_pages`;

function toHit(r: Record<string, any>, withParent = false): SearchHit {
  return {
    id: String(r.id),
    key: r.key,
    type: r.type,
    similarity: Number(Number(r.similarity).toFixed(4)),
    sectionPath: r.section_path,
    exhibit: r.exhibit,
    endnotes: r.endnotes,
    variants: r.variants,
    pdfPages: r.pdf_pages,
    context: r.context,
    text: r.text,
    parent:
      withParent && r.parent_key
        ? { key: r.parent_key, kind: r.parent_kind, text: r.parent_text, tokens: r.parent_tokens, pdfPages: r.parent_pages }
        : null,
  };
}

export async function vectorSearch(query: string, opts: SearchOptions): Promise<SearchHit[]> {
  const params: unknown[] = [toSqlVector(await cachedQueryEmbedding(query)), opts.k];
  const where = filterSql(opts.filters, params);

  return withTransaction(async (client) => {
    // HNSW filters after the graph walk; without iterative scans a selective filter can return fewer than k rows.
    await client.query("SET LOCAL hnsw.ef_search = 100");
    await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");

    const { rows } = await client.query(
      `SELECT ${HIT_COLUMNS}
       FROM chunks c
       LEFT JOIN parents p ON p.id = c.parent_id
       WHERE ${where.join(" AND ")}
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      params,
    );
    return rows.map((r) => toHit(r, opts.withParent));
  });
}

export async function fetchHits(ids: string[], query: string, withParent = false): Promise<Map<string, SearchHit>> {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT ${HIT_COLUMNS}
     FROM chunks c
     LEFT JOIN parents p ON p.id = c.parent_id
     WHERE c.id = ANY($2::bigint[])`,
    [toSqlVector(await cachedQueryEmbedding(query)), ids],
  );
  return new Map(rows.map((r) => [String(r.id), toHit(r, withParent)]));
}

/** "[Carbon Footprint, p. 10]", "[Table, p. 12]", "[Chart, p. 2]", "[Endnote 14, p. 11]". */
export function citationOf(hit: Pick<SearchHit, "sectionPath" | "pdfPages" | "type" | "endnotes">): string {
  const where =
    hit.type === "endnote"
      ? `Endnote ${hit.endnotes[0]}`
      : hit.type === "table" || hit.type === "table_row"
        ? "Table"
        : hit.type === "chart"
          ? "Chart"
          : hit.sectionPath[0];
  const pages = hit.pdfPages.length > 1 ? `pp. ${hit.pdfPages[0]}-${hit.pdfPages.at(-1)}` : `p. ${hit.pdfPages[0]}`;
  return `[${where}, ${pages}]`;
}
