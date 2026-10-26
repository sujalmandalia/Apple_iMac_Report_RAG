import { pool } from "../db/pool.js";

export interface Turn {
  question: string;
  standalone: string | null;
  answer: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  standaloneQuestion: string | null;
  route: unknown;
  sources: unknown;
  model: string | null;
  createdAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function conversationExists(id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await pool.query(`SELECT 1 FROM conversations WHERE id = $1`, [id]);
  return !!rowCount;
}

export async function createConversation(firstMessage: string): Promise<string> {
  const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80);
  const { rows } = await pool.query<{ id: string }>(`INSERT INTO conversations (title) VALUES ($1) RETURNING id`, [title]);
  return rows[0]!.id;
}

export async function recentTurns(conversationId: string, turns: number): Promise<Turn[]> {
  const { rows } = await pool.query<{ role: string; content: string; standalone_question: string | null }>(
    `SELECT role, content, standalone_question FROM (
       SELECT id, role, content, standalone_question FROM messages
       WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2
     ) recent ORDER BY id`,
    [conversationId, turns * 2],
  );
  const result: Turn[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const next = rows[i + 1];
    if (row.role === "user" && next?.role === "assistant") {
      result.push({ question: row.content, standalone: row.standalone_question, answer: next.content });
      i++;
    }
  }
  return result;
}

export async function saveExchange(
  conversationId: string,
  user: { content: string; standalone: string },
  assistant: { content: string; route: unknown; sources: unknown; model: string | null },
) {
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content, standalone_question)
     VALUES ($1, 'user', $2, $3)`,
    [conversationId, user.content, user.standalone],
  );
  await pool.query(
    `INSERT INTO messages (conversation_id, role, content, route, sources, model)
     VALUES ($1, 'assistant', $2, $3, $4, $5)`,
    [conversationId, assistant.content, JSON.stringify(assistant.route), JSON.stringify(assistant.sources), assistant.model],
  );
  await pool.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
}

export async function getConversation(id: string) {
  if (!UUID.test(id)) return null;
  const conv = await pool.query(`SELECT id, title, created_at, updated_at FROM conversations WHERE id = $1`, [id]);
  if (!conv.rows[0]) return null;
  const { rows } = await pool.query(
    `SELECT id, role, content, standalone_question, route, sources, model, created_at
     FROM messages WHERE conversation_id = $1 ORDER BY id`,
    [id],
  );
  const messages: StoredMessage[] = rows.map((r) => ({
    id: String(r.id),
    role: r.role,
    content: r.content,
    standaloneQuestion: r.standalone_question,
    route: r.route,
    sources: r.sources,
    model: r.model,
    createdAt: r.created_at,
  }));
  return { ...conv.rows[0], messages };
}

export async function listConversations(limit = 50) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.updated_at, count(m.id)::int AS messages
     FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
     GROUP BY c.id ORDER BY c.updated_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function deleteConversation(id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await pool.query(`DELETE FROM conversations WHERE id = $1`, [id]);
  return !!rowCount;
}
