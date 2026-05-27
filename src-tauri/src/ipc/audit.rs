use crate::audit::{append_audit, map_db_err, AuditEntry};
use crate::db::Db;
use crate::providers::error::RustError;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn audit_append(
    db: State<'_, Arc<Db>>,
    entry: AuditEntry,
) -> Result<(), RustError> {
    append_audit(&db, &entry).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRequestRow {
    pub id: String,
    pub conversation_id: String,
    pub agent_id: Option<String>,
    pub provider_id: String,
    pub model_id: String,
    pub prompt_json: String,
    pub response_text: Option<String>,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub tool_rounds: u32,
    pub latency_ms: u32,
    pub status: String,        // "success" | "error"
    pub error_code: Option<String>,
    pub created_at: String,    // ISO-8601 from JS
    // Orchestration linkage (migration 020). Optional so existing callers that
    // omit them deserialize cleanly to None (serde treats absent Option fields
    // as None; #[serde(default)] makes that explicit). The chat path leaves
    // these NULL; the workflow/delegation path populates them.
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub step_id: Option<String>,
    #[serde(default)]
    pub parent_request_id: Option<String>,
}

#[tauri::command]
pub async fn telemetry_append_llm_request(
    db: State<'_, Arc<Db>>,
    row: LlmRequestRow,
) -> Result<(), RustError> {
    db.with(move |conn| {
        conn.execute(
            "INSERT INTO llm_requests (
                id, conversation_id, agent_id, provider_id, model_id,
                prompt_json, response_text, input_tokens, output_tokens,
                tool_rounds, latency_ms, status, error_code, created_at,
                run_id, step_id, parent_request_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                row.id, row.conversation_id, row.agent_id, row.provider_id, row.model_id,
                row.prompt_json, row.response_text, row.input_tokens, row.output_tokens,
                row.tool_rounds, row.latency_ms, row.status, row.error_code, row.created_at,
                row.run_id, row.step_id, row.parent_request_id
            ],
        )
        .map(|_| ())
        .map_err(map_db_err)
    })
    .await
}

/// Per-round LLM-call detail (migration 020). One row per round within a turn;
/// `request_id` = the turn's llm_requests.id. Detail table, not append-only.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmCallRow {
    pub id: String,
    pub request_id: String,
    pub turn_index: u32,
    pub input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub ttft_ms: Option<u64>,
    pub latency_ms: Option<u64>,
    pub finish_reason: Option<String>,
    pub response_text: Option<String>,
    pub prompt_json: Option<String>, // stored only for error/'length' rounds (capped TS-side)
    pub created_at: String,
}

#[tauri::command]
pub async fn telemetry_append_llm_call(
    db: State<'_, Arc<Db>>,
    row: LlmCallRow,
) -> Result<(), RustError> {
    db.with(move |conn| {
        conn.execute(
            "INSERT INTO llm_calls (
                id, request_id, turn_index, input_tokens, output_tokens,
                ttft_ms, latency_ms, finish_reason, response_text, prompt_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                row.id, row.request_id, row.turn_index, row.input_tokens, row.output_tokens,
                row.ttft_ms, row.latency_ms, row.finish_reason, row.response_text,
                row.prompt_json, row.created_at
            ],
        )
        .map(|_| ())
        .map_err(map_db_err)
    })
    .await
}

/// Full tool-call record (migration 020). args/result are capped TS-side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecRow {
    pub id: String,
    pub request_id: Option<String>,
    pub run_id: Option<String>,
    pub step_id: Option<String>,
    pub tool_name: String,
    pub server_id: Option<String>,
    pub args_json: Option<String>,
    pub result_json: Option<String>,
    pub error: Option<String>,
    pub status: Option<String>,
    pub duration_ms: Option<u64>,
    pub sandbox_decision: Option<String>,
    pub created_at: String,
}

#[tauri::command]
pub async fn tool_exec_append(
    db: State<'_, Arc<Db>>,
    row: ToolExecRow,
) -> Result<(), RustError> {
    db.with(move |conn| {
        conn.execute(
            "INSERT INTO tool_executions (
                id, request_id, run_id, step_id, tool_name, server_id,
                args_json, result_json, error, status, duration_ms,
                sandbox_decision, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                row.id, row.request_id, row.run_id, row.step_id, row.tool_name, row.server_id,
                row.args_json, row.result_json, row.error, row.status, row.duration_ms,
                row.sandbox_decision, row.created_at
            ],
        )
        .map(|_| ())
        .map_err(map_db_err)
    })
    .await
}

/// OpenTelemetry export (migration 020 / LLD 3.7). POSTs a batch of events as
/// JSON to a user-configured collector endpoint. HTTP egress lives in Rust per
/// the transport split. Best-effort: the TS bridge swallows failures.
#[tauri::command]
pub async fn otel_export(
    endpoint: String,
    events: serde_json::Value,
) -> Result<(), RustError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(RustError::from)?;
    client
        .post(&endpoint)
        .json(&events)
        .send()
        .await
        .map_err(RustError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn token_usage_add(
    db: State<'_, Arc<Db>>,
    agent_id: String,
    date: String,
    input: u32,
    output: u32,
) -> Result<(), RustError> {
    db.with(move |conn| {
        conn.execute(
            "INSERT INTO daily_token_usage (agent_id, date, input_tokens, output_tokens)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(agent_id, date) DO UPDATE SET
               input_tokens  = input_tokens  + excluded.input_tokens,
               output_tokens = output_tokens + excluded.output_tokens",
            params![agent_id, date, input, output],
        )
        .map(|_| ())
        .map_err(map_db_err)
    })
    .await
}
