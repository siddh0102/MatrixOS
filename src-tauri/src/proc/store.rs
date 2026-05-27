// src-tauri/src/proc/store.rs
use crate::audit::{append_audit_in_txn, map_db_err, AuditEntry};
use crate::db::Db;
use crate::providers::error::RustError;
use crate::proc::types::{ProcessKind, ProcessStatus};
use rusqlite::params;
use std::sync::Arc;

pub async fn insert_process(
    db: &Arc<Db>,
    id: String, agent_id: String, kind: ProcessKind,
    conversation_id: String, token_budget_json: String,
    audit: AuditEntry,
) -> Result<(), RustError> {
    db.with(move |conn| {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        let priority = match kind {
            ProcessKind::Interactive => "interactive",
            ProcessKind::Background => "background",
            ProcessKind::Scheduled => "scheduled",
        };
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO agent_processes
                (id, agent_id, conversation_id, priority, status, token_budget_json, started_at, created_at)
             VALUES (?, ?, ?, ?, 'queued', ?, NULL, ?)",
            params![id, agent_id, conversation_id, priority, token_budget_json, now],
        ).map_err(map_db_err)?;
        append_audit_in_txn(&tx, &audit)?;
        tx.commit().map_err(map_db_err)?;
        Ok(())
    }).await
}

pub async fn update_status(
    db: &Arc<Db>, process_id: String, status: ProcessStatus,
    error: Option<String>, audit: AuditEntry,
) -> Result<(), RustError> {
    db.with(move |conn| {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        let now = chrono::Utc::now().to_rfc3339();
        let started_at_clause = if matches!(status, ProcessStatus::Running) { ", started_at = COALESCE(started_at, ?)" } else { "" };
        let completed_clause = if matches!(status, ProcessStatus::Completed | ProcessStatus::Failed | ProcessStatus::Cancelled) {
            ", completed_at = ?"
        } else { "" };
        let sql = format!(
            "UPDATE agent_processes SET status = ?, error = ? {started_at_clause}{completed_clause} WHERE id = ?",
        );
        // We bind parameters in order: status, error, [started_at?], [completed_at?], id
        // Simplest correct approach: rebuild query branches.
        match (matches!(status, ProcessStatus::Running), completed_clause.is_empty()) {
            (true, true) => {
                tx.execute(
                    "UPDATE agent_processes SET status = ?, error = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
                    params![status.as_sql(), error, now, process_id],
                ).map_err(map_db_err)?;
            }
            (false, false) => {
                tx.execute(
                    "UPDATE agent_processes SET status = ?, error = ?, completed_at = ? WHERE id = ?",
                    params![status.as_sql(), error, now, process_id],
                ).map_err(map_db_err)?;
            }
            (_, _) => {
                tx.execute(
                    "UPDATE agent_processes SET status = ?, error = ? WHERE id = ?",
                    params![status.as_sql(), error, process_id],
                ).map_err(map_db_err)?;
            }
        }
        let _ = sql; // silence
        append_audit_in_txn(&tx, &audit)?;
        tx.commit().map_err(map_db_err)?;
        Ok(())
    }).await
}

pub async fn record_tokens(
    db: &Arc<Db>, process_id: String, input_delta: u32, output_delta: u32,
    audit: Option<AuditEntry>, // Some only on threshold crossing
) -> Result<(), RustError> {
    db.with(move |conn| {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        let current_json: String = tx.query_row(
            "SELECT token_usage_json FROM agent_processes WHERE id = ?",
            [process_id.as_str()], |r| r.get(0),
        ).map_err(map_db_err)?;
        let mut usage: serde_json::Value = serde_json::from_str(&current_json).unwrap_or_else(|_| serde_json::json!({}));
        let prev_in = usage.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let prev_out = usage.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        usage["inputTokens"] = serde_json::json!(prev_in.saturating_add(input_delta));
        usage["outputTokens"] = serde_json::json!(prev_out.saturating_add(output_delta));
        tx.execute(
            "UPDATE agent_processes SET token_usage_json = ? WHERE id = ?",
            params![usage.to_string(), process_id],
        ).map_err(map_db_err)?;
        if let Some(a) = audit { append_audit_in_txn(&tx, &a)?; }
        tx.commit().map_err(map_db_err)?;
        Ok(())
    }).await
}

pub async fn mark_orphans_failed(db: &Arc<Db>) -> Result<Vec<String>, RustError> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id FROM agent_processes WHERE status IN ('running','queued','paused')"
        ).map_err(map_db_err)?;
        let ids: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0))
            .map_err(map_db_err)?
            .filter_map(|r| r.ok())
            .collect();
        let now = chrono::Utc::now().to_rfc3339();
        for id in &ids {
            conn.execute(
                "UPDATE agent_processes SET status = 'failed', error = 'app-restart', completed_at = ? WHERE id = ?",
                params![now, id],
            ).map_err(map_db_err)?;
        }
        Ok(ids)
    }).await
}

pub async fn read_status(db: &Arc<Db>, process_id: String) -> Result<Option<ProcessStatus>, RustError> {
    db.with(move |conn| {
        let s: Option<String> = conn.query_row(
            "SELECT status FROM agent_processes WHERE id = ?",
            [process_id.as_str()], |r| r.get(0),
        ).optional().map_err(map_db_err)?;
        Ok(s.and_then(|x| match x.as_str() {
            "queued" => Some(ProcessStatus::Queued),
            "running" => Some(ProcessStatus::Running),
            "paused" => Some(ProcessStatus::Paused),
            "completed" => Some(ProcessStatus::Completed),
            "failed" => Some(ProcessStatus::Failed),
            "cancelled" => Some(ProcessStatus::Cancelled),
            _ => None,
        }))
    }).await
}

use rusqlite::OptionalExtension;
