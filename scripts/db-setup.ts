import { readFile } from "node:fs/promises";
import pg from "pg";
import { config } from "../src/config.js";

const target = new URL(config.databaseUrl);
const dbName = decodeURIComponent(target.pathname.slice(1));

// Identifiers can't be bound as $1 parameters, so validate instead.
if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) {
  throw new Error(`Refusing unusual database name "${dbName}". Use lowercase letters, digits and _.`);
}

async function createDatabaseIfMissing(): Promise<void> {
  const admin = new URL(config.databaseUrl);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (rowCount) {
      console.log(`database "${dbName}" already exists`);
    } else {
      await client.query(`CREATE DATABASE ${dbName}`);
      console.log(`created database "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

async function applySchemaAndVerify(): Promise<void> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const schema = await readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8");
    await client.query(schema);

    const { rows } = await client.query<{ pg: string; vector: string }>(
      `SELECT current_setting('server_version') AS pg,
              (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector`,
    );
    console.log(`postgres ${rows[0]?.pg}, pgvector ${rows[0]?.vector}`);

    const smoke = await client.query<{ distance: number }>(
      `SELECT '[1,0]'::vector <=> '[0,1]'::vector AS distance`,
    );
    console.log(`pgvector smoke test: cosine distance [1,0] <=> [0,1] = ${smoke.rows[0]?.distance} (expected 1)`);
  } finally {
    await client.end();
  }
}

await createDatabaseIfMissing();
await applySchemaAndVerify();
