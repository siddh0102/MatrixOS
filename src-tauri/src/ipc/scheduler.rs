// src-tauri/src/ipc/scheduler.rs
use crate::audit::AuditEntry;
use crate::db::Db;
use crate::providers::error::RustError;
use crate::providers::types::CallContext;
use crate::scheduler::engine::{target_window, Scheduler};
use crate::scheduler::store;
use crate::scheduler::types::{
    next_run_after, validate_cron_format, validate_timezone,
    ScheduleRun, ScheduledJob, SchedulerHealth,
};
use chrono::Utc;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

const MAX_PROMPT_BYTES: usize = 64 * 1024;

fn actor_for(ctx: &CallContext) -> String {
    match ctx {
        CallContext::Agent { agent_id, .. } => format!("agent:{agent_id}"),
        CallContext::User => "user".into(),
        CallContext::Scheduler { job_id } => format!("scheduler:{job_id}"),
        CallContext::Workflow { workflow_run_id, .. } => format!("workflow:{workflow_run_id}"),
    }
}

#[tauri::command]
pub async fn sched_save_job(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    sched: State<'_, Arc<Scheduler>>,
    ctx: CallContext,
    mut job: ScheduledJob,
) -> Result<(), RustError> {
    // Validate inputs.
    if job.prompt.len() > MAX_PROMPT_BYTES {
        return Err(RustError::new("INVALID_PROMPT", "prompt exceeds 64 KB", false));
    }
    validate_cron_format(&job.cron_expression)?;
    validate_timezone(&job.timezone)?;

    let prev = store::read_job(&db, job.id.clone()).await?;
    job.next_run_at = Some(next_run_after(&job.cron_expression, &job.timezone, Utc::now())?.to_rfc3339());

    let event_type = if prev.is_some() { "schedule.updated" } else { "schedule.created" };
    let audit = AuditEntry {
        event_type: event_type.into(),
        actor: actor_for(&ctx),
        target_type: Some("scheduled_job".into()),
        target_id: Some(job.id.clone()),
        details: Some(json!({ "prev": prev, "next": job })),
    };
    store::upsert_job(&db, job.clone(), audit).await?;
    sched.notify_changes.notify_one();

    // Lazy background-window creation: first job triggers it.
    crate::lifecycle::ensure_background_window_if_needed(&app).await;

    // Tray menu rebuild.
    crate::tray::rebuild_menu(&app).await.ok();
    Ok(())
}

#[tauri::command]
pub async fn sched_delete_job(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    sched: State<'_, Arc<Scheduler>>,
    ctx: CallContext,
    job_id: String,
) -> Result<(), RustError> {
    // Cancel in-flight first; brief grace; then delete.
    sched.cancel(&job_id)?;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let prev = store::read_job(&db, job_id.clone()).await?;
    let audit = AuditEntry {
        event_type: "schedule.deleted".into(),
        actor: actor_for(&ctx),
        target_type: Some("scheduled_job".into()),
        target_id: Some(job_id.clone()),
        details: Some(json!({ "prev": prev })),
    };
    store::delete_job(&db, job_id, audit).await?;
    sched.notify_changes.notify_one();
    crate::tray::rebuild_menu(&app).await.ok();
    Ok(())
}

#[tauri::command]
pub async fn sched_run_now(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    sched: State<'_, Arc<Scheduler>>,
    ctx: CallContext,
    job_id: String,
) -> Result<(), RustError> {
    if sched.is_in_flight(&job_id) {
        return Err(RustError::new("JOB_ALREADY_RUNNING", "job is already running", false));
    }
    let job = store::read_job(&db, job_id.clone()).await?
        .ok_or_else(|| RustError::new("JOB_NOT_FOUND", format!("job {job_id} not found"), false))?;
    let actor = actor_for(&ctx);
    let run_id = sched.fire(job, actor).await?;
    let _ = app.emit_to(target_window(&app), "scheduler:run_started", &json!({
        "jobId": job_id, "runId": run_id,
    }));
    Ok(())
}

#[tauri::command]
pub async fn sched_cancel_run(
    sched: State<'_, Arc<Scheduler>>,
    job_id: String,
) -> Result<(), RustError> {
    sched.cancel(&job_id)
}

#[tauri::command]
pub async fn sched_list_runs(
    db: State<'_, Arc<Db>>,
    job_id: String,
    limit: u32,
) -> Result<Vec<ScheduleRun>, RustError> {
    store::list_runs(&db, job_id, limit).await
}

#[tauri::command]
pub async fn sched_complete_run(
    db: State<'_, Arc<Db>>,
    sched: State<'_, Arc<Scheduler>>,
    run_id: String,
    job_id: String,
    conversation_id: String,
    message_id: Option<String>,
    status: String,
    error: Option<String>,
    renderer_claimed_input: Option<u32>,
    renderer_claimed_output: Option<u32>,
) -> Result<(), RustError> {
    let _ = db; // db is used inside sched
    sched.complete(
        run_id, job_id, conversation_id, message_id, status, error,
        renderer_claimed_input.unwrap_or(0), renderer_claimed_output.unwrap_or(0),
    ).await
}

#[tauri::command]
pub async fn sched_health(
    sched: State<'_, Arc<Scheduler>>,
) -> Result<SchedulerHealth, RustError> {
    Ok(sched.health().await)
}

#[tauri::command]
pub async fn pref_set(
    db: State<'_, Arc<Db>>,
    ctx: CallContext,
    key: String,
    value_json: String,
) -> Result<(), RustError> {
    use crate::audit::{append_audit_in_txn, map_db_err};
    let actor = actor_for(&ctx);
    let key_for_audit = key.clone();
    let value_for_audit = value_json.clone();
    db.with(move |conn| {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO preferences (agent_id, key, value_json, updated_at)
             VALUES ('__global__', ?, ?, ?)
             ON CONFLICT(agent_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            rusqlite::params![key, value_json, now],
        ).map_err(map_db_err)?;
        let audit = AuditEntry {
            event_type: "preference.updated".into(),
            actor: actor.clone(),
            target_type: Some("preference".into()),
            target_id: Some(key_for_audit.clone()),
            details: Some(json!({ "value": value_for_audit })),
        };
        append_audit_in_txn(&tx, &audit)?;
        tx.commit().map_err(map_db_err)?;
        Ok(())
    }).await
}
