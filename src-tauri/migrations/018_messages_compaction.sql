-- Migration 018: conversation compaction.
--
-- Once a conversation exceeds ~80% of the model's context window, older
-- turns are folded into a summary so the conversation can keep going
-- without overflowing. We persist this state on `messages` directly:
--
--   is_summary    1 on the synthetic system-role row holding the active
--                 summary text. There is at most one such row per
--                 conversation at any time.
--
--   compacted_at  Set on original user/assistant rows that have been
--                 folded into the active summary. They remain on disk
--                 (the chat UI still shows them, grayed out) but the
--                 LLM no longer sees them — `getMessages` filters them.
--
-- messages is NOT in the append-only triggers list (migration 012), so
-- ALTER + UPDATE on these columns is allowed.

ALTER TABLE messages ADD COLUMN is_summary INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN compacted_at TEXT;

-- Hot path: building the LLM history filters messages by conversation_id
-- AND (compacted_at IS NULL) AND (is_summary = 0). The active summary
-- lookup is conversation_id AND is_summary = 1. This composite index
-- serves both with conversation_id as the leading column.
CREATE INDEX IF NOT EXISTS idx_messages_compaction
  ON messages(conversation_id, is_summary, compacted_at);
