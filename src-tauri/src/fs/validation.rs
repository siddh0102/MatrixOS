use crate::db::Db;
use crate::fs::types::SandboxPolicy;
use crate::providers::error::RustError;
use crate::providers::types::CallContext;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Returns the canonicalized absolute path if it is inside the policy's
/// allowed roots (or if sandbox is disabled). For paths that don't yet exist
/// (file is about to be written), canonicalize the parent first then re-join.
pub async fn validate_path(
    db: &Arc<Db>,
    ctx: &CallContext,
    requested: &Path,
    policy: &SandboxPolicy,
) -> Result<PathBuf, RustError> {
    let canonical = canonicalize_or_parent(requested)
        .map_err(|e| RustError::new("FS_INVALID_PATH", e, false))?;

    if !policy.enabled {
        return Ok(canonical);
    }

    let inside = policy.allowed_paths.iter().any(|root| {
        match std::fs::canonicalize(root) {
            Ok(rc) => canonical.starts_with(&rc),
            Err(_) => false,
        }
    });

    if !inside {
        crate::fs::audit::audit_hook(db, &crate::fs::audit::AuditEvent {
            kind: crate::fs::audit::AuditKind::SandboxDenied,
            ctx: ctx.clone(),
            path_or_url: requested.display().to_string(),
            extra: serde_json::json!({}),
        }).await;
        return Err(RustError::new(
            "SANDBOX_DENIED",
            format!(
                "Sandbox: access denied. \"{}\" is outside the allowed directories.",
                requested.display()
            ),
            false,
        ));
    }
    Ok(canonical)
}

fn canonicalize_or_parent(p: &Path) -> Result<PathBuf, String> {
    crate::fs::path_utils::canonicalize_with_missing_tail(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::types::SandboxPolicy;
    use rusqlite::Connection;
    use std::fs;
    use std::path::PathBuf;

    fn test_db() -> Arc<Db> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/005_audit_log.sql")).unwrap();
        Arc::new(Db::from_connection(conn))
    }

    fn test_ctx() -> CallContext {
        CallContext::User
    }

    fn temp_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("matrixos_test_{}", uuid_like()));
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn uuid_like() -> String {
        format!("{}-{}", std::process::id(), std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
    }

    #[tokio::test]
    async fn allowed_path_inside_root_passes() {
        let root = temp_dir();
        let file = root.join("a.txt");
        fs::write(&file, "x").unwrap();
        let policy = SandboxPolicy { enabled: true, allowed_paths: vec![root.clone()] };
        let result = validate_path(&test_db(), &test_ctx(), &file, &policy).await;
        assert!(result.is_ok(), "{:?}", result);
        fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn dotdot_traversal_blocked() {
        let root = temp_dir();
        let outside = std::env::temp_dir();
        let traversal = root.join("..").join(outside.file_name().unwrap());
        let policy = SandboxPolicy { enabled: true, allowed_paths: vec![root.clone()] };
        let result = validate_path(&test_db(), &test_ctx(), &traversal, &policy).await;
        assert!(result.is_err(), "expected sandbox denial, got {:?}", result);
        fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn disabled_sandbox_allows_anywhere() {
        let policy = SandboxPolicy { enabled: false, allowed_paths: vec![] };
        let p = std::env::temp_dir();
        assert!(validate_path(&test_db(), &test_ctx(), &p, &policy).await.is_ok());
    }

    #[tokio::test]
    async fn nonexistent_file_in_existing_allowed_dir_passes() {
        let root = temp_dir();
        let new_file = root.join("newfile.txt");
        let policy = SandboxPolicy { enabled: true, allowed_paths: vec![root.clone()] };
        let result = validate_path(&test_db(), &test_ctx(), &new_file, &policy).await;
        assert!(result.is_ok(), "{:?}", result);
        fs::remove_dir_all(&root).ok();
    }

    // Windows-specific path normalization smoke test. canonicalize() expands
    // 8.3 short names, normalizes drive-letter case, and follows NTFS junctions.
    // We don't add prefix-stripping (`\\?\` removal); we trust canonicalize.
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn windows_drive_letter_case_matches() {
        let root = temp_dir();
        let file = root.join("a.txt");
        fs::write(&file, "x").unwrap();
        let policy = SandboxPolicy { enabled: true, allowed_paths: vec![root.clone()] };
        // Mixed-case probe should still match (both sides canonicalized).
        let upper = PathBuf::from(file.to_string_lossy().to_uppercase());
        assert!(validate_path(&test_db(), &test_ctx(), &file, &policy).await.is_ok());
        assert!(validate_path(&test_db(), &test_ctx(), &upper, &policy).await.is_ok());
        fs::remove_dir_all(&root).ok();
    }
}
