CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id                      TEXT PRIMARY KEY NOT NULL,
  agent_id                TEXT NOT NULL,
  cron_expression         TEXT NOT NULL,
  timezone                TEXT NOT NULL DEFAULT 'UTC',
  enabled                 INTEGER NOT NULL DEFAULT 1,
  prompt                  TEXT NOT NULL,
  target_conversation_id  TEXT,
  last_run_at             TEXT,
  next_run_at             TEXT,
  last_run_status         TEXT CHECK(last_run_status IN ('success', 'error', 'running')),
  last_error              TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_agent ON scheduled_jobs(agent_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run ON scheduled_jobs(next_run_at);

CREATE TABLE IF NOT EXISTS schedule_run_history (
  id                TEXT PRIMARY KEY NOT NULL,
  job_id            TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  message_id        TEXT,
  status            TEXT NOT NULL CHECK(status IN ('success', 'error')),
  error             TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT NOT NULL,
  completed_at      TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES scheduled_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_schedule_runs_job ON schedule_run_history(job_id);
