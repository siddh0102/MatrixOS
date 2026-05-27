-- Observability backbone. See docs/observability-lld.md.
-- All changes are ADDITIVE: ALTER ... ADD COLUMN (DDL, not intercepted by the
-- append-only UPDATE/DELETE triggers on llm_requests) and three new tables that
-- nothing existing reads. The existing per-turn llm_requests write is untouched,
-- so existing dashboard aggregates keep their meaning.

-- (A) Turn-level orchestration linkage on the existing per-turn row. Nullable;
-- populated TS-side (run/step/delegation context lives in TS). The chat path
-- leaves these NULL.
ALTER TABLE llm_requests ADD COLUMN run_id TEXT;
ALTER TABLE llm_requests ADD COLUMN step_id TEXT;
ALTER TABLE llm_requests ADD COLUMN parent_request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_llm_run ON llm_requests(run_id);

-- (B) Per-CALL detail. One llm_requests row already represents an entire
-- multi-round executeAgentTurn (aggregated tokens, tool_rounds count, first
-- prompt only). Per-round detail goes here instead of changing that write, so
-- existing semantics are preserved. request_id = the turn's llm_requests.id.
CREATE TABLE llm_calls (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL,
  turn_index    INTEGER NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  ttft_ms       INTEGER,
  latency_ms    INTEGER,
  finish_reason TEXT,
  response_text TEXT,
  prompt_json   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_request ON llm_calls(request_id);

-- (C) Full tool-call records. audit_log keeps only {toolCallId, serverId,
-- durationMs}; args/result/sandbox decision are discarded today.
CREATE TABLE tool_executions (
  id               TEXT PRIMARY KEY,
  request_id       TEXT,
  run_id           TEXT,
  step_id          TEXT,
  tool_name        TEXT NOT NULL,
  server_id        TEXT,
  args_json        TEXT,
  result_json      TEXT,
  error            TEXT,
  status           TEXT,
  duration_ms      INTEGER,
  sandbox_decision TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_run ON tool_executions(run_id);

-- (D) Alert rules. Thresholds are DATA, not source literals. `source`
-- discriminates event-bus rules (predicate over the event payload) from
-- telemetry rules (cost/tokens, evaluated on the telemetry write path).
CREATE TABLE alert_rules (
  id             TEXT PRIMARY KEY,
  name           TEXT,
  source         TEXT NOT NULL,
  event_type     TEXT,
  predicate_json TEXT NOT NULL,
  action         TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);
