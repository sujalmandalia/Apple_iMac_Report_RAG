import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Chart } from "../src/charts/types.js";
import type { ChunkSet } from "../src/chunking/types.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { embedPending, pendingCount, sha256, syncDocument } from "../src/ingestion/ingest.js";
import { TokenRateLimiter } from "../src/services/embeddings.js";
import type { DocumentStructure } from "../src/structure/types.js";
import type { Table } from "../src/tables/types.js";

const { values } = parseArgs({
  options: {
    "sync-only": { type: "boolean", default: false },
    "max-batches": { type: "string", default: "1000" },
    "batch-size": { type: "string", default: "50" },
    "batch-tokens": { type: "string", default: "12000" },
    tpm: { type: "string", default: "25000" },
    rpm: { type: "string", default: "60" },
  },
});

const read = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;
const chunkSet = await read<ChunkSet>("data/chunks.json");
const structure = await read<DocumentStructure>("data/structure.json");
const tables = await read<Table[]>("data/tables.json");
const charts = await read<Chart[]>("data/charts.json");
const fileHash = sha256(await readFile(config.reportPdf));

console.log(`Syncing ${chunkSet.chunks.length} chunks, ${chunkSet.parents.length} parents, ${structure.endnotes.length} endnotes, ${tables.length + charts.length} exhibits`);
const sync = await syncDocument({ source: config.reportPdf, fileHash, structure, chunkSet, tables, charts });
console.log(
  `  document ${sync.documentId}: ${sync.inserted} new, ${sync.kept} unchanged (embeddings kept), ${sync.deleted} removed` +
    (sync.duplicates ? `, ${sync.duplicates} duplicate chunks skipped` : "") +
    (sync.modelChanged ? ", embedding model changed so all vectors were cleared" : ""),
);
console.log(`  endnotes stored: ${sync.endnotes}, exhibits stored: ${sync.exhibits}`);

const before = await pendingCount(sync.documentId);
console.log(`  ${before.pending} of ${before.total} chunks need embeddings`);

if (!values["sync-only"] && before.pending > 0) {
  const { embeddingModel, embeddingDimensions } = config.gemini;
  console.log(`\nEmbedding with ${embeddingModel} @ ${embeddingDimensions} dims (limit ${values.tpm} tokens/min, ${values.rpm} req/min)`);
  await embedPending(sync.documentId, {
    batchSize: Number(values["batch-size"]),
    maxBatchTokens: Number(values["batch-tokens"]),
    maxBatches: Number(values["max-batches"]),
    limiter: new TokenRateLimiter(Number(values.tpm), Number(values.rpm)),
  });
}

const { rows } = await pool.query<{ type: string; n: number; embedded: number; min_norm: number; max_norm: number }>(
  `SELECT type, count(*)::int AS n, count(embedding)::int AS embedded,
          round(min(vector_norm(embedding))::numeric, 4)::float AS min_norm,
          round(max(vector_norm(embedding))::numeric, 4)::float AS max_norm
   FROM chunks WHERE document_id = $1 GROUP BY type ORDER BY n DESC`,
  [sync.documentId],
);
console.log("\nStored chunks:");
for (const r of rows) {
  console.log(`  ${r.type.padEnd(10)} ${String(r.embedded).padStart(3)}/${String(r.n).padEnd(3)} embedded   norm ${r.min_norm ?? "-"}..${r.max_norm ?? "-"}`);
}
const after = await pendingCount(sync.documentId);
console.log(after.pending ? `\n${after.pending} chunks still pending; rerun "npm run ingest" to resume.` : "\nAll chunks embedded.");

await pool.end();
