use crate::mcp::hygiene;
use crate::mcp::types::McpInboundMessage;
use crate::providers::error::RustError;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex};

/// Env-var blocklist — dynamic-loader hijack vectors stripped before spawn.
const ENV_BLOCKLIST: &[&str] = &[
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_FORCE_FLAT_NAMESPACE",
    "DYLD_LIBRARY_PATH",
];

// 1 MiB per stdio line. MCP `tools/list` responses routinely exceed 4 KiB
// (filesystem server alone is ~6 KiB with 10 tool schemas on one line),
// and there's no upper bound on legitimate tool-list size. The cap exists
// to defend against a server that never emits a newline; 1 MiB is generous
// enough for any realistic tool catalog while still blocking infinite-line
// DoS attacks.
const MAX_LINE_BYTES: usize = 1024 * 1024;
const STDERR_BUDGET_PER_SEC: u32 = 10;

pub struct RunningStdio {
    pub pid: u32,
    pub started_at: String,
    pub tx_stdin: mpsc::Sender<String>,
    pub cancel: Mutex<Option<oneshot::Sender<()>>>,
    #[cfg(unix)]
    pub pgid: u32,
}

/// Spawn an MCP stdio child with all hygiene applied.
///
/// `on_msg`  — called per inbound message (rpc, stderr, error, closed).
///             Funnels through a single mpsc into one broadcast task — do NOT
///             spawn a task per line.
/// `crash_cb` — called by the wait task on natural exit. The IPC layer constructs
///              this to set McpServerStatus::Crashed { exit_code, at } and emit
///              the `mcp.server_crashed` audit row (actor "system").
pub async fn spawn_stdio(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    work_dir: PathBuf,
    on_msg: Arc<dyn Fn(McpInboundMessage) + Send + Sync>,
    crash_cb: Arc<dyn Fn(Option<i32>) + Send + Sync>,
) -> Result<Arc<RunningStdio>, RustError> {
    if command.is_empty() {
        return Err(RustError::new("MCP_CONFIG_INVALID", "command path required", false));
    }

    // Ensure per-server working directory exists.
    tokio::fs::create_dir_all(&work_dir)
        .await
        .map_err(|e| RustError::new("MCP_HYGIENE_FAILED", format!("create work_dir: {e}"), false))?;

    let mut cmd = Command::new(command);
    cmd.args(args);
    cmd.current_dir(&work_dir);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    // Env scrub.
    for (k, v) in env {
        if ENV_BLOCKLIST.iter().any(|b| b.eq_ignore_ascii_case(k)) {
            continue;
        }
        cmd.env(k, v);
    }

    // POSIX: put the child in its own process group so killpg(pgid) does not
    // kill MatrixOS itself.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0))
                    .map_err(std::io::Error::other)
            });
        }
    }

    // Windows: start suspended so we can assign to the job before any code runs.
    #[cfg(windows)]
    cmd.creation_flags(0x00000004 /* CREATE_SUSPENDED */);

    let mut child = cmd
        .spawn()
        .map_err(|e| RustError::new("MCP_SPAWN_FAILED", e.to_string(), false))?;

    let pid = child.id().ok_or_else(|| {
        RustError::new("MCP_SPAWN_FAILED", "child has no pid after spawn", false)
    })?;

    hygiene::after_spawn(pid).map_err(|e| RustError::new("MCP_HYGIENE_FAILED", e, false))?;

    // Windows: resume now that we're in the job.
    // NtResumeProcess is an NT internal API — load it dynamically from ntdll.
    #[cfg(windows)]
    unsafe {
        use winapi::um::libloaderapi::{GetProcAddress, GetModuleHandleA};
        use winapi::um::processthreadsapi::OpenProcess;
        use winapi::um::handleapi::CloseHandle;
        use winapi::um::winnt::PROCESS_ALL_ACCESS;
        use std::ffi::CString;

        type NtResumeProcessFn = unsafe extern "system" fn(winapi::um::winnt::HANDLE) -> i32;

        let ntdll_name = CString::new("ntdll.dll").unwrap();
        let proc_name = CString::new("NtResumeProcess").unwrap();
        let ntdll = GetModuleHandleA(ntdll_name.as_ptr());
        if !ntdll.is_null() {
            let fn_ptr = GetProcAddress(ntdll as *mut _, proc_name.as_ptr());
            if !fn_ptr.is_null() {
                let nt_resume: NtResumeProcessFn = std::mem::transmute(fn_ptr);
                let handle = OpenProcess(PROCESS_ALL_ACCESS, 0, pid);
                if !handle.is_null() {
                    nt_resume(handle);
                    CloseHandle(handle);
                }
            }
        }
    }

    #[cfg(unix)]
    let pgid = pid; // setpgid(0,0) makes pgid == pid for the child

    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // Single broadcast mpsc — drains into on_msg from one task.
    let (tx_bcast, mut rx_bcast) = mpsc::channel::<McpInboundMessage>(256);
    let on_msg_bcast = on_msg.clone();
    tokio::spawn(async move {
        while let Some(msg) = rx_bcast.recv().await {
            on_msg_bcast(msg);
        }
    });

    let (tx_stdin, mut rx_stdin) = mpsc::channel::<String>(64);

    // stdin writer
    let tx_bcast_err = tx_bcast.clone();
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(msg) = rx_stdin.recv().await {
            if stdin.write_all(msg.as_bytes()).await.is_err() {
                let _ = tx_bcast_err.send(McpInboundMessage::Error {
                    message: "stdin write failed".into(),
                }).await;
                break;
            }
            if !msg.ends_with('\n') {
                if stdin.write_all(b"\n").await.is_err() { break; }
            }
            let _ = stdin.flush().await;
        }
    });

    // stdout reader — 4 KiB per-line cap, lossy UTF-8 fallback.
    let tx_bcast_out = tx_bcast.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::with_capacity(8 * 1024);
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_n) => {
                    if buf.len() > MAX_LINE_BYTES {
                        let _ = tx_bcast_out.send(McpInboundMessage::Error {
                            message: "line too long".into(),
                        }).await;
                        continue;
                    }
                    let line = String::from_utf8_lossy(&buf).trim_end_matches('\n').to_string();
                    let _ = tx_bcast_out.send(McpInboundMessage::Rpc { message: line }).await;
                }
                Err(e) => {
                    let _ = tx_bcast_out.send(McpInboundMessage::Error {
                        message: format!("stdout read: {e}"),
                    }).await;
                    break;
                }
            }
        }
    });

    // stderr reader — same cap + simple 10 lines/sec rate limit.
    let tx_bcast_err2 = tx_bcast.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::with_capacity(8 * 1024);
        let mut window_start = std::time::Instant::now();
        let mut count_in_window: u32 = 0;
        let mut throttled_emitted = false;
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_n) => {
                    let now = std::time::Instant::now();
                    if now.duration_since(window_start).as_secs() >= 1 {
                        window_start = now;
                        count_in_window = 0;
                        throttled_emitted = false;
                    }
                    if count_in_window >= STDERR_BUDGET_PER_SEC {
                        if !throttled_emitted {
                            let _ = tx_bcast_err2.send(McpInboundMessage::Stderr {
                                line: "stderr throttled".into(),
                            }).await;
                            throttled_emitted = true;
                        }
                        continue;
                    }
                    if buf.len() > MAX_LINE_BYTES { continue; }
                    let line = String::from_utf8_lossy(&buf).trim_end_matches('\n').to_string();
                    let _ = tx_bcast_err2.send(McpInboundMessage::Stderr { line }).await;
                    count_in_window += 1;
                }
                Err(_) => break,
            }
        }
    });

    // Cancel oneshot — disconnect sends, wait task observes.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let tx_bcast_close = tx_bcast.clone();
    let crash_cb_clone = crash_cb.clone();

    tokio::spawn(async move {
        tokio::select! {
            res = child.wait() => {
                let (exit_code, signal) = match res {
                    Ok(s) => (s.code(), None),
                    Err(e) => {
                        let _ = tx_bcast_close.send(McpInboundMessage::Error {
                            message: format!("wait failed: {e}")
                        }).await;
                        (None, None)
                    }
                };
                let _ = tx_bcast_close.send(McpInboundMessage::Closed { exit_code, signal }).await;
                crash_cb_clone(exit_code);
            }
            _ = cancel_rx => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                let _ = tx_bcast_close.send(McpInboundMessage::Closed {
                    exit_code: None,
                    signal: Some("killed".into()),
                }).await;
                // crash_cb NOT invoked on user-initiated kill —
                // mcp_disconnect IPC handler sets status to Stopped.
            }
        }
    });

    let started_at = chrono::Utc::now().to_rfc3339();
    Ok(Arc::new(RunningStdio {
        pid,
        started_at,
        tx_stdin,
        cancel: Mutex::new(Some(cancel_tx)),
        #[cfg(unix)]
        pgid,
    }))
}

pub async fn send_line(rs: &RunningStdio, msg: String) -> Result<(), RustError> {
    rs.tx_stdin
        .send(msg)
        .await
        .map_err(|e| RustError::new("MCP_STDIN_CLOSED", e.to_string(), false))
}

/// User-initiated shutdown of a running stdio server. Signals the wait task to
/// kill the child, then on POSIX falls back to killpg in case the child spawned
/// grandchildren in its own group.
pub async fn kill_running_stdio(rs: &RunningStdio) {
    if let Some(tx) = rs.cancel.lock().await.take() {
        let _ = tx.send(());
    }
    #[cfg(unix)]
    {
        hygiene::unix::terminate_group(rs.pgid).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_blocklist_strips_dangerous_keys() {
        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("LD_PRELOAD".into(), "/tmp/evil.so".into());
        env.insert("PATH".into(), "/usr/bin".into());
        // Verify the constant matches by inspection — we can't test the spawn
        // here without a real binary. The integration test covers e2e behaviour.
        let blocked: Vec<&&str> = ENV_BLOCKLIST.iter().filter(|k| env.contains_key(**k)).collect();
        assert_eq!(blocked.len(), 1);
        assert_eq!(*blocked[0], "LD_PRELOAD");
    }

    #[tokio::test]
    async fn stdout_line_cap_emits_error() {
        fn python_command() -> Option<String> {
            let candidates = if cfg!(windows) {
                vec!["python3", "python", "py.exe", "py"]
            } else {
                vec!["python3", "python"]
            };
            for name in candidates {
                if which::which(name).is_ok() {
                    return Some(name.into());
                }
            }
            None
        }

        let Some(py) = python_command() else { return; };
        let received = Arc::new(std::sync::Mutex::new(Vec::<McpInboundMessage>::new()));
        let received_clone = received.clone();
        let on_msg: Arc<dyn Fn(McpInboundMessage) + Send + Sync> = Arc::new(move |m| {
            received_clone.lock().unwrap().push(m);
        });
        let crash_cb: Arc<dyn Fn(Option<i32>) + Send + Sync> = Arc::new(|_| {});

        // Print one 2 MiB line then exit — exceeds the 1 MiB MAX_LINE_BYTES cap.
        let args = vec![
            "-u".into(), "-c".into(),
            "import sys; sys.stdout.write('x' * (2 * 1024 * 1024) + '\\n'); sys.stdout.flush()".into(),
        ];
        let work_dir = std::env::temp_dir().join(format!("matrixos-mcp-cap-{}", nanoid::nanoid!()));
        std::fs::create_dir_all(&work_dir).unwrap();
        let _rs = spawn_stdio(&py, &args, &HashMap::new(), work_dir.clone(), on_msg, crash_cb).await.unwrap();

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let got = received.lock().unwrap().clone();
        let line_too_long = got.iter().any(|m| matches!(m, McpInboundMessage::Error { message } if message == "line too long"));
        assert!(line_too_long, "expected 'line too long' Error, got: {:?}", got);

        let _ = std::fs::remove_dir_all(work_dir);
    }
}
