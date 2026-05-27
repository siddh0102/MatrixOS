export const APP_NAME = "MatrixOS";
export const APP_VERSION = "0.1.0";
export const DB_NAME = "sqlite:matrixos.db";

export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_MAX_CONVERSATION_HISTORY = 50;
export const DEFAULT_SIDEBAR_WIDTH = 280;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

// Cap (chars) on per-round telemetry blobs (llm_calls prompt_json/response_text)
// so a large write_file/read round can't bloat the DB. See observability LLD M1.
export const TELEMETRY_BLOB_CAP = 16_384;

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

export const SECURE_STORE_KEY_PREFIX = "provider";
