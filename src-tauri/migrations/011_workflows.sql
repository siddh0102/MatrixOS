CREATE TABLE IF NOT EXISTS workflows (
  id              TEXT PRIMARY KEY NOT NULL,
  definition_json TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                TEXT PRIMARY KEY NOT NULL,
  workflow_id       TEXT NOT NULL,
  workflow_version  INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  triggered_by      TEXT NOT NULL CHECK(triggered_by IN ('manual', 'event', 'scheduled', 'sub_workflow')),
  variables_json    TEXT NOT NULL DEFAULT '{}',
  step_results_json TEXT NOT NULL DEFAULT '{}',
  started_at        TEXT NOT NULL,
  completed_at      TEXT,
  error             TEXT,
  duration_ms       INTEGER,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_started ON workflow_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_human_inputs (
  id              TEXT PRIMARY KEY NOT NULL,
  run_id          TEXT NOT NULL,
  step_id         TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  input_type      TEXT NOT NULL CHECK(input_type IN ('text', 'choice', 'confirm')),
  choices_json    TEXT,
  response        TEXT,
  responded_at    TEXT,
  timeout_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_human_inputs_run ON workflow_human_inputs(run_id);
CREATE INDEX IF NOT EXISTS idx_human_inputs_pending ON workflow_human_inputs(responded_at) WHERE responded_at IS NULL;

CREATE TABLE IF NOT EXISTS workflow_conversations (
  conversation_id TEXT PRIMARY KEY NOT NULL,
  workflow_run_id TEXT NOT NULL,
  step_id         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
