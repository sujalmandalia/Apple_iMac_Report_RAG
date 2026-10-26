import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";

const server = createApp().listen(config.port, () => {
  console.log(`imac-rag listening on http://localhost:${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}
