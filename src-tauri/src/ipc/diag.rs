//! Diagnostic IPC commands — JS-side observability that prints to the
//! Rust terminal so user-visible errors are recoverable from dev logs
//! even if the user doesn't catch the popup before it dismisses.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToastLevel {
    Success,
    Error,
    Info,
}

/// Liveness probe for Ollama on its default port. JS used to call
/// `fetch("http://localhost:11434/api/tags")` directly, which logged a
/// noisy `ERR_CONNECTION_REFUSED` in devtools every startup even though
/// the catch handled it. Routing through Rust keeps that probe entirely
/// out of the browser console.
///
/// Returns true when the local Ollama API responds with 2xx in <1s.
#[tauri::command]
pub async fn probe_ollama() -> Result<bool, String> {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .build()
    {
        Ok(c) => c,
        Err(_) => return Ok(false),
    };
    match client.get("http://localhost:11434/api/tags").send().await {
        Ok(r) => Ok(r.status().is_success()),
        Err(_) => Ok(false),
    }
}

/// Mirror a UI toast to the Rust terminal. Fire-and-forget from the JS
/// `addToast` hook in the UI store.
///
/// Output format: `[toast:LEVEL] MESSAGE [source=…]` — single line so it
/// is greppable in the dev terminal. `level` and `source` are optional
/// helpers; an unknown level renders as `unknown`.
#[tauri::command]
pub fn log_toast(level: ToastLevel, message: String, source: Option<String>) -> Result<(), String> {
    let level_str = match level {
        ToastLevel::Success => "success",
        ToastLevel::Error => "error",
        ToastLevel::Info => "info",
    };
    // stderr (eprintln!) so it shows up next to the existing
    // [rust:proc_start] / [rust:llm_stream] breadcrumbs even when stdout
    // is captured/buffered by the Tauri dev wrapper.
    if let Some(src) = source {
        eprintln!("[toast:{level_str}] {message}   [source={src}]");
    } else {
        eprintln!("[toast:{level_str}] {message}");
    }
    Ok(())
}
