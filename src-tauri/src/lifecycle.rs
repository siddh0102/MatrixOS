use crate::db::Db;
use crate::proc::supervisor::Supervisor;
use crate::scheduler::engine::Scheduler;
use std::sync::Arc;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const BACKGROUND_WINDOW_LABEL: &str = "background";

/// Ensure the background window exists. Idempotent. Called on first sched_save_job
/// and on first non-interactive proc_start. Also at startup if the user has the
/// force-eager preference enabled.
pub async fn ensure_background_window_if_needed(app: &AppHandle) {
    if app.get_webview_window(BACKGROUND_WINDOW_LABEL).is_some() {
        return;
    }
    let builder = WebviewWindowBuilder::new(
        app, BACKGROUND_WINDOW_LABEL, WebviewUrl::App("index.html".into()),
    )
    .visible(false)
    .skip_taskbar(true)
    .title("MatrixOS (background)");

    // Apply throttling opt-out if the Tauri 2 version exposes it. If not, residual is documented.
    // builder = builder.background_throttling(false);

    let _ = builder.build();
}

/// Read general.runInBackground preference; default false (lazy mode).
/// When true, eagerly create the background window at startup.
pub async fn read_force_eager_pref(app: &AppHandle) -> bool {
    let db = app.state::<Arc<Db>>();
    db.with(|conn| {
        conn.query_row(
            "SELECT value_json FROM preferences WHERE agent_id = '__global__' AND key = ?",
            ["general.runInBackground"], |r| r.get::<_, String>(0),
        ).ok()
    }).await
        .and_then(|s| serde_json::from_str::<bool>(&s).ok())
        .unwrap_or(false)
}

/// Replaces Phase D's ExitRequested handler. Drain scheduler, supervisor, MCP, then exit.
pub async fn cleanup_before_exit(app: &AppHandle) {
    if let Some(sched) = app.try_state::<Arc<Scheduler>>() {
        sched.shutdown().await;
    }
    if let Some(sup) = app.try_state::<Arc<Supervisor>>() {
        sup.shutdown().await;
    }
    if let Some(mcp_reg) = app.try_state::<Arc<crate::mcp::registry::McpRegistry>>() {
        let entries = mcp_reg.all();
        for (_, entry) in entries {
            let t = entry.transport.lock().await.take();
            if let Some(crate::mcp::registry::Transport::Stdio(rs)) = t {
                crate::mcp::stdio::kill_running_stdio(&rs).await;
            }
        }
    }
    app.exit(0);
}
