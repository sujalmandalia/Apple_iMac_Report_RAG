import { Router, type Response } from "express";
import { z } from "zod";
import { chatStream, ConversationNotFoundError, type ChatEvent } from "../chat/chat.js";
import { deleteConversation, getConversation, listConversations } from "../chat/store.js";
import { httpError } from "../middleware/errorHandler.js";
import { QuotaExhaustedError } from "../services/gemini.js";

const ChatBody = z.object({
  message: z.string().trim().min(1).max(1000),
  conversationId: z.uuid().optional(),
  stream: z.boolean().default(false),
});

export const chatRouter = Router();

const toHttpError = (err: unknown) => {
  if (err instanceof ConversationNotFoundError) return httpError(404, "Conversation not found");
  if (err instanceof QuotaExhaustedError) return httpError(503, err.message);
  return err;
};

async function streamChat(res: Response, events: AsyncGenerator<ChatEvent>) {
  let started = false;
  let closed = false;
  res.on("close", () => (closed = true));
  try {
    for await (const event of events) {
      if (!started) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        started = true;
      }
      if (closed) break;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    if (!started) throw toHttpError(err);
    console.error(err);
    const message = err instanceof QuotaExhaustedError ? err.message : "Answer generation failed. Please try again.";
    res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
  }
  res.end();
}

chatRouter.post("/chat", async (req, res) => {
  const parsed = ChatBody.safeParse(req.body);
  if (!parsed.success) throw httpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const { message, conversationId, stream } = parsed.data;
  const events = chatStream(message, conversationId);

  if (stream) return streamChat(res, events);

  const result: Record<string, unknown> = {};
  try {
    for await (const event of events) {
      if (event.type === "conversation") Object.assign(result, event);
      if (event.type === "sources") Object.assign(result, { route: event.route, answerable: event.answerable, sources: event.sources });
      if (event.type === "done") Object.assign(result, event);
    }
  } catch (err) {
    throw toHttpError(err);
  }
  delete result.type;
  res.json(result);
});

chatRouter.get("/conversations", async (_req, res) => {
  res.json(await listConversations());
});

chatRouter.get("/conversations/:id", async (req, res) => {
  const conversation = await getConversation(req.params.id);
  if (!conversation) throw httpError(404, "Conversation not found");
  res.json(conversation);
});

chatRouter.delete("/conversations/:id", async (req, res) => {
  if (!(await deleteConversation(req.params.id))) throw httpError(404, "Conversation not found");
  res.status(204).end();
});
