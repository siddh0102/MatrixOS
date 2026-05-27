mod audit;
mod db;
mod fs;
mod lifecycle;
pub mod mcp;
mod proc;
mod scheduler;
mod tray;
mod vector_db;
mod providers;
mod ipc;

use keyring::Entry;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};
use vector_db::{VectorDB, VecSearchResult};

const KEYRING_SERVICE: &str = "com.matrixos.app";
const OLD_KEYRING_SERVICE: &str = "com.agentos.app";

// keychain_get / keychain_set / keychain_delete removed in Phase A — the
// renderer no longer accesses API keys via IPC. Provider key writes go
// through `provider_set_key` / `provider_delete_key` (src/ipc/llm.rs);
// internal Rust callers use `keyring::Entry` directly via the Registry
// (src/providers/registry.rs).

#[tauri::command]
fn keychain_migrate(key: String) -> Result<bool, String> {
    let old = Entry::new(OLD_KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match old.get_password() {
        Ok(password) => {
            let new = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
            new.set_password(&password).map_err(|e| e.to_string())?;
            let _ = old.delete_credential();
            Ok(true)
        }
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn vec_upsert(
    state: tauri::State<'_, VectorDB>,
    table: String,
    id: String,
    embedding: Vec<f32>,
    metadata: String,
) -> Result<(), String> {
    state.upsert(&table, &id, &embedding, &metadata)
}

#[tauri::command]
fn vec_search(
    state: tauri::State<'_, VectorDB>,
    table: String,
    query_embedding: Vec<f32>,
    limit: usize,
) -> Result<Vec<VecSearchResult>, String> {
    state.search(&table, &query_embedding, limit)
}

#[tauri::command]
fn vec_delete(
    state: tauri::State<'_, VectorDB>,
    table: String,
    id: String,
) -> Result<(), String> {
    state.delete(&table, &id)
}

#[tauri::command]
fn vec_delete_batch(
    state: tauri::State<'_, VectorDB>,
    table: String,
    ids: Vec<String>,
) -> Result<(), String> {
    state.delete_batch(&table, &ids)
}

#[tauri::command]
fn vec_clear(
    state: tauri::State<'_, VectorDB>,
    table: String,
) -> Result<(), String> {
    state.clear(&table)
}

#[tauri::command]
fn vec_recreate(
    state: tauri::State<'_, VectorDB>,
    dimensions: usize,
) -> Result<(), String> {
    state.recreate_tables(dimensions)
}

#[tauri::command]
fn vec_get_dimensions(
    state: tauri::State<'_, VectorDB>,
) -> Result<usize, String> {
    state.get_dimensions()
}

#[tauri::command]
fn extract_pdf_text(path: String) -> Result<String, String> {
    pdf_extract::extract_text(std::path::Path::new(&path))
        .map_err(|e| format!("PDF extraction failed: {}", e))
}

#[tauri::command]
fn extract_docx_text(path: String) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(&path)
        .map_err(|e| format!("Failed to open \"{}\": {}", path, e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read docx archive: {}", e))?;

    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|e| format!("Missing word/document.xml: {}", e))?
        .read_to_string(&mut xml)
        .map_err(|e| format!("Failed to read document.xml: {}", e))?;

    Ok(strip_xml_tags(&xml))
}

#[tauri::command]
fn extract_pptx_text(path: String) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(&path)
        .map_err(|e| format!("Failed to open \"{}\": {}", path, e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read pptx archive: {}", e))?;

    let mut slides: Vec<(usize, String)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("Failed to read archive entry: {}", e))?;
        let name = entry.name().to_string();
        if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
            let slide_num: usize = name
                .trim_start_matches("ppt/slides/slide")
                .trim_end_matches(".xml")
                .parse()
                .unwrap_or(0);
            let mut xml = String::new();
            entry.read_to_string(&mut xml)
                .map_err(|e| format!("Failed to read {}: {}", name, e))?;
            slides.push((slide_num, strip_xml_tags(&xml)));
        }
    }

    slides.sort_by_key(|(num, _)| *num);
    Ok(slides.into_iter().map(|(_, text)| text).collect::<Vec<_>>().join("\n\n"))
}

fn strip_xml_tags(xml: &str) -> String {
    let mut result = String::with_capacity(xml.len() / 2);
    let mut in_tag = false;
    let mut last_was_space = true;

    for ch in xml.chars() {
        match ch {
            '<' => {
                in_tag = true;
                if !last_was_space && !result.is_empty() {
                    result.push(' ');
                    last_was_space = true;
                }
            }
            '>' => in_tag = false,
            _ if !in_tag => {
                if ch.is_whitespace() {
                    if !last_was_space {
                        result.push(' ');
                        last_was_space = true;
                    }
                } else {
                    result.push(ch);
                    last_was_space = false;
                }
            }
            _ => {}
        }
    }

    result.trim().to_string()
}

fn migrate_old_data(app_dir: &std::path::Path) {
    let old_dir = app_dir.parent().unwrap_or(app_dir).join("com.agentos.app");
    if !old_dir.exists() { return; }
    let renames = [
        ("agentos.db", "matrixos.db"),
        ("agentos.db-wal", "matrixos.db-wal"),
        ("agentos-vectors.db", "matrixos-vectors.db"),
        ("agentos-vectors.db-wal", "matrixos-vectors.db-wal"),
    ];
    for (old_name, new_name) in &renames {
        let src = old_dir.join(old_name);
        let dst = app_dir.join(new_name);
        if src.exists() && !dst.exists() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
    let _ = std::fs::remove_dir_all(&old_dir);
}

pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create initial tables",
            sql: include_str!("../migrations/001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add llm_requests telemetry table",
            sql: include_str!("../migrations/002_telemetry.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add mcp_servers table",
            sql: include_str!("../migrations/003_mcp_servers.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add telemetry_id column to messages",
            sql: include_str!("../migrations/004_message_telemetry.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "create audit_log table",
            sql: include_str!("../migrations/005_audit_log.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "create skills table",
            sql: include_str!("../migrations/006_skills.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "create memory tables",
            sql: include_str!("../migrations/007_memory.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "create scheduled_jobs table",
            sql: include_str!("../migrations/008_schedules.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "create knowledge_bases tables",
            sql: include_str!("../migrations/009_knowledge_bases.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "create agent_processes and daily_token_usage tables",
            sql: include_str!("../migrations/010_processes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "create workflows, workflow_runs, and workflow_human_inputs tables",
            sql: include_str!("../migrations/011_workflows.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "append-only triggers on Tier-A tables",
            sql: include_str!("../migrations/012_append_only_triggers.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "drop legacy MCP auto-restart columns",
            sql: include_str!("../migrations/013_mcp_drop_legacy.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "add scheduled_jobs.name and consecutive_failures columns",
            sql: include_str!("../migrations/014_scheduled_jobs_name_and_failures.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "default embedding to bundled nomic-embed-text-v1.5 (768d)",
            sql: include_str!("../migrations/015_default_embedding_nomic.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "orphan telemetry tables instead of cascade-deleting them",
            sql: include_str!("../migrations/016_orphan_telemetry_on_cascade.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "add messages.sources_json for retrieval attribution",
            sql: include_str!("../migrations/017_messages_sources_json.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "add messages.is_summary + compacted_at for conversation compaction",
            sql: include_str!("../migrations/018_messages_compaction.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "create agent_templates table",
            sql: include_str!("../migrations/019_agent_templates.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "observability: per-call telemetry, tool records, alert rules",
            sql: include_str!("../migrations/020_observability.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let app_dir = app.path().app_data_dir().unwrap();
            std::fs::create_dir_all(&app_dir).ok();
            // Where on-error LLM stream dumps land (best-effort diagnostics).
            crate::providers::debug_dump::set_dump_dir(app_dir.join("debug-dumps"));
            migrate_old_data(&app_dir);
            let vec_db_path = app_dir.join("matrixos-vectors.db");
            // 768 matches the bundled nomic-embed-text-v1.5 default (migration
            // 015). This is a FALLBACK only — once the file exists, VectorDB
            // reads the real dimension from the stored CREATE statement and
            // ignores this argument. Frontend still calls vec_recreate on
            // genuine model swaps (e.g. user switches to a 384-dim model).
            let vec_db = VectorDB::new(vec_db_path, 768)
                .expect("Failed to initialize vector database");
            app.manage(vec_db);

            // Phase A: provider Registry, RateLimiter, and a dedicated rusqlite
            // Connection to matrixos.db (alongside tauri-plugin-sql — SQLite WAL
            // handles concurrent connections).
            app.manage(crate::providers::registry::Registry::new());
            app.manage(Arc::new(crate::providers::rate_limit::RateLimiter::new()));
            let db_path = app_dir.join("matrixos.db");
            // The tauri-plugin-sql migrations will have already created the schema
            // by the time the first llm_send fires; until then, the connection will
            // see only what migrations have completed. Open in read-write mode so
            // future write commands (Phase C audit_append, etc.) can reuse it.
            let main_db = crate::db::Db::open(db_path)
                .expect("Failed to open matrixos.db for Rust-side reads");
            app.manage(Arc::new(main_db));
            app.manage(crate::fs::policy::PolicyCache::new());
            app.manage(crate::fs::user_paths::UserPaths::new());
            app.manage(crate::mcp::registry::McpRegistry::new());

            // ── Phase E — scheduler + supervisor + tray + lifecycle ──
            let app_handle = app.handle().clone();
            let main_db = app_handle.state::<Arc<crate::db::Db>>().inner().clone();

            // Scheduler
            let scheduler = crate::scheduler::engine::Scheduler::new(main_db.clone(), app_handle.clone());
            app.manage(scheduler.clone());
            let sched_for_spawn = scheduler.clone();
            tauri::async_runtime::spawn(async move {
                sched_for_spawn.spawn().await;
            });

            // Supervisor
            let supervisor = crate::proc::supervisor::Supervisor::new(main_db.clone(), app_handle.clone());
            app.manage(supervisor);

            // Tray
            crate::tray::setup(app).map_err(|e| format!("tray setup: {}", e))?;

            // Eager background window if preference enabled.
            let eager_app = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if crate::lifecycle::read_force_eager_pref(&eager_app).await {
                    crate::lifecycle::ensure_background_window_if_needed(&eager_app).await;
                }
            });

            // Window-close interception. Reads pref live on each close event.
            if let Some(main_window) = app.get_webview_window("main") {
                let app_for_close = app_handle.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let app_clone = app_for_close.clone();
                        let run_in_bg = tauri::async_runtime::block_on(
                            crate::lifecycle::read_force_eager_pref(&app_clone)
                        );
                        if run_in_bg {
                            api.prevent_close();
                            if let Some(w) = app_clone.get_webview_window("main") {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:matrixos.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            // keychain_get / _set / _delete removed in Phase A (renderer cannot
            // extract API keys via IPC). keychain_migrate stays for the one-time
            // boot migration from the legacy keyring service name.
            keychain_migrate,
            crate::ipc::diag::log_toast,
            crate::ipc::diag::probe_ollama,
            vec_upsert,
            vec_search,
            vec_delete,
            vec_delete_batch,
            vec_clear,
            vec_recreate,
            vec_get_dimensions,
            extract_pdf_text,
            extract_docx_text,
            extract_pptx_text,
            // Phase A — LLM transport
            crate::ipc::llm::llm_upsert_config,
            crate::ipc::llm::llm_validate,
            crate::ipc::llm::llm_list_models,
            crate::ipc::llm::llm_send,
            crate::ipc::llm::llm_stream,
            crate::ipc::llm::llm_cancel,
            crate::ipc::llm::provider_set_key,
            crate::ipc::llm::provider_delete_key,
            crate::ipc::llm::provider_has_key,
            crate::ipc::llm::provider_reload_keys,
            // Phase B — sandboxed FS + web_fetch
            crate::ipc::fs::fs_read,
            crate::ipc::fs::fs_write,
            crate::ipc::fs::fs_list,
            crate::ipc::fs::fs_register_user_path,
            crate::ipc::fs::web_fetch,
            crate::ipc::fs::web_cancel,
            crate::ipc::resources::load_bundled_resource,
            crate::ipc::shell::shell_run,
            crate::ipc::glob::fs_glob,
            crate::ipc::grep::code_grep,
            crate::ipc::search::tavily_search,
            // Phase C — audit + sensitive SQL writes
            crate::ipc::audit::audit_append,
            crate::ipc::audit::telemetry_append_llm_request,
            crate::ipc::audit::telemetry_append_llm_call,
            crate::ipc::audit::tool_exec_append,
            crate::ipc::audit::otel_export,
            crate::ipc::audit::token_usage_add,
            crate::ipc::config::agent_set_sandbox,
            crate::ipc::config::agent_set_rate_limits,
            crate::ipc::config::provider_set_config,
            // Phase D — MCP lifecycle
            crate::ipc::mcp::mcp_hydrate_from_db,
            crate::ipc::mcp::mcp_set_server_config,
            crate::ipc::mcp::mcp_remove_server_config,
            crate::ipc::mcp::mcp_spawn,
            crate::ipc::mcp::mcp_disconnect,
            crate::ipc::mcp::mcp_send,
            crate::ipc::mcp::mcp_cancel,
            crate::ipc::mcp::mcp_subscribe,
            crate::ipc::mcp::mcp_unsubscribe,
            crate::ipc::mcp::mcp_status,
            // Phase E — scheduler
            crate::ipc::scheduler::sched_save_job,
            crate::ipc::scheduler::sched_delete_job,
            crate::ipc::scheduler::sched_run_now,
            crate::ipc::scheduler::sched_cancel_run,
            crate::ipc::scheduler::sched_list_runs,
            crate::ipc::scheduler::sched_complete_run,
            crate::ipc::scheduler::sched_health,
            crate::ipc::scheduler::pref_set,
            // Phase E — process supervisor
            crate::ipc::process::proc_start,
            crate::ipc::process::proc_update_status,
            crate::ipc::process::proc_complete,
            crate::ipc::process::proc_fail,
            crate::ipc::process::proc_record_tokens,
            crate::ipc::process::proc_status,
            crate::ipc::process::proc_subscribe,
            crate::ipc::process::proc_unsubscribe,
            crate::ipc::process::proc_list_running,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let app_clone = app_handle.clone();
                tauri::async_runtime::block_on(async move {
                    crate::lifecycle::cleanup_before_exit(&app_clone).await;
                });
            }
        });
}
