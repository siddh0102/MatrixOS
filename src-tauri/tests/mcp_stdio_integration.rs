//! Integration test — spawns a Python echo process, exchanges a few lines,
//! disconnects, verifies the process exited cleanly. Cross-platform Python
//! lookup: python3 → python → py.exe (Windows fallback).

use matrixos_lib::mcp::stdio::{spawn_stdio, send_line, kill_running_stdio};
use matrixos_lib::mcp::types::McpInboundMessage;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn python_command() -> Option<String> {
    let candidates = if cfg!(windows) {
        vec!["python3", "python", "py.exe", "py"]
    } else {
        vec!["python3", "python"]
    };
    for name in candidates {
        if which::which(name).is_ok() {
            return Some(name.to_string());
        }
    }
    None
}

fn tmp_work_dir() -> PathBuf {
    let base = std::env::temp_dir();
    let dir = base.join(format!("matrixos-mcp-test-{}", nanoid::nanoid!()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn echo_roundtrip() {
    let Some(py) = python_command() else {
        eprintln!("Python not on PATH — skipping test");
        return;
    };
    let received = Arc::new(Mutex::new(Vec::<String>::new()));
    let received_clone = received.clone();
    let on_msg: Arc<dyn Fn(McpInboundMessage) + Send + Sync> = Arc::new(move |m| {
        if let McpInboundMessage::Rpc { message } = m {
            received_clone.lock().unwrap().push(message);
        }
    });
    let crash_cb: Arc<dyn Fn(Option<i32>) + Send + Sync> = Arc::new(|_| {});

    let args = vec![
        "-u".into(),
        "-c".into(),
        "import sys\nfor line in sys.stdin:\n    sys.stdout.write(line)\n    sys.stdout.flush()".into(),
    ];
    let env = HashMap::new();
    let work_dir = tmp_work_dir();
    let rs = spawn_stdio(&py, &args, &env, work_dir.clone(), on_msg, crash_cb).await.unwrap();

    send_line(&rs, "{\"hello\":1}".into()).await.unwrap();
    send_line(&rs, "{\"hello\":2}".into()).await.unwrap();

    tokio::time::sleep(Duration::from_millis(500)).await;

    let got = received.lock().unwrap().clone();
    assert!(got.iter().any(|m| m.contains("\"hello\":1")), "got: {:?}", got);
    assert!(got.iter().any(|m| m.contains("\"hello\":2")), "got: {:?}", got);

    kill_running_stdio(&rs).await;
    let _ = std::fs::remove_dir_all(work_dir);
}
