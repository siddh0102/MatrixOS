pub mod hygiene;
pub mod http;
pub mod registry;
pub mod stdio;
pub mod types;

use crate::providers::types::CallContext;

/// Derive an audit-log `actor` string from a `CallContext`.
/// Used by every MCP lifecycle audit emission.
pub fn ctx_to_actor(ctx: &CallContext) -> String {
    match ctx {
        CallContext::User => "user".into(),
        CallContext::Agent { agent_id, .. } => format!("agent:{}", agent_id),
        CallContext::Scheduler { job_id } => format!("scheduler:{}", job_id),
        CallContext::Workflow { workflow_run_id, .. } => format!("workflow:{}", workflow_run_id),
    }
}
