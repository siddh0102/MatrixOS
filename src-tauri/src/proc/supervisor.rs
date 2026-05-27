// src-tauri/src/proc/supervisor.rs
use crate::audit::AuditEntry;
use crate::db::Db;
use crate::providers::error::RustError;
use crate::proc::store;
use crate::proc::types::{ProcessEvent, ProcessKind, ProcessStatus, RunningProcess, TokenBudget};
use crate::scheduler::engine::target_window;
use dashmap::DashMap;
use serde_json::json;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

const MAX_SUBSCRIBERS_PER_PROCESS: usize = 8;

pub struct SubscriberEntry {
    pub subscription_id: String,
    pub channel: Channel<ProcessEvent>,
}

pub struct ProcessHandle {
    pub id: String,
    pub agent_id: String,
    pub kind: ProcessKind,
    pub conversation_id: String,
    pub subscribers: Mutex<Vec<SubscriberEntry>>,
}

pub struct Supervisor {
    pub processes: DashMap<String, Arc<ProcessHandle>>,
    pub db: Arc<Db>,
    pub app: AppHandle,
}

impl Supervisor {
    pub fn new(db: Arc<Db>, app: AppHandle) -> Arc<Self> {
        Arc::new(Self { processes: DashMap::new(), db, app })
    }

    pub async fn start(
        &self,
        actor: String,
        agent_id: String,
        kind: ProcessKind,
        conversation_id: String,
        token_budget: TokenBudget,
    ) -> Result<String, RustError> {
        let t = std::time::Instant::now();
        let process_id = nanoid::nanoid!();
        let budget_json = serde_json::to_string(&token_budget).unwrap_or_else(|_| "{}".into());
        eprintln!("[rust:sup.start] enter pid={}", process_id);

        let audit = AuditEntry {
            event_type: "process.started".into(),
            actor: actor.clone(),
            target_type: Some("agent_process".into()),
            target_id: Some(process_id.clone()),
            details: Some(json!({
                "kind": match kind { ProcessKind::Interactive => "interactive", ProcessKind::Background => "background", ProcessKind::Scheduled => "scheduled" },
                "conversation_id": conversation_id,
            })),
        };
        eprintln!("[rust:sup.start] insert_process:before t_ms={}", t.elapsed().as_millis());
        store::insert_process(
            &self.db, process_id.clone(), agent_id.clone(), kind, conversation_id.clone(),
            budget_json, audit,
        ).await?;
        eprintln!("[rust:sup.start] insert_process:after t_ms={}", t.elapsed().as_millis());

        let handle = Arc::new(ProcessHandle {
            id: process_id.clone(),
            agent_id, kind, conversation_id,
            subscribers: Mutex::new(Vec::new()),
        });
        self.processes.insert(process_id.clone(), handle);

        eprintln!("[rust:sup.start] emit_to:before t_ms={}", t.elapsed().as_millis());
        let _ = self.app.emit_to(target_window(&self.app), "proc:started", &json!({ "processId": process_id }));
        eprintln!("[rust:sup.start] emit_to:after t_ms={}", t.elapsed().as_millis());
        self.broadcast(&process_id, ProcessEvent::Started { process_id: process_id.clone() }).await;
        eprintln!("[rust:sup.start] broadcast:after t_ms={}", t.elapsed().as_millis());
        Ok(process_id)
    }

    pub async fn update_status(
        &self, actor: String, process_id: String, status: ProcessStatus, error: Option<String>,
    ) -> Result<(), RustError> {
        let prev = store::read_status(&self.db, process_id.clone()).await?
            .ok_or_else(|| RustError::new("PROCESS_NOT_FOUND", "no such process".to_owned(), false))?;
        let audit = AuditEntry {
            event_type: "process.status_changed".into(),
            actor,
            target_type: Some("agent_process".into()),
            target_id: Some(process_id.clone()),
            details: Some(json!({ "from": prev.as_sql(), "to": status.as_sql() })),
        };
        store::update_status(&self.db, process_id.clone(), status, error, audit).await?;
        self.broadcast(&process_id, ProcessEvent::StatusChanged {
            process_id: process_id.clone(),
            from: prev.as_sql().into(),
            to: status.as_sql().into(),
        }).await;
        Ok(())
    }

    pub async fn complete(
        &self, actor: String, process_id: String, input_tokens: u32, output_tokens: u32,
    ) -> Result<(), RustError> {
        let audit = AuditEntry {
            event_type: "process.completed".into(),
            actor,
            target_type: Some("agent_process".into()),
            target_id: Some(process_id.clone()),
            details: Some(json!({ "input_tokens": input_tokens, "output_tokens": output_tokens })),
        };
        store::update_status(&self.db, process_id.clone(), ProcessStatus::Completed, None, audit).await?;
        self.broadcast(&process_id, ProcessEvent::Completed {
            process_id: process_id.clone(), input_tokens, output_tokens,
        }).await;
        self.processes.remove(&process_id);
        Ok(())
    }

    pub async fn fail(&self, _actor: String, process_id: String, error: String) -> Result<(), RustError> {
        let audit = AuditEntry {
            event_type: "process.failed".into(),
            actor: "system".into(),
            target_type: Some("agent_process".into()),
            target_id: Some(process_id.clone()),
            details: Some(json!({ "error": error })),
        };
        store::update_status(&self.db, process_id.clone(), ProcessStatus::Failed, Some(error.clone()), audit).await?;
        self.broadcast(&process_id, ProcessEvent::Failed {
            process_id: process_id.clone(), error,
        }).await;
        self.processes.remove(&process_id);
        Ok(())
    }

    pub async fn record_tokens(
        &self, actor: String, process_id: String, input_delta: u32, output_delta: u32,
    ) -> Result<(), RustError> {
        // No audit unless we cross a threshold — read current usage to decide.
        // For simplicity, the threshold check is delegated to the renderer-side
        // budget warning event; here we just update.
        store::record_tokens(&self.db, process_id, input_delta, output_delta, None).await?;
        let _ = actor;
        Ok(())
    }

    pub async fn status(&self, process_id: String) -> Result<ProcessStatus, RustError> {
        let sql_status = store::read_status(&self.db, process_id.clone()).await?
            .ok_or_else(|| RustError::new("PROCESS_NOT_FOUND", "no such process".to_owned(), false))?;
        // Merge with in-memory liveness: if SQL says running but in-memory absent, treat as failed.
        if matches!(sql_status, ProcessStatus::Running) && !self.processes.contains_key(&process_id) {
            return Ok(ProcessStatus::Failed);
        }
        Ok(sql_status)
    }

    pub async fn subscribe(
        &self, process_id: String, channel: Channel<ProcessEvent>,
    ) -> Result<String, RustError> {
        let handle = self.processes.get(&process_id)
            .ok_or_else(|| RustError::new("PROCESS_NOT_FOUND", "no such process".to_owned(), false))?;
        let subscription_id = nanoid::nanoid!();
        let mut subs = handle.subscribers.lock().await;
        if subs.len() >= MAX_SUBSCRIBERS_PER_PROCESS {
            subs.remove(0); // drop-oldest
        }
        subs.push(SubscriberEntry { subscription_id: subscription_id.clone(), channel });
        Ok(subscription_id)
    }

    pub async fn unsubscribe(&self, subscription_id: String) -> Result<(), RustError> {
        for entry in self.processes.iter() {
            let mut subs = entry.subscribers.lock().await;
            if let Some(pos) = subs.iter().position(|s| s.subscription_id == subscription_id) {
                subs.remove(pos);
                return Ok(());
            }
        }
        Ok(()) // idempotent
    }

    pub async fn list_running(&self) -> Result<Vec<RunningProcess>, RustError> {
        let mut out = Vec::new();
        for entry in self.processes.iter() {
            let status = store::read_status(&self.db, entry.id.clone()).await?
                .unwrap_or(ProcessStatus::Failed);
            out.push(RunningProcess {
                id: entry.id.clone(),
                agent_id: entry.agent_id.clone(),
                kind: entry.kind,
                conversation_id: entry.conversation_id.clone(),
                status,
            });
        }
        Ok(out)
    }

    async fn broadcast(&self, process_id: &str, ev: ProcessEvent) {
        let Some(handle) = self.processes.get(process_id) else { return };
        let subs = handle.subscribers.lock().await;
        for s in subs.iter() {
            let _ = s.channel.send(ev.clone());
        }
    }

    pub async fn shutdown(&self) {
        let orphans = store::mark_orphans_failed(&self.db).await.unwrap_or_default();
        for id in orphans {
            let audit = AuditEntry {
                event_type: "process.orphan_marked_failed".into(),
                actor: "system".into(),
                target_type: Some("agent_process".into()),
                target_id: Some(id),
                details: Some(json!({ "reason": "app-restart" })),
            };
            let _ = crate::audit::append_audit(&self.db, &audit).await;
        }
        self.processes.clear();
    }
}
