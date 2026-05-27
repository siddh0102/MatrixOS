CREATE TABLE IF NOT EXISTS skills (
  id                 TEXT PRIMARY KEY NOT NULL,
  source_template_id TEXT,
  source_version     TEXT,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  category           TEXT NOT NULL DEFAULT 'general',
  prompt             TEXT NOT NULL,
  tags_json          TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
