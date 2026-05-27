-- MatrixOS Phase 2a — Telemetry

CREATE TABLE IF NOT EXISTS llm_requests (
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
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_requests_conversation ON llm_requests(conversation_id);
CREATE INDEX IF NOT EXISTS idx_llm_requests_agent ON llm_requests(agent_id);
CREATE INDEX IF NOT EXISTS idx_llm_requests_created ON llm_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_requests_status ON llm_requests(status);
