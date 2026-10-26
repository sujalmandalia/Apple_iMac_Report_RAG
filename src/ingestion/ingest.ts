import { createHash } from "node:crypto";
import type pg from "pg";
import type { Chart } from "../charts/types.js";
import { embeddingText, estimateTokens } from "../chunking/chunk.js";
import type { ChunkSet } from "../chunking/types.js";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { embedTexts, toSqlVector, type TokenRateLimiter } from "../services/embeddings.js";
import type { DocumentStructure } from "../structure/types.js";
import type { Table } from "../tables/types.js";

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export interface SyncInput {
  source: string;
  fileHash: string;
  structure: DocumentStructure;
  chunkSet: ChunkSet;
  tables: Table[];
  charts: Chart[];
}

export interface SyncResult {
  documentId: number;
  inserted: number;
  kept: number;
  deleted: number;
  duplicates: number;
  modelChanged: boolean;
  endnotes: number;
  exhibits: number;
}

async function assertVectorColumn(client: pg.PoolClient) {
  const { rows } = await client.query<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`,
  );
  const dims = rows[0]?.dims;
  if (dims !== config.gemini.embeddingDimensions) {
    throw new Error(`chunks.embedding is vector(${dims}) but EMBEDDING_DIMENSIONS=${config.gemini.embeddingDimensions}.`);
  }
}

const isoDate = (text: string | null) => {
  const parsed = text ? new Date(`${text} UTC`) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
};

/**
 * Makes the database match the chunk set in one transaction. Chunks are keyed by the hash of their embedding text,
 * so unchanged chunks keep their vectors and only new or edited ones are embedded afterwards.
 */
export async function syncDocument(input: SyncInput): Promise<SyncResult> {
  const { embeddingModel, embeddingDimensions } = config.gemini;
  const { structure, chunkSet } = input;

  const seen = new Set<string>();
  let duplicates = 0;
  const rows = chunkSet.chunks.flatMap((c, ordinal) => {
    const content_hash = sha256(embeddingText(c));
    if (seen.has(content_hash)) {
      duplicates++;
      return [];
    }
    seen.add(content_hash);
    return [{
      content_hash,
      key: c.id,
      ordinal,
      parent_key: c.parentId,
      type: c.type,
      section_path: c.sectionPath,
      exhibit: c.exhibit,
      endnotes: c.endnotes,
      variants: c.variants,
      pdf_pages: c.pdfPages,
      context: c.context,
      text: c.text,
      tokens: c.tokens,
    }];
  });
  const parents = chunkSet.parents.map((p) => ({
    key: p.id,
    kind: p.kind,
    section_path: p.sectionPath,
    pdf_pages: p.pdfPages,
    text: p.text,
    tokens: p.tokens,
  }));
  const endnotes = structure.endnotes.map((e) => ({ num: e.num, pdf_page: e.pdfPage, text: e.text, used_by: e.usedBy }));
  const exhibits = [
    ...input.tables.map((t) => ({ key: t.id, kind: "table", title: t.title, pdf_page: t.pdfPage, verified: t.checks.every((c) => c.ok), data: t })),
    ...input.charts.map((c) => ({ key: c.id, kind: "chart", title: c.title, pdf_page: c.pdfPage, verified: c.verified, data: c })),
  ];

  return withTransaction(async (client) => {
    await assertVectorColumn(client);

    const previous = await client.query<{ embedding_model: string | null; embedding_dims: number | null }>(
      `SELECT embedding_model, embedding_dims FROM documents WHERE source = $1`,
      [input.source],
    );
    const old = previous.rows[0];
    const modelChanged = !!old?.embedding_model && (old.embedding_model !== embeddingModel || old.embedding_dims !== embeddingDimensions);

    const doc = await client.query<{ id: number }>(
      `INSERT INTO documents (source, file_hash, title, product, report_date, page_count, glossary, chunk_options, embedding_model, embedding_dims)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (source) DO UPDATE SET
         file_hash = EXCLUDED.file_hash, title = EXCLUDED.title, product = EXCLUDED.product, report_date = EXCLUDED.report_date,
         page_count = EXCLUDED.page_count, glossary = EXCLUDED.glossary, chunk_options = EXCLUDED.chunk_options,
         embedding_model = EXCLUDED.embedding_model, embedding_dims = EXCLUDED.embedding_dims, updated_at = now()
       RETURNING id`,
      [
        input.source,
        input.fileHash,
        structure.meta.title,
        structure.meta.product,
        isoDate(structure.meta.dateIntroduced),
        structure.meta.pageCount,
        structure.glossary,
        chunkSet.options,
        embeddingModel,
        embeddingDimensions,
      ],
    );
    const documentId = doc.rows[0]!.id;

    if (modelChanged) {
      await client.query(`UPDATE chunks SET embedding = NULL, embedded_at = NULL WHERE document_id = $1`, [documentId]);
    }

    await client.query(`DELETE FROM parents WHERE document_id = $1`, [documentId]);
    await client.query(
      `INSERT INTO parents (document_id, key, kind, section_path, pdf_pages, text, tokens)
       SELECT $1, x.key, x.kind, x.section_path, x.pdf_pages, x.text, x.tokens
       FROM jsonb_to_recordset($2) AS x(key text, kind text, section_path text[], pdf_pages int[], text text, tokens int)`,
      [documentId, JSON.stringify(parents)],
    );

    const deleted = await client.query(
      `DELETE FROM chunks WHERE document_id = $1 AND NOT (content_hash = ANY($2::text[]))`,
      [documentId, [...seen]],
    );

    // xmax = 0 only for freshly inserted rows, which separates inserts from conflict updates.
    const upserted = await client.query<{ inserted: boolean }>(
      `INSERT INTO chunks (document_id, content_hash, key, ordinal, parent_id, type, section_path, exhibit, endnotes, variants,
                           pdf_pages, context, text, tokens)
       SELECT $1, x.content_hash, x.key, x.ordinal, p.id, x.type, x.section_path, x.exhibit, x.endnotes, x.variants,
              x.pdf_pages, x.context, x.text, x.tokens
       FROM jsonb_to_recordset($2) AS x(content_hash text, key text, ordinal int, parent_key text, type text, section_path text[],
                                       exhibit text, endnotes int[], variants text[], pdf_pages int[], context text, text text, tokens int)
       LEFT JOIN parents p ON p.document_id = $1 AND p.key = x.parent_key
       ON CONFLICT (document_id, content_hash) DO UPDATE SET
         key = EXCLUDED.key, ordinal = EXCLUDED.ordinal, parent_id = EXCLUDED.parent_id, type = EXCLUDED.type,
         section_path = EXCLUDED.section_path, exhibit = EXCLUDED.exhibit, endnotes = EXCLUDED.endnotes,
         variants = EXCLUDED.variants, pdf_pages = EXCLUDED.pdf_pages, tokens = EXCLUDED.tokens
       RETURNING (xmax = 0) AS inserted`,
      [documentId, JSON.stringify(rows)],
    );
    const inserted = upserted.rows.filter((r) => r.inserted).length;

    await client.query(`DELETE FROM endnotes WHERE document_id = $1`, [documentId]);
    await client.query(
      `INSERT INTO endnotes (document_id, num, pdf_page, text, used_by)
       SELECT $1, x.num, x.pdf_page, x.text, x.used_by
       FROM jsonb_to_recordset($2) AS x(num int, pdf_page int, text text, used_by jsonb)`,
      [documentId, JSON.stringify(endnotes)],
    );

    await client.query(`DELETE FROM exhibits WHERE document_id = $1`, [documentId]);
    await client.query(
      `INSERT INTO exhibits (document_id, key, kind, title, pdf_page, verified, data)
       SELECT $1, x.key, x.kind, x.title, x.pdf_page, x.verified, x.data
       FROM jsonb_to_recordset($2) AS x(key text, kind text, title text, pdf_page int, verified boolean, data jsonb)`,
      [documentId, JSON.stringify(exhibits)],
    );

    return {
      documentId,
      inserted,
      kept: upserted.rows.length - inserted,
      deleted: deleted.rowCount ?? 0,
      duplicates,
      modelChanged,
      endnotes: endnotes.length,
      exhibits: exhibits.length,
    };
  });
}

export interface EmbedOptions {
  batchSize: number;
  maxBatchTokens: number;
  maxBatches: number;
  limiter: TokenRateLimiter;
}

export async function pendingCount(documentId: number): Promise<{ total: number; pending: number }> {
  const { rows } = await pool.query<{ total: number; pending: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE embedding IS NULL)::int AS pending
     FROM chunks WHERE document_id = $1`,
    [documentId],
  );
  return rows[0]!;
}

/** Embeds pending chunks in batches; each batch is committed, so an interrupted run resumes where it stopped. */
export async function embedPending(documentId: number, opts: EmbedOptions): Promise<number> {
  let embedded = 0;
  for (let batch = 1; batch <= opts.maxBatches; batch++) {
    const { rows } = await pool.query<{ id: string; context: string; text: string }>(
      `SELECT id, context, text FROM chunks
       WHERE document_id = $1 AND embedding IS NULL
       ORDER BY ordinal LIMIT $2`,
      [documentId, opts.batchSize],
    );
    if (!rows.length) break;

    const texts: string[] = [];
    let tokens = 0;
    for (const row of rows) {
      const text = embeddingText(row);
      const n = estimateTokens(text);
      if (texts.length && tokens + n > opts.maxBatchTokens) break;
      texts.push(text);
      tokens += n;
    }
    const ids = rows.slice(0, texts.length).map((r) => r.id);

    await opts.limiter.take(tokens);
    const started = Date.now();
    const vectors = await embedTexts(texts, "RETRIEVAL_DOCUMENT");

    await pool.query(
      `UPDATE chunks c SET embedding = v.embedding::vector, embedded_at = now()
       FROM unnest($1::bigint[], $2::text[]) AS v(id, embedding)
       WHERE c.id = v.id`,
      [ids, vectors.map(toSqlVector)],
    );
    embedded += ids.length;

    const { total, pending } = await pendingCount(documentId);
    console.log(
      `  batch ${batch}: ${ids.length} chunks, ~${tokens} tokens, ${Date.now() - started}ms -> ${total - pending}/${total} embedded`,
    );
  }
  return embedded;
}
