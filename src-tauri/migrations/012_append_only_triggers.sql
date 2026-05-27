-- Phase C: append-only enforcement on Tier-A tables.
-- These tables are append-only by design (audit, telemetry, quota usage,
-- scheduler history, process history). The triggers enforce immutability
-- at the engine level — even direct SQLite tool access from the renderer
-- cannot rewrite history.

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
  BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
  BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS llm_requests_no_update
  BEFORE UPDATE ON llm_requests
  BEGIN SELECT RAISE(ABORT, 'llm_requests is append-only'); END;
CREATE TRIGGER IF NOT EXISTS llm_requests_no_delete
  BEFORE DELETE ON llm_requests
  BEGIN SELECT RAISE(ABORT, 'llm_requests is append-only'); END;

-- daily_token_usage: DELETE-blocked only.
-- UPDATE is intentionally NOT blocked because token_usage_add does INSERT ON
-- CONFLICT DO UPDATE; SQLite fires BEFORE UPDATE triggers on the UPSERT's UPDATE
-- branch, so adding the trigger would break the UPSERT. Quota integrity is
-- enforced socially via Rust ownership of token_usage_add; a compromised
-- renderer can still tamper with running totals — see Phase C spec §5 residual.
CREATE TRIGGER IF NOT EXISTS daily_token_usage_no_delete
  BEFORE DELETE ON daily_token_usage
  BEGIN SELECT RAISE(ABORT, 'daily_token_usage is append-only'); END;

CREATE TRIGGER IF NOT EXISTS schedule_run_history_no_update
  BEFORE UPDATE ON schedule_run_history
  BEGIN SELECT RAISE(ABORT, 'schedule_run_history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS schedule_run_history_no_delete
  BEFORE DELETE ON schedule_run_history
  BEGIN SELECT RAISE(ABORT, 'schedule_run_history is append-only'); END;

-- agent_processes is mutable in state (running → completed) but its row
-- identity is append-only. We block DELETE only; UPDATE flows through Rust
-- commands defined in Phase E. JS retains UPDATE access through end-of-Phase-C —
-- see spec §5 residual.
CREATE TRIGGER IF NOT EXISTS agent_processes_no_delete
  BEFORE DELETE ON agent_processes
  BEGIN SELECT RAISE(ABORT, 'agent_processes is append-only'); END;
