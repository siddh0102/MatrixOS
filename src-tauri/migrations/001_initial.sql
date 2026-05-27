-- MatrixOS Phase 1 Schema

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'general',
  config_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY NOT NULL,
  agent_id   TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT 'New Conversation',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_agent_id ON conversations(agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content_json    TEXT NOT NULL,
  token_count     INTEGER,
  model           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

CREATE TABLE IF NOT EXISTS provider_configs (
  id          TEXT PRIMARY KEY NOT NULL,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  base_url    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preferences (
  key        TEXT    NOT NULL,
  value_json TEXT    NOT NULL,
  agent_id   TEXT    NOT NULL DEFAULT '__global__',
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, agent_id)
);
