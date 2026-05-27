//! On-error diagnostic dumps for LLM streaming. When a stream fails
//! mid-flight (the cryptic reqwest "error decoding response body"), the
//! top-level message hides the real cause. This module captures the full
//! picture — request, response headers, the raw bytes received before the
//! failure, and the complete error source chain — into a file so the
//! failure can be classified (genuine connection drop vs. the provider
//! streaming back an error page / non-SSE body / compressed body).
//!
//! Dumps are written to `<app_data_dir>/debug-dumps/`. The directory is
//! captured once at startup via `set_dump_dir` (the provider layer has no
//! AppHandle of its own).

use std::path::PathBuf;
use std::sync::OnceLock;

static DUMP_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called once from the Tauri setup hook with `<app_data_dir>/debug-dumps`.
pub fn set_dump_dir(dir: PathBuf) {
    let _ = DUMP_DIR.set(dir);
}

/// Walk a std::error::Error's `source()` chain into a numbered, multi-line
/// string. This is where reqwest hides the real cause — e.g.
/// "error decoding response body" → "connection closed before message
/// completed" / "unexpected EOF during chunk size line" / an h2 GOAWAY.
pub fn error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut out = format!("[0] {err}");
    let mut src = err.source();
    let mut i = 1;
    while let Some(e) = src {
        out.push_str(&format!("\n[{i}] {e}"));
        src = e.source();
        i += 1;
    }
    out
}

/// Everything we know about a failed (or completed) streaming request.
pub struct LlmDump<'a> {
    pub provider: &'a str,
    pub url: &'a str,
    pub model: &'a str,
    /// Request body as sent (auth is in headers, never in the body).
    pub request_body: &'a serde_json::Value,
    pub response_status: Option<u16>,
    /// Response headers as "name: value" lines (already collected).
    pub response_headers: &'a [String],
    /// Count of SSE `data:` events received before the failure.
    pub events_received: usize,
    /// Tail of the raw received SSE payloads (capped), newest last.
    pub received_tail: &'a [String],
    /// Full error source chain, or None on a clean dump.
    pub error_chain: Option<&'a str>,
}

/// Write a dump file and return its path (also echoed to stderr). Best
/// effort — never panics, never blocks the caller on failure.
pub fn write_dump(dump: &LlmDump) -> Option<PathBuf> {
    let dir = DUMP_DIR.get()?;
    if std::fs::create_dir_all(dir).is_err() {
        return None;
    }
    // Millisecond timestamp keeps filenames unique and sortable.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("llm-stream-{ts}.txt"));

    let mut s = String::new();
    s.push_str(&format!("MatrixOS LLM stream dump\nepoch_ms: {ts}\n"));
    s.push_str(&format!("provider: {}\n", dump.provider));
    s.push_str(&format!("model: {}\n", dump.model));
    s.push_str(&format!("url: {}\n", dump.url));
    s.push_str(&format!(
        "response_status: {}\n",
        dump.response_status
            .map(|c| c.to_string())
            .unwrap_or_else(|| "(no response)".into())
    ));

    s.push_str("\n--- response headers ---\n");
    if dump.response_headers.is_empty() {
        s.push_str("(none captured)\n");
    } else {
        for h in dump.response_headers {
            s.push_str(h);
            s.push('\n');
        }
    }

    s.push_str(&format!(
        "\n--- request body (auth redacted; in headers only) ---\n{}\n",
        serde_json::to_string_pretty(dump.request_body)
            .unwrap_or_else(|_| dump.request_body.to_string())
    ));

    s.push_str(&format!(
        "\n--- stream progress ---\nevents_received: {}\n",
        dump.events_received
    ));
    s.push_str("\n--- received tail (raw SSE data payloads, newest last) ---\n");
    if dump.received_tail.is_empty() {
        s.push_str("(no SSE data received before failure — the provider sent headers but no body, \
                     or the body was not parseable as SSE)\n");
    } else {
        for (i, evt) in dump.received_tail.iter().enumerate() {
            s.push_str(&format!("[{i}] {evt}\n"));
        }
    }

    if let Some(chain) = dump.error_chain {
        s.push_str(&format!("\n--- error source chain ---\n{chain}\n"));
    }

    if std::fs::write(&path, s).is_err() {
        return None;
    }
    eprintln!("[rust:llm_stream] wrote debug dump: {}", path.display());
    Some(path)
}
