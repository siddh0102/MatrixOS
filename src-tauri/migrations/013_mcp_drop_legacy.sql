-- Phase D: auto-restart machinery is removed in favour of user-prompt-on-crash.
-- These columns are no longer read or written by any code path after this PR.
ALTER TABLE mcp_servers DROP COLUMN auto_restart;
ALTER TABLE mcp_servers DROP COLUMN max_restarts;
ALTER TABLE mcp_servers DROP COLUMN health_check_interval_ms;
