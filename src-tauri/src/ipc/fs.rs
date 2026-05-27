use crate::db::Db;
use crate::fs::policy::{resolve_policy, PolicyCache};
use crate::fs::types::{DirEntry, SandboxPolicy};
use crate::fs::user_paths::UserPaths;
use crate::fs::validation::validate_path;
use crate::providers::error::RustError;
use crate::providers::registry::{CancelGuard, Registry};
use crate::providers::types::CallContext;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

async fn policy_for(
    ctx: &CallContext,
    db: &Arc<Db>,
    cache: &PolicyCache,
    user_paths: &UserPaths,
    path: &Path,
) -> Result<SandboxPolicy, RustError> {
    if matches!(ctx, CallContext::User) {
        if user_paths.contains(path) {
            // Bypass-policy: containment was already proven by UserPaths::contains.
            return Ok(SandboxPolicy { enabled: false, allowed_paths: vec![] });
        }
        crate::fs::audit::audit_hook(db, &crate::fs::audit::AuditEvent {
            kind: crate::fs::audit::AuditKind::UserPathNotRegistered,
            ctx: ctx.clone(),
            path_or_url: path.display().to_string(),
            extra: serde_json::json!({}),
        }).await;
        return Err(RustError::new(
            "USER_PATH_NOT_REGISTERED",
            format!("Path \"{}\" was not registered via a user dialog", path.display()),
            false,
        ));
    }
    resolve_policy(ctx, db.as_ref(), cache).await
}

#[tauri::command]
pub async fn fs_read(
    ctx: CallContext,
    path: String,
    db: State<'_, Arc<Db>>,
    cache: State<'_, Arc<PolicyCache>>,
    user_paths: State<'_, Arc<UserPaths>>,
) -> Result<String, RustError> {
    let requested = PathBuf::from(&path);
    let policy = policy_for(&ctx, &db, &cache, &user_paths, &requested).await?;
    let canonical = validate_path(&db, &ctx, &requested, &policy).await?;
    std::fs::read_to_string(&canonical)
        .map_err(|e| RustError::new("FS_IO_ERROR", e.to_string(), false))
}

#[tauri::command]
pub async fn fs_write(
    ctx: CallContext,
    path: String,
    contents: String,
    db: State<'_, Arc<Db>>,
    cache: State<'_, Arc<PolicyCache>>,
    user_paths: State<'_, Arc<UserPaths>>,
) -> Result<u64, RustError> {
    let t = std::time::Instant::now();
    eprintln!("[rust:fs_write] enter ctx={:?} path={} bytes={}", ctx, path, contents.len());
    let requested = PathBuf::from(&path);
    let policy = match policy_for(&ctx, &db, &cache, &user_paths, &requested).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[rust:fs_write] policy_for FAILED code={} msg={} path={}", e.code, e.message, path);
            return Err(e);
        }
    };
    eprintln!(
        "[rust:fs_write] policy_for_ok enabled={} roots={}",
        policy.enabled,
        policy.allowed_paths.len(),
    );
    let canonical = match validate_path(&db, &ctx, &requested, &policy).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[rust:fs_write] validate_path FAILED code={} msg={} path={}", e.code, e.message, path);
            return Err(e);
        }
    };
    eprintln!("[rust:fs_write] validate_ok canonical={}", canonical.display());
    if let Some(parent) = canonical.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("[rust:fs_write] create_dir_all FAILED parent={} err={}", parent.display(), e);
                return Err(RustError::new("FS_IO_ERROR", e.to_string(), false));
            }
        }
    }
    if let Err(e) = std::fs::write(&canonical, contents.as_bytes()) {
        eprintln!("[rust:fs_write] write FAILED path={} err={}", canonical.display(), e);
        return Err(RustError::new("FS_IO_ERROR", e.to_string(), false));
    }
    eprintln!(
        "[rust:fs_write] exit bytes={} t_ms={} path={}",
        contents.len(),
        t.elapsed().as_millis(),
        canonical.display(),
    );
    Ok(contents.len() as u64)
}

#[tauri::command]
pub async fn fs_list(
    ctx: CallContext,
    path: String,
    db: State<'_, Arc<Db>>,
    cache: State<'_, Arc<PolicyCache>>,
    user_paths: State<'_, Arc<UserPaths>>,
) -> Result<Vec<DirEntry>, RustError> {
    let requested = PathBuf::from(&path);
    let policy = policy_for(&ctx, &db, &cache, &user_paths, &requested).await?;
    let canonical = validate_path(&db, &ctx, &requested, &policy).await?;

    let read = std::fs::read_dir(&canonical)
        .map_err(|e| RustError::new("FS_IO_ERROR", e.to_string(), false))?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Ok(meta) = entry.metadata() {
            entries.push(DirEntry {
                name,
                is_dir: meta.is_dir(),
                size: if meta.is_dir() { 0 } else { meta.len() },
            });
        }
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
pub fn fs_register_user_path(
    ctx: CallContext,
    path: String,
    user_paths: State<'_, Arc<UserPaths>>,
) -> Result<(), RustError> {
    if !matches!(ctx, CallContext::User) {
        return Err(RustError::new(
            "USER_CONTEXT_REQUIRED",
            "fs_register_user_path is only callable from User context",
            false,
        ));
    }
    user_paths.register(PathBuf::from(path))
}

#[tauri::command]
pub async fn web_fetch(
    ctx: CallContext,
    url: String,
    request_id: String,
    reg: State<'_, Arc<Registry>>,
    db: State<'_, Arc<Db>>,
    cache: State<'_, Arc<PolicyCache>>,
) -> Result<crate::fs::types::WebFetchResponse, RustError> {
    let allow_private = resolve_allow_private(&ctx, &db, &cache).await?;
    let token = reg.register_in_flight(&request_id)?;
    let _guard = CancelGuard::new(&reg, request_id.clone());
    crate::fs::web::web_fetch(&db, &ctx, &url, allow_private, token).await
}

#[tauri::command]
pub fn web_cancel(reg: State<'_, Arc<Registry>>, request_id: String) -> Result<(), RustError> {
    reg.cancel(&request_id);
    Ok(())
}

async fn resolve_allow_private(
    ctx: &CallContext,
    db: &Db,
    cache: &PolicyCache,
) -> Result<bool, RustError> {
    let _ = cache; // cache currently scoped to sandbox only

    let agent_id: Option<String> = match ctx {
        CallContext::Agent { agent_id, .. } => Some(agent_id.clone()),
        CallContext::Scheduler { job_id } => {
            let job_id = job_id.clone();
            db.with(move |conn| {
                conn.query_row(
                    "SELECT agent_id FROM scheduled_jobs WHERE id = ?",
                    [job_id.as_str()],
                    |row| row.get::<_, String>(0),
                ).ok()
            }).await
        }
        // workflow_runs has no agent_id column; workflows reference per-step agents
        // in definition_json. Until CallContext::Workflow carries the current step's
        // agent_id (Phase C follow-up), default to most-restrictive: allow_private=false.
        CallContext::Workflow { .. } => return Ok(false),
        CallContext::User => return Ok(true), // user-initiated, no agent gate
    };

    let Some(agent_id) = agent_id else { return Ok(false); };

    let allow: bool = db.with(move |conn| {
        let cj: Option<String> = conn.query_row(
            "SELECT config_json FROM agents WHERE id = ?",
            [&agent_id],
            |row| row.get(0),
        ).ok();
        cj.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
          .and_then(|v| v.get("webPolicy").and_then(|w| w.get("allowPrivate")).and_then(|b| b.as_bool()))
          .unwrap_or(false)
    }).await;
    Ok(allow)
}
