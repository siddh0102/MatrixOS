CREATE TABLE IF NOT EXISTS agent_processes (
  id                    TEXT PRIMARY KEY NOT NULL,
  agent_id              TEXT NOT NULL,
  conversation_id       TEXT NOT NULL,
  priority              TEXT NOT NULL CHECK(priority IN ('interactive', 'background', 'scheduled')),
  status                TEXT NOT NULL CHECK(status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  queue_position        INTEGER,
  token_budget_json     TEXT NOT NULL DEFAULT '{}',
  token_usage_json      TEXT NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0}',
  started_at            TEXT,
  completed_at          TEXT,
  error                 TEXT,
  parent_workflow_run_id TEXT,
  parent_step_id        TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_processes_status ON agent_processes(status);
CREATE INDEX IF NOT EXISTS idx_processes_priority ON agent_processes(priority, status);
CREATE INDEX IF NOT EXISTS idx_processes_agent ON agent_processes(agent_id);

CREATE TABLE IF NOT EXISTS daily_token_usage (
  agent_id      TEXT NOT NULL,
  date          TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, date)
);
