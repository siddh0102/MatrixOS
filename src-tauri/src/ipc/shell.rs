//! IPC for invoking a strictly-allowlisted set of shell commands. Used by
//! the `run_shell` built-in tool to give agents controlled access to local
//! interpreters (python, node, etc.) for runtime verification of generated
//! code. Designed conservatively:
//!   - The command is matched against a fixed allowlist of bare executable
//!     names. No paths, no shell-builtins, no `cmd /c`, no `bash -c`.
//!   - Arguments are passed as a separate Vec to `std::process::Command`,
//!     so the OS never goes through a shell interpreter — there is no path
//!     for metacharacter expansion (`;`, `&&`, backticks, `$()`).
//!   - The working directory MUST be supplied and is canonicalized; the
//!     command runs there.
//!   - A timeout is enforced via `tokio::time::timeout`; on expiry the
//!     child is killed.
//!   - Stdout and stderr are each capped at MAX_OUTPUT_BYTES to keep a
//!     runaway process from filling memory.
//!
//! This is intentionally NOT a general-purpose shell. Adding to the
//! allowlist below should be a deliberate code change.

use crate::providers::error::RustError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

const ALLOWED_COMMANDS: &[&str] = &[
    // Interpreters / package managers
    "python", "python3", "py", "pip", "pip3", "pytest", "node", "npm", "npx",
    // Source control
    "git",
    // POSIX file ops (work on macOS/Linux; on Windows users need
    // Git-for-Windows' usr/bin/ on PATH or equivalent).
    "ls", "cat", "mkdir", "mv", "rm", "cp", "find",
    // Code search (ripgrep)
    "rg",
];
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 300_000;

#[derive(Debug, Serialize)]
pub struct ShellResult {
    /// Process exit code. `null` if the process was killed by the timeout.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// Whether either stream was truncated to MAX_OUTPUT_BYTES.
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u64,
    pub timed_out: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellRunArgs {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub timeout_ms: Option<u64>,
    pub stdin: Option<String>,
}

#[tauri::command]
pub async fn shell_run(args: ShellRunArgs) -> Result<ShellResult, RustError> {
    if !ALLOWED_COMMANDS.contains(&args.command.as_str()) {
        return Err(RustError::new(
            "SHELL_COMMAND_NOT_ALLOWED",
            format!(
                "Command '{}' is not in the allowlist. Permitted: {}",
                args.command,
                ALLOWED_COMMANDS.join(", ")
            ),
            false,
        ));
    }

    let cwd_path = PathBuf::from(&args.cwd);
    let cwd_canonical = cwd_path.canonicalize().map_err(|e| {
        RustError::new(
            "SHELL_CWD_INVALID",
            format!("cwd '{}' could not be resolved: {}", args.cwd, e),
            false,
        )
    })?;
    if !cwd_canonical.is_dir() {
        return Err(RustError::new(
            "SHELL_CWD_NOT_DIR",
            format!("cwd '{}' is not a directory", cwd_canonical.display()),
            false,
        ));
    }

    let timeout_ms = args
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_TIMEOUT_MS);

    let start = std::time::Instant::now();
    let mut cmd = Command::new(&args.command);
    cmd.args(&args.args)
        .current_dir(&cwd_canonical)
        .stdin(if args.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        RustError::new(
            "SHELL_SPAWN_FAILED",
            format!("Failed to spawn '{}': {}", args.command, e),
            false,
        )
    })?;

    if let Some(stdin_data) = args.stdin.as_deref() {
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(stdin_data.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
    }

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let exec = async {
        // Drain stdout and stderr concurrently with the wait so a process
        // that fills the OS pipe buffer doesn't deadlock.
        let stdout_task = async {
            if let Some(ref mut s) = stdout_pipe {
                let mut buf = Vec::with_capacity(8192);
                let _ = s.read_to_end(&mut buf).await;
                buf
            } else {
                Vec::new()
            }
        };
        let stderr_task = async {
            if let Some(ref mut s) = stderr_pipe {
                let mut buf = Vec::with_capacity(8192);
                let _ = s.read_to_end(&mut buf).await;
                buf
            } else {
                Vec::new()
            }
        };
        let (stdout_bytes, stderr_bytes, wait_result) =
            tokio::join!(stdout_task, stderr_task, child.wait());
        (stdout_bytes, stderr_bytes, wait_result)
    };

    match timeout(Duration::from_millis(timeout_ms), exec).await {
        Ok((stdout_bytes, stderr_bytes, wait_result)) => {
            let status = wait_result.map_err(|e| {
                RustError::new(
                    "SHELL_WAIT_FAILED",
                    format!("Failed waiting for child: {}", e),
                    false,
                )
            })?;
            let (stdout, stdout_truncated) = clamp_to_string(stdout_bytes);
            let (stderr, stderr_truncated) = clamp_to_string(stderr_bytes);
            Ok(ShellResult {
                exit_code: status.code(),
                stdout,
                stderr,
                stdout_truncated,
                stderr_truncated,
                duration_ms: start.elapsed().as_millis() as u64,
                timed_out: false,
            })
        }
        Err(_) => Ok(ShellResult {
            exit_code: None,
            stdout: String::new(),
            stderr: format!("Command exceeded {}ms timeout and was killed.", timeout_ms),
            stdout_truncated: false,
            stderr_truncated: false,
            duration_ms: timeout_ms,
            timed_out: true,
        }),
    }
}

fn clamp_to_string(bytes: Vec<u8>) -> (String, bool) {
    let truncated = bytes.len() > MAX_OUTPUT_BYTES;
    let slice = if truncated {
        &bytes[..MAX_OUTPUT_BYTES]
    } else {
        &bytes[..]
    };
    (String::from_utf8_lossy(slice).into_owned(), truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_disallowed_command() {
        // Use a command that should never appear on the allowlist.
        let args = ShellRunArgs {
            command: "sh".into(),
            args: vec!["-c".into(), "echo hi".into()],
            cwd: ".".into(),
            timeout_ms: None,
            stdin: None,
        };
        let result = shell_run(args).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, "SHELL_COMMAND_NOT_ALLOWED");
    }

    #[tokio::test]
    async fn rejects_invalid_cwd() {
        let args = ShellRunArgs {
            command: "python".into(),
            args: vec!["-c".into(), "print(1)".into()],
            cwd: "/path/that/does/not/exist/xyzzy".into(),
            timeout_ms: None,
            stdin: None,
        };
        let result = shell_run(args).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, "SHELL_CWD_INVALID");
    }
}
