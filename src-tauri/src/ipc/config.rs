use crate::audit::{append_audit_in_txn, map_db_err, AuditEntry};
use crate::db::Db;
use crate::fs::policy::PolicyCache;
use crate::providers::error::RustError;
use crate::providers::rate_limit::RateLimiter;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxConfigUpdate {
    pub enabled: bool,
    pub allowed_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitsUpdate {
    pub requests_per_minute: Option<u32>,
    pub max_tokens_per_day: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigUpdate {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub enabled: Option<bool>,
    pub default_model_id: Option<String>,
    /// Discovered model list (from Test Connection on server-discovered
    /// providers). Stored inside config_json. When omitted, the existing
    /// persisted list is left untouched.
    pub models: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn agent_set_sandbox(
    db: State<'_, Arc<Db>>,
    cache: State<'_, Arc<PolicyCache>>,
    agent_id: String,
    sandbox: SandboxConfigUpdate,
) -> Result<(), RustError> {
    let aid = agent_id.clone();
    let patch = serde_json::json!({ "sandboxConfig": sandbox });
    let entry = AuditEntry {
        event_type: "agent.sandbox_updated".into(),
        actor: "user".into(),
        target_type: Some("agent".into()),
        target_id: Some(agent_id.clone()),
        details: None,
    };

    db.with(move |conn| -> Result<(), RustError> {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        merge_agent_config(&tx, &aid, &patch)?;
        append_audit_in_txn(&tx, &entry)?;
        tx.commit().map_err(map_db_err)
    })
    .await?;

    cache.invalidate(&format!("agent:{}", agent_id));
    Ok(())
}

#[tauri::command]
pub async fn agent_set_rate_limits(
    db: State<'_, Arc<Db>>,
    agent_id: String,
    limits: RateLimitsUpdate,
) -> Result<(), RustError> {
    let aid = agent_id.clone();
    let patch = serde_json::json!({ "rateLimits": limits });
    let entry = AuditEntry {
        event_type: "agent.rate_limits_updated".into(),
        actor: "user".into(),
        target_type: Some("agent".into()),
        target_id: Some(agent_id),
        details: None,
    };

    db.with(move |conn| -> Result<(), RustError> {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        merge_agent_config(&tx, &aid, &patch)?;
        append_audit_in_txn(&tx, &entry)?;
        tx.commit().map_err(map_db_err)
    })
    .await
}

#[tauri::command]
pub async fn provider_set_config(
    db: State<'_, Arc<Db>>,
    rl: State<'_, Arc<RateLimiter>>,
    provider_id: String,
    config: ProviderConfigUpdate,
) -> Result<(), RustError> {
    let pid = provider_id.clone();
    let entry = AuditEntry {
        event_type: "provider.config_updated".into(),
        actor: "user".into(),
        target_type: Some("provider".into()),
        target_id: Some(provider_id.clone()),
        details: None,
    };

    // Drop any cached rate-limit entry for this provider so a fresh value
    // is loaded from SQL on the next call. Without this, rate-limit edits
    // would take up to LIMIT_CACHE_TTL (5s) to apply. Cheap and idempotent
    // — call it regardless of whether the rate-limit fields were touched
    // (the cost is one DashMap remove + one SQL re-read on the next call).
    rl.invalidate_provider(&provider_id);

    db.with(move |conn| -> Result<(), RustError> {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;

        // Top-level columns first.
        let mut sets: Vec<&str> = Vec::new();
        let mut binds: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(ref name) = config.name {
            sets.push("name = ?");
            binds.push(name.clone().into());
        }
        if let Some(ref base_url) = config.base_url {
            sets.push("base_url = ?");
            binds.push(base_url.clone().into());
        }
        if let Some(enabled) = config.enabled {
            sets.push("enabled = ?");
            binds.push((if enabled { 1i64 } else { 0i64 }).into());
        }

        // defaultModelId and models live inside config_json — read-modify-write
        // inside the txn so a Test Connection that discovers models persists
        // them (without this, the model list is lost on restart and the agent
        // editor dropdown is empty until the user re-tests the connection).
        if config.default_model_id.is_some() || config.models.is_some() {
            let current_blob: Option<String> = tx
                .query_row(
                    "SELECT config_json FROM provider_configs WHERE id = ?",
                    [&pid],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_db_err)?;
            let mut current: serde_json::Value = current_blob
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            if let Some(obj) = current.as_object_mut() {
                if let Some(ref dm) = config.default_model_id {
                    obj.insert("defaultModelId".into(), serde_json::json!(dm));
                }
                if let Some(ref models) = config.models {
                    obj.insert("models".into(), models.clone());
                }
            }
            sets.push("config_json = ?");
            binds.push(current.to_string().into());
        }

        if !sets.is_empty() {
            let sql = format!(
                "UPDATE provider_configs SET {}, updated_at = datetime('now') WHERE id = ?",
                sets.join(", ")
            );
            binds.push(pid.clone().into());
            let params_refs: Vec<&dyn rusqlite::ToSql> =
                binds.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
            tx.execute(&sql, &params_refs[..]).map_err(map_db_err)?;
        }

        append_audit_in_txn(&tx, &entry)?;
        tx.commit().map_err(map_db_err)
    })
    .await
}

/// Shallow-merge `patch` into the top level of `agents.config_json` for `agent_id`,
/// using the caller's open transaction. Errors if the agent does not exist.
fn merge_agent_config(
    tx: &rusqlite::Transaction<'_>,
    agent_id: &str,
    patch: &serde_json::Value,
) -> Result<(), RustError> {
    let existing: Option<String> = tx
        .query_row(
            "SELECT config_json FROM agents WHERE id = ?",
            [agent_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_db_err)?;

    let mut current: serde_json::Value = existing
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    if let (Some(obj), Some(p)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            obj.insert(k.clone(), v.clone());
        }
    }

    let serialized = current.to_string();
    let changed = tx
        .execute(
            "UPDATE agents SET config_json = ?, updated_at = datetime('now') WHERE id = ?",
            params![serialized, agent_id],
        )
        .map_err(map_db_err)?;

    if changed == 0 {
        return Err(RustError::new(
            "AGENT_NOT_FOUND",
            format!("agent {} does not exist", agent_id),
            false,
        ));
    }
    Ok(())
}
