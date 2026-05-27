CREATE TABLE IF NOT EXISTS agent_templates (
  id                          TEXT PRIMARY KEY NOT NULL,
  name                        TEXT NOT NULL,
  description                 TEXT NOT NULL DEFAULT '',
  category                    TEXT NOT NULL,
  system_prompt               TEXT NOT NULL,
  temperature                 REAL NOT NULL DEFAULT 0.7,
  max_tokens                  INTEGER NOT NULL DEFAULT 4096,
  max_conversation_history    INTEGER NOT NULL DEFAULT 50,
  icon                        TEXT NOT NULL,
  tags_json                   TEXT NOT NULL DEFAULT '[]',
  author                      TEXT NOT NULL,
  version                     TEXT NOT NULL DEFAULT '1.0',
  suggested_skill_ids_json    TEXT NOT NULL DEFAULT '[]',
  sort_order                  INTEGER NOT NULL DEFAULT 0,
  origin                      TEXT NOT NULL DEFAULT 'bundled' CHECK(origin IN ('bundled', 'user', 'imported')),
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_templates_category ON agent_templates(category);
CREATE INDEX IF NOT EXISTS idx_agent_templates_origin   ON agent_templates(origin);
CREATE INDEX IF NOT EXISTS idx_agent_templates_sort     ON agent_templates(sort_order);
