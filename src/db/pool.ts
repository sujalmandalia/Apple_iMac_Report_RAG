import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

// Without a listener, an idle-client error crashes the process.
pool.on("error", (err) => {
  console.error("Idle Postgres client error:", err.message);
});

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
