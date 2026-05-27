import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import type { Conversation, Message, MessageContent } from "@/types";
import { isoNow } from "@/lib/utils";

// ── Conversations ──

export async function createConversation(
  conv: Conversation,
): Promise<void> {
  await dbExecute(
    `INSERT INTO conversations (id, agent_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [conv.id, conv.agentId, conv.title, conv.createdAt, conv.updatedAt],
  );
}

export async function getConversation(
  id: string,
): Promise<Conversation | null> {
  const rows = await dbSelect<ConversationRow>(
    `SELECT * FROM conversations WHERE id = ?`,
    [id],
  );
  return rows[0] ? rowToConversation(rows[0]) : null;
}

export async function listConversations(
  agentId: string,
): Promise<Conversation[]> {
  const rows = await dbSelect<ConversationRow>(
    `SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC`,
    [agentId],
  );
  return rows.map(rowToConversation);
}

export async function updateConversationTitle(
  id: string,
  title: string,
): Promise<void> {
  await dbExecute(
    `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
    [title, isoNow(), id],
  );
}

export async function deleteConversation(id: string): Promise<void> {
  await dbExecute(`DELETE FROM conversations WHERE id = ?`, [id]);
}

// ── Messages ──

export async function saveMessage(message: Message): Promise<void> {
  await dbExecute(
    `INSERT INTO messages (id, conversation_id, role, content_json, token_count, model, telemetry_id, sources_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.id,
      message.conversationId,
      message.role,
      JSON.stringify(message.content),
      message.tokenCount,
      message.model,
      message.telemetryId ?? null,
      message.sources && message.sources.length > 0
        ? JSON.stringify(message.sources)
        : null,
      message.createdAt,
    ],
  );
  await dbExecute(
    `UPDATE conversations SET updated_at = ? WHERE id = ?`,
    [isoNow(), message.conversationId],
  );
}

/**
 * Returns the messages that are LIVE for the LLM in this conversation:
 * excludes both compacted originals and synthetic summary rows. The
 * caller should fetch the active summary separately via
 * `getActiveSummary` and inject it into the system prompt.
 */
export async function getMessages(
  conversationId: string,
): Promise<Message[]> {
  const rows = await dbSelect<MessageRow>(
    `SELECT * FROM messages
       WHERE conversation_id = ?
         AND compacted_at IS NULL
         AND is_summary = 0
       ORDER BY created_at ASC`,
    [conversationId],
  );
  return rows.map(rowToMessage);
}

/**
 * Returns EVERY message in the conversation including compacted-out
 * originals and the active summary row. For the chat UI, which needs to
 * render the full history with the compaction divider in place. Do NOT
 * use this for building LLM prompts.
 */
export async function getMessagesForChat(
  conversationId: string,
): Promise<Message[]> {
  const rows = await dbSelect<MessageRow>(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    [conversationId],
  );
  return rows.map(rowToMessage);
}

/**
 * Returns the active compaction summary's text and message id, or null
 * if this conversation has never been compacted (or had its summary
 * cleared). At most one active summary exists per conversation at any
 * time.
 */
export async function getActiveSummary(
  conversationId: string,
): Promise<{ id: string; text: string; createdAt: string } | null> {
  const rows = await dbSelect<MessageRow>(
    `SELECT * FROM messages
       WHERE conversation_id = ?
         AND is_summary = 1
         AND compacted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    [conversationId],
  );
  if (rows.length === 0) return null;
  const m = rowToMessage(rows[0]);
  const text = m.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { id: m.id, text, createdAt: m.createdAt };
}

/**
 * Mark a set of original messages as folded into a summary, plus delete
 * any prior active summary row (only one summary alive at a time), plus
 * insert the new summary. Runs as a sequence of dbExecute calls — the
 * Tauri sql plugin wraps each in its own transaction; full atomicity
 * across all three would require a single multi-statement transaction.
 * For our purposes (one user, one process) the worst case of a partial
 * commit is an over-summarized conversation, not a corrupted one.
 */
export async function applyCompaction(
  conversationId: string,
  compactedMessageIds: string[],
  newSummaryMessage: Message,
): Promise<void> {
  const now = isoNow();
  // Clear the previous active summary (if any). We DELETE rather than
  // mark-compacted so we don't accumulate stale summary rows across
  // multiple compactions — only one active per conversation, ever.
  await dbExecute(
    `DELETE FROM messages
       WHERE conversation_id = ?
         AND is_summary = 1`,
    [conversationId],
  );
  // Mark the original turns as compacted. They survive on disk so the
  // chat UI can still show them grayed out, but are filtered from
  // `getMessages` (the LLM view).
  if (compactedMessageIds.length > 0) {
    const placeholders = compactedMessageIds.map(() => "?").join(",");
    await dbExecute(
      `UPDATE messages SET compacted_at = ?
         WHERE id IN (${placeholders}) AND conversation_id = ?`,
      [now, ...compactedMessageIds, conversationId],
    );
  }
  // Insert the new active summary as a system-role row with is_summary=1.
  await dbExecute(
    `INSERT INTO messages
       (id, conversation_id, role, content_json, token_count, model,
        telemetry_id, sources_json, is_summary, compacted_at, created_at)
     VALUES (?, ?, 'system', ?, ?, NULL, NULL, ?, 1, NULL, ?)`,
    [
      newSummaryMessage.id,
      conversationId,
      JSON.stringify(newSummaryMessage.content),
      newSummaryMessage.tokenCount,
      newSummaryMessage.sources && newSummaryMessage.sources.length > 0
        ? JSON.stringify(newSummaryMessage.sources)
        : null,
      newSummaryMessage.createdAt,
    ],
  );
}

// ── Row types & mappers ──

interface ConversationRow {
  id: string;
  agent_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content_json: string;
  token_count: number | null;
  model: string | null;
  telemetry_id: string | null;
  sources_json: string | null;
  is_summary: number | null;
  compacted_at: string | null;
  created_at: string;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: MessageRow): Message {
  let sources: Message["sources"];
  if (row.sources_json) {
    try {
      sources = JSON.parse(row.sources_json) as NonNullable<Message["sources"]>;
    } catch {
      // Corrupted JSON — drop sources rather than failing the whole message.
      sources = undefined;
    }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as Message["role"],
    content: JSON.parse(row.content_json) as MessageContent[],
    tokenCount: row.token_count,
    model: row.model,
    telemetryId: row.telemetry_id ?? null,
    createdAt: row.created_at,
    sources,
    isSummary: row.is_summary === 1,
    compactedAt: row.compacted_at,
  };
}
