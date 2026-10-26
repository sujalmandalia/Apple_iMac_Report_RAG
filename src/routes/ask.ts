import { Router } from "express";
import { z } from "zod";
import { answer, answerStream } from "../answer/answer.js";
import { httpError } from "../middleware/errorHandler.js";
import { QuotaExhaustedError } from "../services/gemini.js";
import { RERANKERS, type RerankerName } from "../search/rerank.js";

const AskBody = z.object({
  question: z.string().trim().min(3).max(1000),
  stream: z.boolean().default(false),
  k: z.number().int().min(1).max(12).optional(),
  rerank: z.enum(RERANKERS as [RerankerName, ...RerankerName[]]).optional(),
});

export const askRouter = Router();

askRouter.post("/ask", async (req, res) => {
  const parsed = AskBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const { question, stream, k, rerank } = parsed.data;

  if (!stream) {
    try {
      res.json(await answer(question, { k, reranker: rerank }));
    } catch (err) {
      if (err instanceof QuotaExhaustedError) throw httpError(503, err.message);
      throw err;
    }
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let closed = false;
  // req "close" fires once the body is read; the response's "close" is what signals a disconnected client.
  res.on("close", () => (closed = true));
  try {
    for await (const event of answerStream(question, { k, reranker: rerank })) {
      if (closed) break;
      send(event.type, event);
    }
  } catch (err) {
    console.error(err);
    send("error", { message: err instanceof QuotaExhaustedError ? err.message : "Answer generation failed. Please try again." });
  }
  res.end();
});
