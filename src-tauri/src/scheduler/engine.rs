// src-tauri/src/scheduler/engine.rs
use crate::audit::AuditEntry;
use crate::db::Db;
use crate::providers::error::RustError;
use crate::scheduler::store;
use crate::scheduler::types::{next_run_after, FireState, ScheduledJob, SchedulerHealth};
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

const DEFAULT_MAX_CONCURRENT: usize = 3;
const CATCHUP_DRAIN_WAIT_SECS: u64 = 2;

/// Emit `scheduler:*` events to the background window if it exists, otherwise main.
pub(crate) fn target_window(app: &AppHandle) -> &'static str {
    if app.get_webview_window("background").is_some() { "background" } else { "main" }
}

pub struct Scheduler {
    pub db: Arc<Db>,
    pub app: AppHandle,
    pub in_flight: DashMap<String, FireState>,
    pub notify_changes: Notify,
    pub join_handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub max_concurrent: usize,
    pub last_tick_at: Mutex<Option<DateTime<Utc>>>,
}

impl Scheduler {
    pub fn new(db: Arc<Db>, app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            db, app,
            in_flight: DashMap::new(),
            notify_changes: Notify::new(),
            join_handle: Mutex::new(None),
            max_concurrent: DEFAULT_MAX_CONCURRENT,
            last_tick_at: Mutex::new(None),
        })
    }

    /// Start the tokio task and store its JoinHandle so shutdown can abort it.
    pub async fn spawn(self: &Arc<Self>) {
        let me = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            me.run().await;
        });
        *self.join_handle.lock().await = Some(handle);
    }

    async fn run(self: Arc<Self>) {
        self.startup_orphan_recovery().await;
        self.tick().await; // catchup
        loop {
            let sleep_until_or_indefinite = self.compute_sleep().await;
            tokio::select! {
                _ = sleep_until_or_indefinite => self.tick().await,
                _ = self.notify_changes.notified() => continue,
            }
        }
    }

    /// Returns a future that resolves at the next due-time. If no jobs scheduled,
    /// returns a future that never resolves (so the select! waits indefinitely
    /// on notify_changes).
    async fn compute_sleep(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        match store::next_scheduled_time(&self.db).await.ok().flatten() {
            None => Box::pin(std::future::pending::<()>()),
            Some(iso) => {
                let target = DateTime::parse_from_rfc3339(&iso)
                    .map(|d| d.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now() + chrono::Duration::seconds(60));
                let now = Utc::now();
                let dur = if target <= now {
                    tokio::time::Duration::from_millis(0)
                } else {
                    let secs = (target - now).num_seconds().max(0) as u64;
                    tokio::time::Duration::from_secs(secs)
                };
                Box::pin(tokio::time::sleep(dur))
            }
        }
    }

    async fn tick(&self) {
        *self.last_tick_at.lock().await = Some(Utc::now());
        let now = Utc::now().to_rfc3339();
        let due = match store::list_jobs_due_at_or_before(&self.db, now).await {
            Ok(v) => v,
            Err(e) => { eprintln!("[scheduler] list error: {e:?}"); return; }
        };
        for job in due {
            if self.in_flight.len() >= self.max_concurrent { break; }
            if self.in_flight.contains_key(&job.id) { continue; }
            if let Err(e) = self.fire(job, /* actor */ "system".into()).await {
                eprintln!("[scheduler] fire error: {e:?}");
            }
        }
    }

    /// Fire a job. Reads agent config for rate-limit check, advances next_run_at,
    /// inserts FireState, emits scheduler:fire_job, returns run_id.
    pub async fn fire(&self, job: ScheduledJob, actor: String) -> Result<String, RustError> {
        // Rate-limit consultation.
        if self.is_rate_limited(&job).await? {
            self.record_skip_rate_limited(&job, &actor).await?;
            return Ok(String::new());
        }

        let now = Utc::now();
        let started_at = now;
        let run_id = nanoid::nanoid!();

        // Advance next_run_at; on malformed cron treat as a startup error and disable.
        let next_iso = match next_run_after(&job.cron_expression, &job.timezone, now) {
            Ok(d) => d.to_rfc3339(),
            Err(_e) => {
                self.disable_for_malformed(&job, &actor).await?;
                return Err(RustError::new("INVALID_CRON_FORMAT", "stored cron unparseable", false));
            }
        };

        // Update + audit (transactional).
        let audit = AuditEntry {
            event_type: "schedule.run_started".into(),
            actor: actor.clone(),
            target_type: Some("scheduled_job".into()),
            target_id: Some(job.id.clone()),
            details: Some(json!({ "run_id": run_id })),
        };
        store::update_after_fire(
            &self.db, job.id.clone(), started_at.to_rfc3339(), next_iso, audit,
        ).await?;

        // Track in-flight.
        let token = CancellationToken::new();
        self.in_flight.insert(job.id.clone(), FireState {
            run_id: run_id.clone(),
            started_at,
            cancel_token: token,
        });

        // Emit to the appropriate window.
        let _ = self.app.emit_to(target_window(&self.app), "scheduler:fire_job", &json!({
            "job": job,
            "runId": run_id,
            "startedAt": started_at.to_rfc3339(),
        }));

        Ok(run_id)
    }

    pub async fn complete(
        &self, run_id: String, job_id: String, conversation_id: String,
        message_id: Option<String>, status: String, error: Option<String>,
        renderer_claimed_input: u32, renderer_claimed_output: u32,
    ) -> Result<(), RustError> {
        // Validate against in_flight.
        let entry = self.in_flight.remove(&job_id).ok_or_else(|| {
            RustError::new("INVALID_RUN_TOKEN", "no in-flight entry for job", false)
        })?;
        if entry.1.run_id != run_id {
            // Re-insert; this completion doesn't match.
            self.in_flight.insert(job_id.clone(), entry.1);
            return Err(RustError::new("INVALID_RUN_TOKEN", "run_id mismatch", false));
        }
        let started_at_iso = entry.1.started_at.to_rfc3339();
        let completed_at_iso = Utc::now().to_rfc3339();

        // Cross-reference tokens from llm_requests.
        let (input_tokens, output_tokens) = store::sum_tokens_for_run(
            &self.db, conversation_id.clone(), started_at_iso.clone(),
        ).await.unwrap_or((0, 0));

        // Append schedule_run_history.
        let run = crate::scheduler::types::ScheduleRun {
            id: nanoid::nanoid!(),
            job_id: job_id.clone(),
            conversation_id: conversation_id.clone(),
            message_id,
            status: status.clone(),
            error: error.clone(),
            input_tokens, output_tokens,
            started_at: started_at_iso, completed_at: completed_at_iso,
        };
        store::append_run(&self.db, run).await?;

        // Update scheduled_jobs + audit.
        let is_error = status != "success";
        let audit = AuditEntry {
            event_type: if is_error { "schedule.run_failed".into() } else { "schedule.run_completed".into() },
            actor: "system".into(),
            target_type: Some("scheduled_job".into()),
            target_id: Some(job_id.clone()),
            details: Some(json!({
                "run_id": run_id,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "renderer_claimed_tokens": {
                    "input": renderer_claimed_input,
                    "output": renderer_claimed_output,
                },
                "error": error,
            })),
        };
        let new_fail_count = store::update_after_complete(
            &self.db, job_id.clone(),
            if is_error { "error".into() } else { "success".into() },
            error.clone(), is_error, audit,
        ).await?;

        // Emit UI refresh.
        let _ = self.app.emit_to(target_window(&self.app), "scheduler:job_updated", &json!({
            "jobId": job_id, "status": status,
        }));
        let event_name = if is_error { "scheduler:job_failed" } else { "scheduler:job_completed" };
        let _ = self.app.emit_to(target_window(&self.app), event_name, &json!({
            "jobId": job_id, "runId": run_id, "error": error,
        }));

        // Auto-disable on broken agent reference (3 consecutive AGENT_NOT_FOUND-class failures).
        if is_error && new_fail_count >= 3
            && error.as_deref().map_or(false, |e| e.contains("AGENT_NOT_FOUND") || e.contains("AGENT_INVALID_CONFIG"))
        {
            let disable_audit = AuditEntry {
                event_type: "schedule.auto_disabled".into(),
                actor: "system".into(),
                target_type: Some("scheduled_job".into()),
                target_id: Some(job_id.clone()),
                details: Some(json!({
                    "reason": "consecutive_agent_failures",
                    "consecutive_failures": new_fail_count,
                })),
            };
            store::disable_job(&self.db, job_id.clone(), format!("auto-disabled: {new_fail_count} consecutive failures"), disable_audit).await?;
            self.notify_changes.notify_one();
        }

        Ok(())
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), RustError> {
        if let Some(entry) = self.in_flight.get(job_id) {
            entry.cancel_token.cancel();
        }
        Ok(())
    }

    pub fn is_in_flight(&self, job_id: &str) -> bool {
        self.in_flight.contains_key(job_id)
    }

    pub async fn health(&self) -> SchedulerHealth {
        let last_tick = *self.last_tick_at.lock().await;
        SchedulerHealth {
            last_tick_at: last_tick.map(|t| t.to_rfc3339()),
            jobs_in_flight: self.in_flight.len() as u32,
            total_fires_today: 0, // optional — could query schedule_run_history WHERE started_at >= today
            total_failures_today: 0,
        }
    }

    pub async fn shutdown(&self) {
        // Cancel in-flight, wait up to CATCHUP_DRAIN_WAIT_SECS for JS sched_complete_run calls.
        for entry in self.in_flight.iter() {
            entry.cancel_token.cancel();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(CATCHUP_DRAIN_WAIT_SECS);
        while !self.in_flight.is_empty() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        // Mark remaining as app-restart.
        for entry in self.in_flight.iter() {
            let job_id = entry.key().clone();
            let audit = AuditEntry {
                event_type: "schedule.run_failed".into(),
                actor: "system".into(),
                target_type: Some("scheduled_job".into()),
                target_id: Some(job_id.clone()),
                details: Some(json!({ "error": "app-restart" })),
            };
            let _ = store::update_after_complete(
                &self.db, job_id, "error".into(),
                Some("app-restart".into()), true, audit,
            ).await;
        }
        self.in_flight.clear();
        if let Some(h) = self.join_handle.lock().await.take() {
            h.abort();
        }
    }

    async fn startup_orphan_recovery(&self) {
        // Marks scheduled_jobs.last_run_status='running' from prior session.
        let now = Utc::now().to_rfc3339();
        let to_recover = self.db.with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id FROM scheduled_jobs WHERE last_run_status = 'running'"
            ).ok()?;
            let rows: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0)).ok()?
                .filter_map(|r| r.ok()).collect();
            Some(rows)
        }).await.unwrap_or_default();
        for job_id in to_recover {
            let audit = AuditEntry {
                event_type: "schedule.run_failed".into(),
                actor: "system".into(),
                target_type: Some("scheduled_job".into()),
                target_id: Some(job_id.clone()),
                details: Some(json!({ "error": "app-restart" })),
            };
            let _ = store::update_after_complete(
                &self.db, job_id, "error".into(),
                Some("app-restart".into()), true, audit,
            ).await;
        }
        let _ = now; // silence
    }

    async fn is_rate_limited(&self, job: &ScheduledJob) -> Result<bool, RustError> {
        let agent_id = job.agent_id.clone();
        let today = Utc::now().format("%Y-%m-%d").to_string();
        self.db.with(move |conn| {
            // Read maxTokensPerDay from agents.config_json.
            let max_per_day: Option<i64> = conn.query_row(
                "SELECT json_extract(config_json, '$.rateLimits.maxTokensPerDay') FROM agents WHERE id = ?",
                [agent_id.as_str()], |r| r.get(0),
            ).optional().map_err(crate::audit::map_db_err)?.flatten();
            let Some(max) = max_per_day else { return Ok(false); };
            let used: i64 = conn.query_row(
                "SELECT COALESCE(input_tokens + output_tokens, 0) FROM daily_token_usage WHERE agent_id = ? AND date = ?",
                rusqlite::params![agent_id, today], |r| r.get(0),
            ).optional().map_err(crate::audit::map_db_err)?.unwrap_or(0);
            Ok(used >= max)
        }).await
    }

    async fn record_skip_rate_limited(&self, job: &ScheduledJob, actor: &str) -> Result<(), RustError> {
        let now = Utc::now();
        let next_iso = next_run_after(&job.cron_expression, &job.timezone, now)
            .map(|d| d.to_rfc3339()).unwrap_or_default();
        // Append a fake completed row.
        let run = crate::scheduler::types::ScheduleRun {
            id: nanoid::nanoid!(),
            job_id: job.id.clone(),
            conversation_id: job.target_conversation_id.clone().unwrap_or_default(),
            message_id: None,
            status: "error".into(),
            error: Some("rate-limited".into()),
            input_tokens: 0, output_tokens: 0,
            started_at: now.to_rfc3339(), completed_at: now.to_rfc3339(),
        };
        store::append_run(&self.db, run).await?;
        let audit = AuditEntry {
            event_type: "schedule.run_failed".into(),
            actor: actor.into(),
            target_type: Some("scheduled_job".into()),
            target_id: Some(job.id.clone()),
            details: Some(json!({ "error": "rate-limited" })),
        };
        store::update_after_fire(&self.db, job.id.clone(), now.to_rfc3339(), next_iso, audit).await?;
        // Then mark as error.
        let complete_audit = AuditEntry {
            event_type: "schedule.run_failed".into(),
            actor: "system".into(),
            target_type: Some("scheduled_job".into()),
            target_id: Some(job.id.clone()),
            details: Some(json!({ "error": "rate-limited" })),
        };
        store::update_after_complete(
            &self.db, job.id.clone(), "error".into(),
            Some("rate-limited".into()), true, complete_audit,
        ).await?;
        Ok(())
    }

    async fn disable_for_malformed(&self, job: &ScheduledJob, _actor: &str) -> Result<(), RustError> {
        let audit = AuditEntry {
            event_type: "schedule.run_failed".into(),
            actor: "system".into(),
            target_type: Some("scheduled_job".into()),
            target_id: Some(job.id.clone()),
            details: Some(json!({ "error": "invalid stored next_run_at" })),
        };
        store::disable_job(&self.db, job.id.clone(), "invalid stored next_run_at".into(), audit).await
    }
}

use rusqlite::OptionalExtension;
