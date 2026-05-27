// src-tauri/src/tray/mod.rs
use crate::db::Db;
use crate::providers::error::RustError;
use crate::scheduler::store;
use std::sync::Arc;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent, TrayIcon};
use tauri::{App, AppHandle, Manager, Wry};

const TRAY_ID: &str = "matrixos-tray";

pub fn setup(app: &mut App<Wry>) -> Result<(), Box<dyn std::error::Error>> {
    let icon_path = app.path().resolve("icons/tray-icon.png", BaseDirectory::Resource)?;
    let icon = Image::from_path(icon_path)?;

    let menu = build_menu(&app.handle(), &[])?;

    let _tray: TrayIcon = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            if id == "open" {
                open_main_window(app);
            } else if id == "quit" {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::lifecycle::cleanup_before_exit(&app_clone).await;
                });
            } else if let Some(job_id) = id.strip_prefix("run:") {
                let app_clone = app.clone();
                let job_id = job_id.to_string();
                tauri::async_runtime::spawn(async move {
                    let sched = app_clone.state::<Arc<crate::scheduler::engine::Scheduler>>();
                    let db = app_clone.state::<Arc<crate::db::Db>>();
                    if let Some(job) = store::read_job(&db, job_id.clone()).await.ok().flatten() {
                        let _ = sched.fire(job, "user".into()).await;
                    }
                });
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                open_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // Initial menu rebuild with current jobs.
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let _ = rebuild_menu(&app_handle).await;
    });
    Ok(())
}

pub async fn rebuild_menu(app: &AppHandle) -> Result<(), RustError> {
    let db = app.state::<Arc<Db>>();
    let jobs = store::list_enabled_for_tray(&db).await.unwrap_or_default();
    let new_menu = build_menu(app, &jobs).map_err(|e| {
        RustError::new("TRAY_MENU_BUILD", e.to_string(), false)
    })?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_menu(Some(new_menu));
    }
    Ok(())
}

fn build_menu(
    app: &AppHandle, jobs: &[(String, String)],
) -> Result<tauri::menu::Menu<Wry>, Box<dyn std::error::Error>> {
    let open_item = MenuItemBuilder::with_id("open", "Open MatrixOS").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit MatrixOS").build(app)?;

    let mut builder = MenuBuilder::new(app).item(&open_item);
    if !jobs.is_empty() {
        let mut sub = SubmenuBuilder::new(app, "Run a scheduled job now");
        for (id, label) in jobs.iter() {
            sub = sub.item(&MenuItemBuilder::with_id(format!("run:{id}"), label).build(app)?);
        }
        builder = builder.item(&sub.build()?);
    }
    let menu = builder.separator().item(&quit_item).build()?;
    Ok(menu)
}

fn open_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
