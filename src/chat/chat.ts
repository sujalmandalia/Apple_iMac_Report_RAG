import { answerStream, type AnswerEvent, type AnswerOptions } from "../answer/answer.js";
import { conversationExists, createConversation, recentTurns, saveExchange } from "./store.js";
import { rewriteQuestion } from "./rewrite.js";

export const HISTORY_TURNS = 3;

const CHITCHAT_REPLY =
  "Happy to help. Ask me anything about Apple's iMac Product Environmental Report (October 2024), for example its carbon footprint, recycled materials, packaging, energy use or the assumptions in its endnotes.";

export type ChatEvent =
  | { type: "conversation"; conversationId: string; standaloneQuestion: string; rewritten: boolean; kind: "question" | "chitchat" }
  | AnswerEvent;

export class ConversationNotFoundError extends Error {}

export async function* chatStream(message: string, conversationId?: string, opts: AnswerOptions = {}): AsyncGenerator<ChatEvent> {
  if (conversationId && !(await conversationExists(conversationId))) throw new ConversationNotFoundError(conversationId);

  const history = conversationId ? await recentTurns(conversationId, HISTORY_TURNS) : [];
  const rewrite = await rewriteQuestion(history, message);
  const id = conversationId ?? (await createConversation(message));

  yield { type: "conversation", conversationId: id, standaloneQuestion: rewrite.question, rewritten: rewrite.rewritten, kind: rewrite.kind };

  if (rewrite.kind === "chitchat") {
    yield { type: "delta", text: CHITCHAT_REPLY };
    yield {
      type: "done",
      answer: CHITCHAT_REPLY,
      model: null,
      cited: [],
      invalidCitations: [],
      grounded: true,
      unverifiedNumbers: [],
      usage: { promptTokens: 0, outputTokens: 0, thoughtTokens: 0 },
      ms: 0,
    };
    await saveExchange(id, { content: message, standalone: rewrite.question }, { content: CHITCHAT_REPLY, route: null, sources: [], model: null });
    return;
  }

  let sources: Extract<AnswerEvent, { type: "sources" }> | undefined;
  for await (const event of answerStream(rewrite.question, opts)) {
    if (event.type === "sources") sources = event;
    yield event;
    if (event.type === "done") {
      await saveExchange(
        id,
        { content: message, standalone: rewrite.question },
        { content: event.answer, route: sources?.route ?? null, sources: sources?.sources ?? [], model: event.model },
      );
    }
  }
}
