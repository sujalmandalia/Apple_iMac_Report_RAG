import { resolve } from "node:path";
import express from "express";
import { healthRouter } from "./routes/health.js";
import { searchRouter } from "./routes/search.js";
import { askRouter } from "./routes/ask.js";
import { chatRouter } from "./routes/chat.js";
import { exhibitsRouter } from "./routes/exhibits.js";
import { config } from "./config.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLog } from "./middleware/requestLog.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestLog);
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(resolve("public")));

  const limiter = rateLimit({ windowMs: 60_000, max: config.rateLimitPerMinute });
  app.post(["/ask", "/chat"], limiter);

  app.use(healthRouter);
  app.use(searchRouter);
  app.use(askRouter);
  app.use(chatRouter);
  app.use(exhibitsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);

  return app;
}
