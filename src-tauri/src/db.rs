//! Shared rusqlite connection managed by Tauri state.
//!
//! A single `Db` instance is opened at startup and stored as
//! `Arc<Db>` in Tauri's state map.  All Rust IPC handlers that need
//! to read from `matrixos.db` take `State<'_, Arc<Db>>` and call
//! `db.with(|conn| { … }).await`.
//!
//! The underlying mutex is `tokio::sync::Mutex` so `with` is async-safe
//! inside `#[tauri::command] async fn` handlers.  Do **not** call `with`
//! from synchronous (non-async) contexts — the `lock().await` will panic
//! if no Tokio runtime is present.

use rusqlite::Connection;
use std::path::PathBuf;
use tokio::sync::Mutex;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (or create) the SQLite database at `path` and enable WAL mode.
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;\n\
             PRAGMA busy_timeout=5000;\n\
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Run `f` with an exclusive reference to the underlying connection.
    ///
    /// Must be called from an async context (inside a Tokio runtime).
    pub async fn with<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        let guard = self.conn.lock().await;
        f(&*guard)
    }
}

#[cfg(test)]
impl Db {
    /// Test-only: build a `Db` from an already-open in-memory connection.
    pub fn from_connection(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }
}
