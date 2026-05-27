// src-tauri/src/proc/types.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessKind {
    Interactive,
    Background,
    Scheduled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStatus {
    Queued,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

impl ProcessStatus {
    pub fn as_sql(&self) -> &'static str {
        match self {
            ProcessStatus::Queued => "queued",
            ProcessStatus::Running => "running",
            ProcessStatus::Paused => "paused",
            ProcessStatus::Completed => "completed",
            ProcessStatus::Failed => "failed",
            ProcessStatus::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBudget {
    pub max_tokens_per_turn: u32,
    pub max_tokens_per_session: u32,
    pub max_tokens_per_day: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProcessEvent {
    Started { process_id: String },
    StatusChanged { process_id: String, from: String, to: String },
    Completed { process_id: String, input_tokens: u32, output_tokens: u32 },
    Failed { process_id: String, error: String },
    Stopped { process_id: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningProcess {
    pub id: String,
    pub agent_id: String,
    pub kind: ProcessKind,
    pub conversation_id: String,
    pub status: ProcessStatus,
}
