use crate::db::Db;
use crate::fs::types::SandboxPolicy;
use crate::providers::error::RustError;
use crate::providers::types::CallContext;
use dashmap::DashMap;
use rusqlite::{Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct PolicyCache {
    entries: DashMap<String, (SandboxPolicy, Instant)>,
}

impl PolicyCache {
    const TTL: Duration = Duration::from_secs(5);

    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn get(&self, key: &str) -> Option<SandboxPolicy> {
        let entry = self.entries.get(key)?;
        if entry.1.elapsed() < Self::TTL {
            Some(entry.0.clone())
        } else {
            None
        }
    }

    pub fn put(&self, key: String, policy: SandboxPolicy) {
        self.entries.insert(key, (policy, Instant::now()));
    }

    pub fn invalidate(&self, key: &str) {
        self.entries.remove(key);
    }
}

pub async fn resolve_policy(
    ctx: &CallContext,
    db: &Db,
    cache: &PolicyCache,
) -> Result<SandboxPolicy, RustError> {
    match ctx {
        CallContext::Agent { agent_id, .. } => fetch_for_agent(agent_id, db, cache).await,
        CallContext::Scheduler { job_id } => fetch_for_job(job_id, db, cache).await,
        // A workflow tool_call step supplies its own sandbox (set in
        // src/orchestration/step-runners.ts from the step's sandboxConfig),
        // since workflow_runs has no agent_id to resolve a policy from. When
        // present we honor it directly; when absent (older callers) fall back
        // to the most-restrictive User-style default.
        CallContext::Workflow { sandbox, .. } => match sandbox {
            Some(s) => Ok(SandboxPolicy {
                enabled: s.enabled,
                allowed_paths: s.allowed_paths.iter().map(PathBuf::from).collect(),
            }),
            None => Ok(SandboxPolicy::user_default()),
        },
        CallContext::User => Ok(SandboxPolicy::user_default()),
    }
}

async fn fetch_for_agent(
    agent_id: &str,
    db: &Db,
    cache: &PolicyCache,
) -> Result<SandboxPolicy, RustError> {
    let key = format!("agent:{}", agent_id);
    if let Some(p) = cache.get(&key) {
        return Ok(p);
    }
    let agent_id_owned = agent_id.to_string();
    let policy = db
        .with(move |conn| load_sandbox_from_db(conn, &agent_id_owned))
        .await?;
    cache.put(key, policy.clone());
    Ok(policy)
}

async fn fetch_for_job(
    job_id: &str,
    db: &Db,
    cache: &PolicyCache,
) -> Result<SandboxPolicy, RustError> {
    let key = format!("job:{}", job_id);
    if let Some(p) = cache.get(&key) {
        return Ok(p);
    }
    let job_id_owned = job_id.to_string();
    let agent_id: Option<String> = db
        .with(move |conn| {
            conn.query_row(
                "SELECT agent_id FROM scheduled_jobs WHERE id = ?",
                [job_id_owned.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| RustError::new("DB_ERROR", e.to_string(), true))
        })
        .await?;
    let agent_id = agent_id.ok_or_else(|| {
        RustError::new(
            "JOB_NOT_FOUND",
            format!("scheduled job {} not found", job_id),
            false,
        )
    })?;
    fetch_for_agent(&agent_id, db, cache).await
}

pub fn load_sandbox_from_db(conn: &Connection, agent_id: &str) -> Result<SandboxPolicy, RustError> {
    let config_json: Option<String> = conn
        .query_row(
            "SELECT config_json FROM agents WHERE id = ?",
            [agent_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| RustError::new("DB_ERROR", e.to_string(), true))?;

    let config_json = config_json.ok_or_else(|| {
        RustError::new(
            "AGENT_NOT_FOUND",
            format!("agent {} not found", agent_id),
            false,
        )
    })?;

    let parsed: serde_json::Value =
        serde_json::from_str(&config_json).unwrap_or(serde_json::Value::Null);
    let sb = parsed.get("sandboxConfig");

    let enabled = sb
        .and_then(|s| s.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let allowed_paths: Vec<PathBuf> = sb
        .and_then(|s| s.get("allowedPaths"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(PathBuf::from))
                .collect()
        })
        .unwrap_or_default();

    Ok(SandboxPolicy {
        enabled,
        allowed_paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db_with_agent(agent_id: &str, config_json: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, description TEXT, category TEXT, config_json TEXT NOT NULL, created_at TEXT, updated_at TEXT);"
        ).unwrap();
        conn.execute(
            "INSERT INTO agents (id, config_json) VALUES (?, ?)",
            (agent_id, config_json),
        ).unwrap();
        conn
    }

    #[test]
    fn loads_enabled_sandbox_from_config_json() {
        let conn = db_with_agent(
            "a1",
            r#"{"sandboxConfig":{"enabled":true,"allowedPaths":["/tmp/foo"]}}"#,
        );
        let policy = load_sandbox_from_db(&conn, "a1").unwrap();
        assert!(policy.enabled);
        assert_eq!(policy.allowed_paths.len(), 1);
        assert_eq!(policy.allowed_paths[0].to_string_lossy(), "/tmp/foo");
    }

    #[test]
    fn defaults_to_disabled_when_field_missing() {
        let conn = db_with_agent("a2", r#"{}"#);
        let policy = load_sandbox_from_db(&conn, "a2").unwrap();
        assert!(!policy.enabled);
        assert!(policy.allowed_paths.is_empty());
    }

    #[test]
    fn errors_when_agent_not_found() {
        let conn = db_with_agent("a3", r#"{}"#);
        let err = load_sandbox_from_db(&conn, "missing").unwrap_err();
        assert_eq!(err.code, "AGENT_NOT_FOUND");
    }
}
