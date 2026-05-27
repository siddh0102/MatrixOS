-- MatrixOS Phase 2a — MCP Server Configs

CREATE TABLE IF NOT EXISTS mcp_servers (
  id                       TEXT PRIMARY KEY NOT NULL,
  name                     TEXT NOT NULL,
  transport_json           TEXT NOT NULL,
  enabled                  INTEGER NOT NULL DEFAULT 1,
  auto_restart             INTEGER NOT NULL DEFAULT 1,
  max_restarts             INTEGER NOT NULL DEFAULT 3,
  health_check_interval_ms INTEGER NOT NULL DEFAULT 30000,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
