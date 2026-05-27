//! IPC for content search via ripgrep. Backs the `grep` built-in tool.
//!
//! Why subprocess ripgrep instead of the `grep` Rust crate? ripgrep is
//! battle-tested, handles .gitignore correctly, has fast Unicode + regex
//! engines, and most code agents will already have it installed. Adding
//! the crate dependencies (regex, grep-searcher, grep-matcher, walkdir,
//! ignore) to bundle our own would balloon the binary for no clear win.
//!
//! Requirement: `rg` on PATH. If missing, returns GREP_RG_NOT_FOUND with
//! install hints in the message.

use crate::providers::error::RustError;
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

const DEFAULT_MAX_MATCHES: usize = 200;
const HARD_MAX_MATCHES: usize = 2_000;
const TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepArgs {
    pub pattern: String,
    pub path: String,
    pub max_matches: Option<usize>,
    pub case_insensitive: Option<bool>,
    pub fixed_string: Option<bool>,
    /// Glob filter, e.g. "*.ts" or "!*.test.*". Maps to ripgrep's -g flag.
    pub glob: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GrepMatch {
    pub file: String,
    pub line_number: u64,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct GrepResult {
    pub matches: Vec<GrepMatch>,
    pub truncated: bool,
}

#[tauri::command]
pub async fn code_grep(args: GrepArgs) -> Result<GrepResult, RustError> {
    if args.pattern.is_empty() {
        return Err(RustError::new(
            "GREP_PATTERN_EMPTY",
            "pattern must be non-empty",
            false,
        ));
    }
    if args.path.is_empty() {
        return Err(RustError::new(
            "GREP_PATH_EMPTY",
            "path must be non-empty (file or directory to search)",
            false,
        ));
    }

    let path_canon = std::fs::canonicalize(&args.path).map_err(|e| {
        RustError::new(
            "GREP_PATH_INVALID",
            format!("path '{}' could not be resolved: {}", args.path, e),
            false,
        )
    })?;

    let max_matches = args
        .max_matches
        .unwrap_or(DEFAULT_MAX_MATCHES)
        .min(HARD_MAX_MATCHES);

    // We can't use --max-count for the global cap because that's per-file.
    // Use --max-columns to keep individual lines reasonable, and we'll cut
    // off ourselves on the parser side at `max_matches`.
    let mut cmd = Command::new("rg");
    cmd.arg("--json")
        .arg("--line-number")
        .arg("--no-heading")
        .arg("--max-columns")
        .arg("400");
    if args.case_insensitive.unwrap_or(false) {
        cmd.arg("-i");
    }
    if args.fixed_string.unwrap_or(false) {
        cmd.arg("-F");
    }
    if let Some(glob) = args.glob.as_deref() {
        if !glob.is_empty() {
            cmd.arg("-g").arg(glob);
        }
    }
    cmd.arg("--").arg(&args.pattern).arg(&path_canon);

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        // The most common error here is "rg not found on PATH".
        RustError::new(
            "GREP_RG_NOT_FOUND",
            format!(
                "Failed to spawn ripgrep ('rg'): {}. Install: https://github.com/BurntSushi/ripgrep#installation",
                e
            ),
            false,
        )
    })?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let exec = async {
        let stdout_task = async {
            let mut buf = Vec::with_capacity(16384);
            if let Some(ref mut s) = stdout_pipe {
                let _ = s.read_to_end(&mut buf).await;
            }
            buf
        };
        let stderr_task = async {
            let mut buf = Vec::with_capacity(2048);
            if let Some(ref mut s) = stderr_pipe {
                let _ = s.read_to_end(&mut buf).await;
            }
            buf
        };
        let (stdout_bytes, stderr_bytes, wait_result) =
            tokio::join!(stdout_task, stderr_task, child.wait());
        (stdout_bytes, stderr_bytes, wait_result)
    };

    let (stdout_bytes, stderr_bytes, wait_result) =
        match timeout(Duration::from_millis(TIMEOUT_MS), exec).await {
            Ok(v) => v,
            Err(_) => {
                return Err(RustError::new(
                    "GREP_TIMEOUT",
                    format!("ripgrep exceeded {}ms timeout", TIMEOUT_MS),
                    false,
                ));
            }
        };

    let status = wait_result.map_err(|e| {
        RustError::new(
            "GREP_WAIT_FAILED",
            format!("Failed waiting for ripgrep: {}", e),
            false,
        )
    })?;

    // ripgrep exit codes: 0 = matches found, 1 = no matches, 2 = error.
    let code = status.code().unwrap_or(-1);
    if code == 2 {
        let stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
        return Err(RustError::new(
            "GREP_FAILED",
            format!("ripgrep error: {}", stderr.trim()),
            false,
        ));
    }

    // Parse the --json stream. Each line is a JSON object with a type.
    // We only care about `match` lines.
    let stdout = String::from_utf8_lossy(&stdout_bytes);
    let mut matches: Vec<GrepMatch> = Vec::new();
    let mut truncated = false;
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }
        let data = match value.get("data") {
            Some(d) => d,
            None => continue,
        };
        let file_path = data
            .pointer("/path/text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let line_number = data
            .get("line_number")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let text = data
            .pointer("/lines/text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim_end_matches('\n')
            .to_string();
        if matches.len() >= max_matches {
            truncated = true;
            break;
        }
        matches.push(GrepMatch {
            file: file_path,
            line_number,
            text,
        });
    }

    Ok(GrepResult { matches, truncated })
}
