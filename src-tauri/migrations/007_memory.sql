-- Episodic memory: embedded conversation turns
CREATE TABLE IF NOT EXISTS episodic_memories (
  id                   TEXT PRIMARY KEY NOT NULL,
  conversation_id      TEXT NOT NULL,
  agent_id             TEXT NOT NULL,
  user_message_id      TEXT NOT NULL,
  assistant_message_id TEXT NOT NULL,
  summary              TEXT NOT NULL,
  pinned               INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_episodic_agent ON episodic_memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_episodic_conversation ON episodic_memories(conversation_id);
CREATE INDEX IF NOT EXISTS idx_episodic_pinned ON episodic_memories(pinned) WHERE pinned = 1;

-- Knowledge documents: imported files metadata
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id                    TEXT PRIMARY KEY NOT NULL,
  name                  TEXT NOT NULL,
  file_type             TEXT NOT NULL CHECK(file_type IN ('pdf', 'markdown', 'code', 'text')),
  file_path             TEXT,
  total_chunks          INTEGER NOT NULL DEFAULT 0,
  total_tokens_estimate INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Document chunks: individual text segments for RAG
CREATE TABLE IF NOT EXISTS document_chunks (
  id              TEXT PRIMARY KEY NOT NULL,
  document_id     TEXT NOT NULL,
  chunk_index     INTEGER NOT NULL,
  text            TEXT NOT NULL,
  token_estimate  INTEGER NOT NULL DEFAULT 0,
  pinned          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_pinned ON document_chunks(pinned) WHERE pinned = 1;

-- Procedural memory: reusable prompt templates
CREATE TABLE IF NOT EXISTS procedural_templates (
  id           TEXT PRIMARY KEY NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'general',
  content      TEXT NOT NULL,
  tags_json    TEXT NOT NULL DEFAULT '[]',
  usage_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_procedural_category ON procedural_templates(category);

-- Embedding configuration (singleton row)
CREATE TABLE IF NOT EXISTS embedding_config (
  id         TEXT PRIMARY KEY NOT NULL DEFAULT 'default',
  provider   TEXT NOT NULL DEFAULT 'local',
  model      TEXT NOT NULL DEFAULT 'Xenova/all-MiniLM-L6-v2',
  dimensions INTEGER NOT NULL DEFAULT 384,
  base_url   TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO embedding_config (id) VALUES ('default');
