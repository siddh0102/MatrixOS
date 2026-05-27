// src-tauri/src/scheduler/store.rs
use crate::audit::{append_audit_in_txn, map_db_err, AuditEntry};
use crate::db::Db;
use crate::providers::error::RustError;
use crate::scheduler::types::{ScheduleRun, ScheduledJob};
use rusqlite::params;
use rusqlite::OptionalExtension;
use std::sync::Arc;

pub async fn list_jobs_due_at_or_before(
    db: &Arc<Db>, now_rfc3339: String,
) -> Result<Vec<ScheduledJob>, RustError> {
    db.with(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, name, cron_expression, timezone, enabled, prompt,
                    target_conversation_id, last_run_at, next_run_at,
                    last_run_status, last_error,
                    COALESCE(consecutive_failures, 0)
               FROM scheduled_jobs
              WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
              ORDER BY next_run_at ASC"
        ).map_err(map_db_err)?;
        let rows = stmt.query_map([now_rfc3339.as_str()], row_to_job)
            .map_err(map_db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_db_err)?;
        Ok(rows)
    }).await
}

pub async fn next_scheduled_time(db: &Arc<Db>) -> Result<Option<String>, RustError> {
    db.with(|conn| {
        conn.query_row(
            "SELECT MIN(next_run_at) FROM scheduled_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL",
            [], |r| r.get::<_, Option<String>>(0),
        ).map_err(map_db_err)
    }).await
}

pub async fn read_job(db: &Arc<Db>, job_id: String) -> Result<Option<ScheduledJob>, RustError> {
    db.with(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, name, cron_expression, timezone, enabled, prompt,
                    target_conversation_id, last_run_at, next_run_at,
                    last_run_status, last_error,
                    COALESCE(consecutive_failures, 0)
               FROM scheduled_jobs WHERE id = ?"
        ).map_err(map_db_err)?;
        let row = stmt.query_row([job_id.as_str()], row_to_job).optional()
            .map_err(map_db_err)?;
        Ok(row)
    }).await
}

/// Tier-B write: UPDATE scheduled_jobs + audit, in a single transaction.
pub async fn update_after_fire(
    db: &Arc<Db>,
    job_id: String,
    last_run_at: String,
    next_run_at: String,
    audit: AuditEntry,
) -> Result<(), RustError> {
    db.with(move |conn| {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        tx.execute(
            "UPDATE scheduled_jobs
                SET last_run_at = ?, next_run_at = ?,
                    last_run_status = 'running',
                    updated_at = ?
              WHERE id = ?",
            params![last_run_at, next_run_at, last_run_at /* updated_at */, job_id],
        ).map_err(map_db_err)?;
        append_audit_in_txn(&tx, &audit)?;
        tx.commit().map_err(map_db_err)?;
        Ok(())
    }).await
}

/// Tier-B write: UPDATE scheduled_jobs.last_run_status (+/- consecutive_failures) + audit.
pub async fn update_after_complete(
    db: &Arc<Db>,
    job_id: String,
    status: String,
    last_error: Option<String>,
    advance_failure_count: bool, // true on error, false on success (resets to 0)
    audit: AuditEntry,
) -> Result<u32, RustError> {
    db.with(move |conn| {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        let updated_at = chrono::Utc::now().to_rfc3339();
        let new_fail_count: i64 = if advance_failure_count {
            tx.query_row(
                "SELECT COALESCE(consecutive_failures, 0) + 1 FROM scheduled_jobs WHERE id = ?",
                [job_id.as_str()], |r| r.get::<_, i64>(0),
            ).map_err(map_db_err)?
        } else { 0 };
        tx.execute(
            "UPDATE scheduled_jobs
                SET last_run_status = ?, last_error = ?,
                    consecutive_failures = ?, updated_at = ?
              WHERE id = ?",
            params![status, last_error, new_fail_count, updated_at, job_id],
        ).map_err(map_db_err)?;
        append_audit_in_txn(&tx, &audit)?;
        tx.commit().map_err(map_db_err)?;
        Ok(new_fail_count as u32)
    }).await
}

/// Tier-B write: auto-disable + audit.
pub async fn disable_job(
    db: &Arc<Db>, job_id: String, reason: String, audit: AuditEntry,
) -> Result<(), RustError> {
    db.with(move |conn| {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        let updated_at = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE scheduled_jobs SET enabled = 0, last_error = ?, updated_at = ? WHERE id = ?",
            params![reason, updated_at, job_id],
        ).map_err(map_db_err)?;
        append_audit_in_txn(&tx, &audit)?;
        tx.commit().map_err(map_db_err)?;
        Ok(())
    }).await
}

pub async fn upsert_job(db: &Arc<Db>, job: ScheduledJob, audit: AuditEntry) -> Result<(), RustError> {
    db.with(move |conn| {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO scheduled_jobs
                (id, agent_id, name, cron_expression, timezone, enabled, prompt,
                 target_conversation_id, next_run_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                agent_id = excluded.agent_id,
                name = excluded.name,
                cron_expression = excluded.cron_expression,
                timezone = excluded.timezone,
                enabled = excluded.enabled,
                prompt = excluded.prompt,
                target_conversation_id = excluded.target_conversation_id,
                next_run_at = excluded.next_run_at,
                updated_at = ?",
            params![
                job.id, job.agent_id, job.name, job.cron_expression, job.timezone,
                if job.enabled {1i64} else {0i64}, job.prompt,
                job.target_conversation_id, job.next_run_at, now, now, now,
            ],
        ).map_err(map_db_err)?;
        append_audit_in_txn(&tx, &audit)?;
        tx.commit().map_err(map_db_err)?;
        Ok(())
    }).await
}

pub async fn delete_job(db: &Arc<Db>, job_id: String, audit: AuditEntry) -> Result<(), RustError> {
    db.with(move |conn| {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        tx.execute("DELETE FROM scheduled_jobs WHERE id = ?", [job_id.as_str()])
            .map_err(map_db_err)?;
        append_audit_in_txn(&tx, &audit)?;
        tx.commit().map_err(map_db_err)?;
        Ok(())
    }).await
}

/// schedule_run_history is append-only. INSERT only at completion (never at fire time).
pub async fn append_run(db: &Arc<Db>, run: ScheduleRun) -> Result<(), RustError> {
    db.with(move |conn| {
        conn.execute(
            "INSERT INTO schedule_run_history
                (id, job_id, conversation_id, message_id, status, error,
                 input_tokens, output_tokens, started_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                run.id, run.job_id, run.conversation_id, run.message_id,
                run.status, run.error, run.input_tokens, run.output_tokens,
                run.started_at, run.completed_at,
            ],
        ).map(|_| ()).map_err(map_db_err)
    }).await
}

pub async fn list_runs(
    db: &Arc<Db>, job_id: String, limit: u32,
) -> Result<Vec<ScheduleRun>, RustError> {
    db.with(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, job_id, conversation_id, message_id, status, error,
                    input_tokens, output_tokens, started_at, completed_at
               FROM schedule_run_history WHERE job_id = ? ORDER BY started_at DESC LIMIT ?"
        ).map_err(map_db_err)?;
        let rows = stmt.query_map(params![job_id, limit], |r| {
            Ok(ScheduleRun {
                id: r.get(0)?, job_id: r.get(1)?, conversation_id: r.get(2)?,
                message_id: r.get(3)?, status: r.get(4)?, error: r.get(5)?,
                input_tokens: r.get::<_, i64>(6)? as u32,
                output_tokens: r.get::<_, i64>(7)? as u32,
                started_at: r.get(8)?, completed_at: r.get(9)?,
            })
        }).map_err(map_db_err)?
          .collect::<Result<Vec<_>, _>>().map_err(map_db_err)?;
        Ok(rows)
    }).await
}

/// List enabled jobs for tray submenu rebuild. Uses `name` when present, falling back
/// to a truncated prompt for legacy rows without a name.
pub async fn list_enabled_for_tray(db: &Arc<Db>) -> Result<Vec<(String, String)>, RustError> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, COALESCE(name, SUBSTR(prompt, 1, 50))
               FROM scheduled_jobs WHERE enabled = 1 ORDER BY COALESCE(name, prompt) LIMIT 50"
        ).map_err(map_db_err)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(map_db_err)?
            .collect::<Result<Vec<_>, _>>().map_err(map_db_err)?;
        Ok(rows)
    }).await
}

/// Cross-reference tokens from llm_requests for the audit row.
pub async fn sum_tokens_for_run(
    db: &Arc<Db>, conversation_id: String, started_at: String,
) -> Result<(u32, u32), RustError> {
    db.with(move |conn| {
        let (inp, out): (i64, i64) = conn.query_row(
            "SELECT COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0)
               FROM llm_requests
              WHERE conversation_id = ? AND created_at >= ?",
            params![conversation_id, started_at], |r| Ok((r.get(0)?, r.get(1)?)),
        ).map_err(map_db_err)?;
        Ok((inp as u32, out as u32))
    }).await
}

fn row_to_job(r: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduledJob> {
    Ok(ScheduledJob {
        id: r.get(0)?, agent_id: r.get(1)?, name: r.get(2)?,
        cron_expression: r.get(3)?, timezone: r.get(4)?,
        enabled: r.get::<_, i64>(5)? != 0,
        prompt: r.get(6)?, target_conversation_id: r.get(7)?,
        last_run_at: r.get(8)?, next_run_at: r.get(9)?,
        last_run_status: r.get(10)?, last_error: r.get(11)?,
        consecutive_failures: r.get::<_, i64>(12)? as u32,
    })
}
