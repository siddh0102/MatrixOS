// src-tauri/src/ipc/process.rs
use crate::db::Db;
use crate::providers::error::RustError;
use crate::providers::types::CallContext;
use crate::proc::supervisor::Supervisor;
use crate::proc::types::{ProcessEvent, ProcessKind, ProcessStatus, RunningProcess, TokenBudget};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

fn actor_for(ctx: &CallContext) -> String {
    match ctx {
        CallContext::Agent { agent_id, .. } => format!("agent:{agent_id}"),
        CallContext::User => "user".into(),
        CallContext::Scheduler { job_id } => format!("scheduler:{job_id}"),
        CallContext::Workflow { workflow_run_id, .. } => format!("workflow:{workflow_run_id}"),
    }
}

#[tauri::command]
pub async fn proc_start(
    _db: State<'_, Arc<Db>>,
    sup: State<'_, Arc<Supervisor>>,
    ctx: CallContext,
    agent_id: String,
    kind: ProcessKind,
    conversation_id: String,
    token_budget: TokenBudget,
) -> Result<String, RustError> {
    let t = std::time::Instant::now();
    eprintln!("[rust:proc_start] enter agent_id={}", agent_id);
    // Defense-in-depth: only the Rust scheduler may spawn 'scheduled' processes.
    if matches!(kind, ProcessKind::Scheduled) && !matches!(ctx, CallContext::Scheduler { .. }) {
        return Err(RustError::new("FORBIDDEN_KIND",
            "scheduled processes may only be started by the Rust scheduler", false));
    }
    let r = sup.start(actor_for(&ctx), agent_id, kind, conversation_id, token_budget).await;
    eprintln!("[rust:proc_start] exit elapsed_ms={} ok={}", t.elapsed().as_millis(), r.is_ok());
    r
}

#[tauri::command]
pub async fn proc_update_status(
    sup: State<'_, Arc<Supervisor>>,
    ctx: CallContext,
    process_id: String,
    status: ProcessStatus,
    error: Option<String>,
) -> Result<(), RustError> {
    sup.update_status(actor_for(&ctx), process_id, status, error).await
}

#[tauri::command]
pub async fn proc_complete(
    sup: State<'_, Arc<Supervisor>>,
    ctx: CallContext,
    process_id: String,
    input_tokens: u32,
    output_tokens: u32,
) -> Result<(), RustError> {
    sup.complete(actor_for(&ctx), process_id, input_tokens, output_tokens).await
}

#[tauri::command]
pub async fn proc_fail(
    sup: State<'_, Arc<Supervisor>>,
    ctx: CallContext,
    process_id: String,
    error: String,
) -> Result<(), RustError> {
    sup.fail(actor_for(&ctx), process_id, error).await
}

#[tauri::command]
pub async fn proc_record_tokens(
    sup: State<'_, Arc<Supervisor>>,
    ctx: CallContext,
    process_id: String,
    input_tokens: u32,
    output_tokens: u32,
) -> Result<(), RustError> {
    sup.record_tokens(actor_for(&ctx), process_id, input_tokens, output_tokens).await
}

#[tauri::command]
pub async fn proc_status(
    sup: State<'_, Arc<Supervisor>>,
    process_id: String,
) -> Result<ProcessStatus, RustError> {
    sup.status(process_id).await
}

#[tauri::command]
pub async fn proc_subscribe(
    sup: State<'_, Arc<Supervisor>>,
    process_id: String,
    on_event: Channel<ProcessEvent>,
) -> Result<String, RustError> {
    sup.subscribe(process_id, on_event).await
}

#[tauri::command]
pub async fn proc_unsubscribe(
    sup: State<'_, Arc<Supervisor>>,
    subscription_id: String,
) -> Result<(), RustError> {
    sup.unsubscribe(subscription_id).await
}

#[tauri::command]
pub async fn proc_list_running(
    sup: State<'_, Arc<Supervisor>>,
) -> Result<Vec<RunningProcess>, RustError> {
    sup.list_running().await
}
