import { dbExecute, dbSelect } from "@/kernel/ipc-bridge";
import { vecUpsert, vecSearch, vecDelete, vecDeleteBatch } from "@/kernel/vector-bridge";
import { embedText } from "@/memory/embedding-service";
import { appendAudit } from "@/memory/audit-store";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import type { EpisodicEntry, EmbeddingConfig, VectorSearchResult } from "@/types";

interface EpisodicRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  user_message_id: string;
  assistant_message_id: string;
  summary: string;
  pinned: number;
  created_at: string;
}

function rowToEntry(row: EpisodicRow): EpisodicEntry {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    summary: row.summary,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
  };
}

export async function saveEpisodicEntry(
  conversationId: string,
  agentId: string,
  userMessageId: string,
  assistantMessageId: string,
  userText: string,
  assistantText: string,
  embeddingConfig: EmbeddingConfig,
  /** Pre-distilled summary (smart mode). Falls back to the raw transcript. */
  summaryOverride?: string,
): Promise<EpisodicEntry> {
  const id = nanoid();
  const summary = summaryOverride ?? `User: ${userText}\nAssistant: ${assistantText}`;
  const now = isoNow();

  // 1. Embed first — if this fails, no orphan metadata row is created
  let embedding: number[];
  try {
    embedding = await embedText(summary, embeddingConfig, "document");
  } catch (err) {
    throw new Error(`Episodic embedding failed: ${err}`);
  }

  // 2. Save metadata to main DB
  await dbExecute(
    `INSERT INTO episodic_memories
       (id, conversation_id, agent_id, user_message_id, assistant_message_id, summary, pinned, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [id, conversationId, agentId, userMessageId, assistantMessageId, summary, now],
  );

  // 3. Store vector — if this fails, cleanup the metadata row
  try {
    await vecUpsert(
      "vec_episodic",
      id,
      embedding,
      JSON.stringify({ type: "episodic", entryId: id }),
    );
  } catch (err) {
    await dbExecute("DELETE FROM episodic_memories WHERE id = ?", [id]).catch(() => {});
    throw new Error(`Episodic vector store failed: ${err}`);
  }

  appendAudit({
    eventType: "memory.episodic.created",
    actor: "system",
    targetType: "episodic_memory",
    targetId: id,
    details: { conversationId, agentId },
  }).catch(() => {});

  return {
    id,
    conversationId,
    agentId,
    userMessageId,
    assistantMessageId,
    summary,
    pinned: false,
    createdAt: now,
  };
}

export async function searchEpisodicMemories(
  query: string,
  agentId: string | null,
  config: EmbeddingConfig,
  limit: number,
  threshold: number,
): Promise<Array<{ entry: EpisodicEntry; score: number }>> {
  const queryEmbedding = await embedText(query, config, "query");
  const vecResults = await vecSearch("vec_episodic", queryEmbedding, limit * 2);

  const maxDistance = 1 - threshold;
  const filtered = vecResults.filter((r: VectorSearchResult) => r.distance <= maxDistance);
  if (filtered.length === 0) return [];

  const idToScore = new Map<string, number>();
  for (const vec of filtered) {
    const meta = JSON.parse(vec.metadata) as { entryId: string };
    idToScore.set(meta.entryId, 1 - vec.distance);
  }

  const ids = Array.from(idToScore.keys());
  const placeholders = ids.map(() => "?").join(",");
  const rows = await dbSelect<EpisodicRow>(
    `SELECT * FROM episodic_memories WHERE id IN (${placeholders})`,
    ids,
  );

  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const results: Array<{ entry: EpisodicEntry; score: number }> = [];
  for (const id of ids) {
    const row = rowMap.get(id);
    if (!row) continue;
    const entry = rowToEntry(row);
    if (agentId && entry.agentId !== agentId) continue;
    results.push({ entry, score: idToScore.get(id)! });
    if (results.length >= limit) break;
  }

  return results;
}

export async function listEpisodicByConversation(
  conversationId: string,
): Promise<EpisodicEntry[]> {
  const rows = await dbSelect<EpisodicRow>(
    "SELECT * FROM episodic_memories WHERE conversation_id = ? ORDER BY created_at ASC",
    [conversationId],
  );
  return rows.map(rowToEntry);
}

export async function getPinnedEpisodicEntries(
  agentId: string,
): Promise<EpisodicEntry[]> {
  const rows = await dbSelect<EpisodicRow>(
    "SELECT * FROM episodic_memories WHERE agent_id = ? AND pinned = 1 ORDER BY created_at ASC",
    [agentId],
  );
  return rows.map(rowToEntry);
}

export async function toggleEpisodicPin(id: string, pinned: boolean): Promise<void> {
  await dbExecute(
    "UPDATE episodic_memories SET pinned = ? WHERE id = ?",
    [pinned ? 1 : 0, id],
  );
}

export async function deleteEpisodicEntry(id: string): Promise<void> {
  await dbExecute("DELETE FROM episodic_memories WHERE id = ?", [id]);
  await vecDelete("vec_episodic", id);

  appendAudit({
    eventType: "memory.episodic.deleted",
    actor: "user",
    targetType: "episodic_memory",
    targetId: id,
    details: null,
  }).catch(() => {});
}

export async function deleteEpisodicByConversation(conversationId: string): Promise<void> {
  const rows = await dbSelect<{ id: string }>(
    "SELECT id FROM episodic_memories WHERE conversation_id = ?",
    [conversationId],
  );
  if (rows.length > 0) {
    await vecDeleteBatch("vec_episodic", rows.map((r) => r.id));
  }
  await dbExecute(
    "DELETE FROM episodic_memories WHERE conversation_id = ?",
    [conversationId],
  );
}

export async function pruneOldEpisodicEntries(maxAgeDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await dbSelect<{ id: string }>(
    "SELECT id FROM episodic_memories WHERE pinned = 0 AND created_at < ?",
    [cutoff],
  );
  if (rows.length > 0) {
    await vecDeleteBatch("vec_episodic", rows.map((r) => r.id));
  }
  const result = await dbExecute(
    "DELETE FROM episodic_memories WHERE pinned = 0 AND created_at < ?",
    [cutoff],
  );
  return result.rowsAffected;
}
