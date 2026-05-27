//! IPC for reading bundled resources shipped with the app binary
//! (e.g. seed JSON for the agent template / skill libraries). These files
//! are read-only at runtime — the frontend pulls them once at startup,
//! seeds the DB, then never touches them again. Distinct from `fs::fs_read`,
//! which is policy-gated and only allows access to user-allowed paths.

use crate::providers::error::RustError;
use tauri::Manager;

/// Read a bundled resource file by its relative path under the app's
/// resource directory. Validates that the resolved path stays inside the
/// resource directory after canonicalization to prevent path-traversal
/// (`..`-based) escapes.
#[tauri::command]
pub async fn load_bundled_resource(
    app: tauri::AppHandle,
    name: String,
) -> Result<String, RustError> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| RustError::new("RESOURCE_DIR_UNAVAILABLE", e.to_string(), false))?;
    let requested = resource_dir.join(&name);
    // Canonicalize both sides and verify containment. Using canonicalize
    // forces the OS to resolve symlinks and `..` segments before we compare.
    let canonical_root = resource_dir
        .canonicalize()
        .map_err(|e| RustError::new("RESOURCE_DIR_INVALID", e.to_string(), false))?;
    let canonical = requested
        .canonicalize()
        .map_err(|e| RustError::new("RESOURCE_NOT_FOUND", format!("{}: {}", name, e), false))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(RustError::new(
            "RESOURCE_PATH_ESCAPE",
            format!("Refusing to read resource outside bundle root: {}", name),
            false,
        ));
    }
    std::fs::read_to_string(&canonical)
        .map_err(|e| RustError::new("RESOURCE_IO_ERROR", e.to_string(), false))
}
