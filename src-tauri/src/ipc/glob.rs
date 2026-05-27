//! IPC for filename glob walks. Backs the `glob` built-in tool.
//!
//! Why not just `globwalk::glob(pattern)`? The crate's helper resolves
//! patterns against the *process* current working directory, which is
//! the app install dir for a Tauri binary. Agents need to glob from
//! their own workspace, so we accept an explicit `base_dir` and pass it
//! to GlobWalkerBuilder.
//!
//! Hard cap on the number of returned paths so a pathologically broad
//! pattern (`**/*`) on a huge tree can't OOM the renderer.

use crate::providers::error::RustError;
use serde::{Deserialize, Serialize};

const DEFAULT_MAX_RESULTS: usize = 1000;
const HARD_MAX_RESULTS: usize = 10_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobArgs {
    pub pattern: String,
    pub base_dir: String,
    pub max_results: Option<usize>,
    pub include_dirs: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct GlobResult {
    pub matches: Vec<String>,
    pub truncated: bool,
    pub base_dir: String,
}

#[tauri::command]
pub async fn fs_glob(args: GlobArgs) -> Result<GlobResult, RustError> {
    if args.pattern.is_empty() {
        return Err(RustError::new(
            "GLOB_PATTERN_EMPTY",
            "pattern must be non-empty",
            false,
        ));
    }
    if args.base_dir.is_empty() {
        return Err(RustError::new(
            "GLOB_BASE_DIR_EMPTY",
            "base_dir must be non-empty (use the project root)",
            false,
        ));
    }

    let max = args
        .max_results
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .min(HARD_MAX_RESULTS);
    let include_dirs = args.include_dirs.unwrap_or(false);

    let base_canon = std::fs::canonicalize(&args.base_dir).map_err(|e| {
        RustError::new(
            "GLOB_BASE_DIR_INVALID",
            format!("base_dir '{}' could not be resolved: {}", args.base_dir, e),
            false,
        )
    })?;
    if !base_canon.is_dir() {
        return Err(RustError::new(
            "GLOB_BASE_DIR_NOT_DIR",
            format!("base_dir '{}' is not a directory", base_canon.display()),
            false,
        ));
    }

    let walker = globwalk::GlobWalkerBuilder::from_patterns(&base_canon, &[&args.pattern])
        .max_depth(64)
        .follow_links(false)
        .build()
        .map_err(|e| {
            RustError::new(
                "GLOB_PATTERN_INVALID",
                format!("Invalid glob pattern '{}': {}", args.pattern, e),
                false,
            )
        })?;

    let mut matches: Vec<String> = Vec::new();
    let mut truncated = false;
    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // skip unreadable entries silently
        };
        if !include_dirs && entry.file_type().is_dir() {
            continue;
        }
        if matches.len() >= max {
            truncated = true;
            break;
        }
        matches.push(entry.path().to_string_lossy().into_owned());
    }
    matches.sort();

    Ok(GlobResult {
        matches,
        truncated,
        base_dir: base_canon.to_string_lossy().into_owned(),
    })
}
