-- Migration 016: drop cascading FKs from telemetry tables so deleting an
-- agent no longer trips append-only triggers.
--
-- Before this migration, DELETE FROM agents cascaded:
--   agents → conversations (CASCADE) → llm_requests (CASCADE on conversation_id)
--     → blocked by `llm_requests_no_delete` trigger from migration 012
--   agents → scheduled_jobs (CASCADE) → schedule_run_history (CASCADE on job_id)
--     → blocked by `schedule_run_history_no_delete` trigger from migration 012
-- The agent_id FK on llm_requests was ON DELETE SET NULL, which also
-- attempted an UPDATE blocked by `llm_requests_no_update`.
--
-- Result: agents that had ever produced a chat turn or a scheduled run
-- could not be deleted.
--
-- Fix: telemetry rows now persist as snapshots when their parent row goes
-- away. The conversation_id / job_id / agent_id columns retain their
-- original values (now potentially dangling) — the right semantic for
-- audit-only data. Append-only triggers are reinstated on the new tables.

-- ---------- llm_requests ----------
CREATE TABLE llm_requests_new (
  id                TEXT PRIMARY KEY NOT NULL,
  conversation_id   TEXT NOT NULL,
  agent_id          TEXT,
  provider_id       TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  prompt_json       TEXT NOT NULL,
  response_text     TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  tool_rounds       INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success', 'error')),
  error_code        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO llm_requests_new
  SELECT id, conversation_id, agent_id, provider_id, model_id, prompt_json,
         response_text, input_tokens, output_tokens, tool_rounds, latency_ms,
         status, error_code, created_at
  FROM llm_requests;

DROP TABLE llm_requests;
ALTER TABLE llm_requests_new RENAME TO llm_requests;

CREATE INDEX IF NOT EXISTS idx_llm_requests_conversation ON llm_requests(conversation_id);
CREATE INDEX IF NOT EXISTS idx_llm_requests_agent ON llm_requests(agent_id);
CREATE INDEX IF NOT EXISTS idx_llm_requests_created ON llm_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_requests_status ON llm_requests(status);

CREATE TRIGGER IF NOT EXISTS llm_requests_no_update
  BEFORE UPDATE ON llm_requests
  BEGIN SELECT RAISE(ABORT, 'llm_requests is append-only'); END;
CREATE TRIGGER IF NOT EXISTS llm_requests_no_delete
  BEFORE DELETE ON llm_requests
  BEGIN SELECT RAISE(ABORT, 'llm_requests is append-only'); END;

-- ---------- schedule_run_history ----------
CREATE TABLE schedule_run_history_new (
  id                TEXT PRIMARY KEY NOT NULL,
  job_id            TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  message_id        TEXT,
  status            TEXT NOT NULL CHECK(status IN ('success', 'error')),
  error             TEXT,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT NOT NULL,
  completed_at      TEXT NOT NULL
);

INSERT INTO schedule_run_history_new
  SELECT id, job_id, conversation_id, message_id, status, error,
         input_tokens, output_tokens, started_at, completed_at
  FROM schedule_run_history;

DROP TABLE schedule_run_history;
ALTER TABLE schedule_run_history_new RENAME TO schedule_run_history;

CREATE INDEX IF NOT EXISTS idx_schedule_runs_job ON schedule_run_history(job_id);

CREATE TRIGGER IF NOT EXISTS schedule_run_history_no_update
  BEFORE UPDATE ON schedule_run_history
  BEGIN SELECT RAISE(ABORT, 'schedule_run_history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS schedule_run_history_no_delete
  BEFORE DELETE ON schedule_run_history
  BEGIN SELECT RAISE(ABORT, 'schedule_run_history is append-only'); END;
