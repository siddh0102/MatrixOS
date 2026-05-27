//! Phase E: FS/web denial events now persist to audit_log with full
//! CallContext attribution. Phase B's stderr-only `audit_hook` is replaced.

use crate::audit::{append_audit, AuditEntry};
use crate::db::Db;
use crate::providers::types::CallContext;
use serde::Serialize;
use serde_json::json;

#[derive(Debug, Clone, Copy, Serialize)]
pub enum AuditKind {
    SandboxDenied,
    UserPathNotRegistered,
    SsrfBlocked,
    WebDenied,
}

impl AuditKind {
    pub fn event_type(&self) -> String {
        match self {
            AuditKind::SandboxDenied => "fs.sandbox_denied".into(),
            AuditKind::UserPathNotRegistered => "fs.user_path_not_registered".into(),
            AuditKind::SsrfBlocked => "web.ssrf_blocked".into(),
            AuditKind::WebDenied => "web.denied".into(),
        }
    }
    pub fn target_type(&self) -> &'static str {
        match self {
            AuditKind::SandboxDenied | AuditKind::UserPathNotRegistered => "path",
            AuditKind::SsrfBlocked | AuditKind::WebDenied => "url",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AuditEvent {
    pub kind: AuditKind,
    pub ctx: CallContext,
    pub path_or_url: String,
    pub extra: serde_json::Value,
}

fn actor_and_agent(ctx: &CallContext) -> (String, Option<String>) {
    match ctx {
        CallContext::Agent { agent_id, .. } => (format!("agent:{agent_id}"), Some(agent_id.clone())),
        CallContext::User => ("user".into(), None),
        CallContext::Scheduler { job_id } => (format!("scheduler:{job_id}"), None),
        CallContext::Workflow { workflow_run_id, .. } => (format!("workflow:{workflow_run_id}"), None),
    }
}

pub async fn audit_hook(db: &Db, evt: &AuditEvent) {
    let (actor, agent_id) = actor_and_agent(&evt.ctx);
    let mut details = evt.extra.clone();
    if let serde_json::Value::Object(ref mut map) = details {
        if let CallContext::Workflow { workflow_run_id, .. } = &evt.ctx {
            map.insert("workflow_run_id".into(), json!(workflow_run_id));
        }
        if let Some(ai) = &agent_id {
            map.insert("agent_id".into(), json!(ai));
        }
    }
    let entry = AuditEntry {
        event_type: evt.kind.event_type(),
        actor,
        target_type: Some(evt.kind.target_type().into()),
        target_id: Some(evt.path_or_url.clone()),
        details: Some(details),
    };
    if let Err(e) = append_audit(db, &entry).await {
        eprintln!("[audit] persist failed: {e:?}");
        eprintln!("[audit] {:?}", evt);
    }
}
