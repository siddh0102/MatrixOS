use crate::audit::{append_audit, append_audit_in_txn, map_db_err, AuditEntry};
use crate::db::Db;
use crate::mcp::ctx_to_actor;
use crate::mcp::registry::{McpCancelGuard, McpRegistry, Transport};
use crate::mcp::stdio::{self, kill_running_stdio};
use crate::mcp::{http, types::*};
use crate::providers::error::RustError;
use crate::providers::types::CallContext;
use rusqlite::params;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

// ── Startup hydration ──

/// Load every row in `mcp_servers` into the in-memory `McpRegistry`.
/// Called once on app startup, before any `mcp_spawn` can fire. Without this,
/// the renderer's `mcpManager.loadAndStartAll` would hit `MCP_SERVER_UNKNOWN`
/// for every persisted server because the registry is in-memory only and
/// starts empty on every launch. No audit emission (system-level state load,
/// not a user action) and no SQL write — purely a read-and-populate.
#[tauri::command]
pub async fn mcp_hydrate_from_db(
    db: State<'_, Arc<Db>>,
    reg: State<'_, Arc<McpRegistry>>,
) -> Result<usize, RustError> {
    let rows: Vec<String> = db
        .with(|conn| -> Result<Vec<String>, RustError> {
            let mut stmt = conn
                .prepare("SELECT transport_json FROM mcp_servers")
                .map_err(map_db_err)?;
            let iter = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(map_db_err)?;
            let mut out = Vec::new();
            for row in iter {
                out.push(row.map_err(map_db_err)?);
            }
            Ok(out)
        })
        .await?;

    let mut loaded = 0usize;
    for json in rows {
        match serde_json::from_str::<McpServerConfig>(&json) {
            Ok(cfg) => {
                reg.upsert_config(cfg).await;
                loaded += 1;
            }
            Err(e) => {
                eprintln!("[mcp_hydrate_from_db] skipping malformed transport_json: {e}");
            }
        }
    }
    Ok(loaded)
}

// ── Config writes (Tier-B: data + audit in one transaction) ──

#[tauri::command]
pub async fn mcp_set_server_config(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    reg: State<'_, Arc<McpRegistry>>,
    config: McpServerConfig,
    ctx: CallContext,
) -> Result<(), RustError> {
    // Synchronous validation before any DB lock.
    match &config {
        McpServerConfig::Stdio { command, .. } if command.is_empty() => {
            return Err(RustError::new("MCP_CONFIG_INVALID", "command path required", false));
        }
        McpServerConfig::Http { base_url, .. } => {
            url::Url::parse(base_url)
                .map_err(|e| RustError::new("MCP_CONFIG_INVALID", e.to_string(), false))?;
        }
        _ => {}
    }

    // If a server with this id is currently running, refuse — caller must stop first.
    let id = config.id().to_string();
    if let Some(entry) = reg.get(&id) {
        if entry.transport.lock().await.is_some() {
            return Err(RustError::new("MCP_CONFIG_LOCKED",
                "server is running; stop it before reconfiguring", false));
        }
    }

    // Determine added vs updated by checking SQL row existence.
    let id_for_sql = id.clone();
    let existed: bool = db.with(move |conn| -> Result<bool, RustError> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mcp_servers WHERE id = ?",
            params![id_for_sql],
            |r| r.get(0),
        ).map_err(map_db_err)?;
        Ok(count > 0)
    }).await?;

    let event_type = if existed { "mcp.server_updated" } else { "mcp.server_added" };
    let actor = ctx_to_actor(&ctx);
    let cfg_json = serde_json::to_string(&config)
        .map_err(|e| RustError::new("MCP_CONFIG_INVALID", e.to_string(), false))?;
    let name = config.name().to_string();
    let entry = AuditEntry {
        event_type: event_type.into(),
        actor,
        target_type: Some("mcp_server".into()),
        target_id: Some(id.clone()),
        details: Some(serde_json::json!({ "name": name })),
    };

    let id_for_tx = id.clone();
    let cfg_json_for_tx = cfg_json.clone();
    db.with(move |conn| -> Result<(), RustError> {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        tx.execute(
            "INSERT INTO mcp_servers (id, name, transport_json, enabled, created_at, updated_at)
               VALUES (?, ?, ?, 1, COALESCE((SELECT created_at FROM mcp_servers WHERE id = ?), datetime('now')), datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               transport_json = excluded.transport_json,
               updated_at = datetime('now')",
            params![id_for_tx, name, cfg_json_for_tx, id_for_tx],
        ).map_err(map_db_err)?;
        append_audit_in_txn(&tx, &entry)?;
        tx.commit().map_err(map_db_err)
    }).await?;

    // Only update in-memory registry after the DB write commits.
    reg.upsert_config(config).await;
    let _ = app; // app held for future event emission hooks
    Ok(())
}

#[tauri::command]
pub async fn mcp_remove_server_config(
    db: State<'_, Arc<Db>>,
    reg: State<'_, Arc<McpRegistry>>,
    server_id: String,
    ctx: CallContext,
) -> Result<(), RustError> {
    if let Some(entry) = reg.get(&server_id) {
        if entry.transport.lock().await.is_some() {
            return Err(RustError::new("MCP_CONFIG_LOCKED",
                "server is running; stop it before removing", false));
        }
    }

    let actor = ctx_to_actor(&ctx);
    let id_for_tx = server_id.clone();
    let entry = AuditEntry {
        event_type: "mcp.server_removed".into(),
        actor,
        target_type: Some("mcp_server".into()),
        target_id: Some(server_id.clone()),
        details: None,
    };
    db.with(move |conn| -> Result<(), RustError> {
        let tx = conn.unchecked_transaction().map_err(map_db_err)?;
        tx.execute("DELETE FROM mcp_servers WHERE id = ?", params![id_for_tx])
            .map_err(map_db_err)?;
        append_audit_in_txn(&tx, &entry)?;
        tx.commit().map_err(map_db_err)
    }).await?;

    reg.remove(&server_id);
    Ok(())
}

// ── Lifecycle ──

#[tauri::command]
pub async fn mcp_spawn(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    reg: State<'_, Arc<McpRegistry>>,
    server_id: String,
    ctx: CallContext,
) -> Result<(), RustError> {
    let entry = reg.get(&server_id).ok_or_else(|| RustError::new(
        "MCP_SERVER_UNKNOWN", format!("server {} not configured", server_id), false))?;

    // Per-server spawn lock — concurrent calls fail fast with MCP_ALREADY_SPAWNING.
    let spawning = entry.spawning.clone();
    let _spawn_guard = spawning.try_lock().map_err(|_| RustError::new(
        "MCP_ALREADY_SPAWNING", format!("spawn already in progress for {}", server_id), false))?;

    if entry.transport.lock().await.is_some() {
        return Err(RustError::new("MCP_ALREADY_RUNNING",
            format!("server {} already running", server_id), false));
    }

    *entry.status.lock().await = McpServerStatus::Starting;

    let cfg = entry.config.clone();
    match cfg {
        McpServerConfig::Stdio { command, args, env, .. } => {
            let work_dir = per_server_dir(&app, &server_id)?;

            // on_msg: per-line callback → registry broadcast.
            let reg_for_msg = Arc::clone(reg.inner());
            let id_for_msg = server_id.clone();
            let on_msg: Arc<dyn Fn(McpInboundMessage) + Send + Sync> = Arc::new(move |msg| {
                let reg = reg_for_msg.clone();
                let id = id_for_msg.clone();
                tokio::spawn(async move { reg.broadcast(&id, msg).await; });
            });

            // crash_cb: wait task → registry Crashed + system-audit row.
            let reg_for_crash = Arc::clone(reg.inner());
            let id_for_crash = server_id.clone();
            // Cloning Db state for use inside the static-lifetime callback —
            // .inner() yields &Arc<Db>; clone produces Arc<Db> we move in.
            let db_for_crash: Arc<Db> = Arc::clone(db.inner());
            let crash_cb: Arc<dyn Fn(Option<i32>) + Send + Sync> = Arc::new(move |exit_code| {
                let reg = reg_for_crash.clone();
                let id = id_for_crash.clone();
                let db = db_for_crash.clone();
                tokio::spawn(async move {
                    if let Some(entry) = reg.get(&id) {
                        *entry.status.lock().await = McpServerStatus::Crashed {
                            exit_code,
                            at: chrono::Utc::now().to_rfc3339(),
                        };
                        *entry.transport.lock().await = None;
                    }
                    let _ = append_audit(&db, &AuditEntry {
                        event_type: "mcp.server_crashed".into(),
                        actor: "system".into(),
                        target_type: Some("mcp_server".into()),
                        target_id: Some(id),
                        details: Some(serde_json::json!({ "exitCode": exit_code })),
                    }).await;
                });
            });

            let running = stdio::spawn_stdio(&command, &args, &env, work_dir, on_msg, crash_cb)
                .await
                .map_err(|e| {
                    // Reset status on spawn failure.
                    let reg = Arc::clone(reg.inner());
                    let id = server_id.clone();
                    tokio::spawn(async move {
                        if let Some(entry) = reg.get(&id) {
                            *entry.status.lock().await = McpServerStatus::Stopped;
                        }
                    });
                    e
                })?;
            let pid = running.pid;
            let started_at = running.started_at.clone();
            *entry.transport.lock().await = Some(Transport::Stdio(running));
            *entry.status.lock().await = McpServerStatus::RunningStdio { pid, started_at };
        }
        McpServerConfig::Http { .. } => {
            *entry.transport.lock().await = Some(Transport::Http);
            *entry.status.lock().await = McpServerStatus::RunningHttp {
                started_at: chrono::Utc::now().to_rfc3339(),
            };
        }
    }

    // Audit success.
    let _ = append_audit(&db, &AuditEntry {
        event_type: "mcp.server_started".into(),
        actor: ctx_to_actor(&ctx),
        target_type: Some("mcp_server".into()),
        target_id: Some(server_id),
        details: None,
    }).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_disconnect(
    db: State<'_, Arc<Db>>,
    reg: State<'_, Arc<McpRegistry>>,
    server_id: String,
    ctx: CallContext,
) -> Result<(), RustError> {
    let entry = reg.get(&server_id).ok_or_else(|| RustError::new(
        "MCP_SERVER_UNKNOWN", format!("server {} not configured", server_id), false))?;
    let transport = entry.transport.lock().await.take();
    match transport {
        Some(Transport::Stdio(rs)) => { kill_running_stdio(&rs).await; }
        Some(Transport::Http) => {}
        None => return Err(RustError::new("MCP_NOT_RUNNING",
            format!("server {} not running", server_id), false)),
    }
    *entry.status.lock().await = McpServerStatus::Stopped;

    let _ = append_audit(&db, &AuditEntry {
        event_type: "mcp.server_stopped".into(),
        actor: ctx_to_actor(&ctx),
        target_type: Some("mcp_server".into()),
        target_id: Some(server_id),
        details: None,
    }).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_send(
    reg: State<'_, Arc<McpRegistry>>,
    server_id: String,
    message: String,
    request_id: Option<String>,
) -> Result<Option<String>, RustError> {
    let entry = reg.get(&server_id).ok_or_else(|| RustError::new(
        "MCP_SERVER_UNKNOWN", format!("server {} not configured", server_id), false))?;
    let transport = entry.transport.lock().await;
    match &*transport {
        Some(Transport::Stdio(rs)) => {
            stdio::send_line(rs, message).await?;
            Ok(None) // stdio response arrives via broadcast
        }
        Some(Transport::Http) => {
            let McpServerConfig::Http { base_url, headers, allow_private, timeout_ms, .. } = &entry.config else {
                return Err(RustError::new("MCP_TRANSPORT_MISMATCH", "expected http config", false));
            };
            let token = match &request_id {
                Some(id) => reg.register_in_flight(id)?,
                None => tokio_util::sync::CancellationToken::new(),
            };
            let _guard = request_id.as_ref().map(|id| McpCancelGuard::new(&reg, id.clone()));
            let body = http::send(base_url, headers, &message, *allow_private, *timeout_ms, token).await?;
            Ok(Some(body))
        }
        None => Err(RustError::new("MCP_NOT_RUNNING",
            format!("server {} not running", server_id), false)),
    }
}

#[tauri::command]
pub async fn mcp_cancel(
    reg: State<'_, Arc<McpRegistry>>,
    request_id: String,
) -> Result<(), RustError> {
    reg.cancel(&request_id);
    Ok(())
}

#[tauri::command]
pub async fn mcp_subscribe(
    reg: State<'_, Arc<McpRegistry>>,
    server_id: String,
    on_message: Channel<McpInboundMessage>,
) -> Result<String, RustError> {
    reg.add_subscriber(&server_id, Arc::new(on_message)).await
}

#[tauri::command]
pub async fn mcp_unsubscribe(
    reg: State<'_, Arc<McpRegistry>>,
    server_id: String,
    subscription_id: String,
) -> Result<(), RustError> {
    reg.remove_subscriber(&server_id, &subscription_id).await
}

#[tauri::command]
pub async fn mcp_status(
    reg: State<'_, Arc<McpRegistry>>,
    server_id: String,
) -> Result<McpServerStatus, RustError> {
    reg.status(&server_id).await.ok_or_else(|| RustError::new(
        "MCP_SERVER_UNKNOWN", format!("server {} not configured", server_id), false))
}

fn per_server_dir(app: &AppHandle, server_id: &str) -> Result<PathBuf, RustError> {
    let base = app.path().app_data_dir()
        .map_err(|e| RustError::new("MCP_HYGIENE_FAILED", e.to_string(), false))?;
    let dir = base.join("mcp").join(server_id);
    Ok(dir)
}
