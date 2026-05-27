use crate::db::Db;
use crate::providers::error::RustError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub event_type: String,
    pub actor: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub details: Option<serde_json::Value>,
}

/// Map a rusqlite error to a `RustError`, special-casing trigger ABORTs so the
/// renderer can distinguish "you hit an append-only trigger" from other DB errors.
pub fn map_db_err(e: rusqlite::Error) -> RustError {
    if let rusqlite::Error::SqliteFailure(ref f, _) = e {
        if f.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER {
            return RustError::new("DB_TRIGGER_BLOCKED", e.to_string(), false);
        }
    }
    RustError::new("DB_ERROR", e.to_string(), false)
}

/// Append an audit row, taking its own DB lock. Use when you do not already
/// hold an open Connection.
pub async fn append_audit(db: &Db, entry: &AuditEntry) -> Result<(), RustError> {
    let id = nanoid::nanoid!();
    let created_at = chrono::Utc::now().to_rfc3339();
    let details_json = entry
        .details
        .as_ref()
        .map(|d| d.to_string())
        .unwrap_or_default();
    let event_type = entry.event_type.clone();
    let actor = entry.actor.clone();
    let target_type = entry.target_type.clone();
    let target_id = entry.target_id.clone();

    db.with(move |conn| {
        conn.execute(
            "INSERT INTO audit_log (id, event_type, actor, target_type, target_id, details_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![id, event_type, actor, target_type, target_id, details_json, created_at],
        )
        .map(|_| ())
        .map_err(map_db_err)
    })
    .await
}

/// Append an audit row using the caller's already-open Connection. Use when you
/// need the audit INSERT to participate in an existing transaction (e.g. paired
/// with a Tier-B data UPDATE).
pub fn append_audit_in_txn(conn: &Connection, entry: &AuditEntry) -> Result<(), RustError> {
    let id = nanoid::nanoid!();
    let created_at = chrono::Utc::now().to_rfc3339();
    let details_json = entry
        .details
        .as_ref()
        .map(|d| d.to_string())
        .unwrap_or_default();

    conn.execute(
        "INSERT INTO audit_log (id, event_type, actor, target_type, target_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            id, entry.event_type, entry.actor,
            entry.target_type, entry.target_id,
            details_json, created_at
        ],
    )
    .map(|_| ())
    .map_err(map_db_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Build an in-memory Db with the audit_log schema + Phase C triggers.
    ///
    /// We load migration 005 (audit_log schema) and then the audit-log-specific
    /// triggers from 012. The full 012 file also creates triggers on tables that
    /// do not exist in this minimal in-memory database (llm_requests,
    /// daily_token_usage, etc.), so we apply only the two audit_log triggers
    /// using the same SQL text that 012 contains.
    fn db_with_audit_and_triggers() -> Db {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/005_audit_log.sql"))
            .unwrap();
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS audit_log_no_update
               BEFORE UPDATE ON audit_log
               BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
             CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
               BEFORE DELETE ON audit_log
               BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;",
        )
        .unwrap();
        Db::from_connection(conn)
    }

    fn sample_entry() -> AuditEntry {
        AuditEntry {
            event_type: "test.event".into(),
            actor: "system".into(),
            target_type: Some("agent".into()),
            target_id: Some("a1".into()),
            details: Some(serde_json::json!({"k": "v"})),
        }
    }

    #[tokio::test]
    async fn append_inserts_row() {
        let db = db_with_audit_and_triggers();
        append_audit(&db, &sample_entry()).await.unwrap();
        let count: i64 = db
            .with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM audit_log", [], |r| r.get(0))
                    .unwrap()
            })
            .await;
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn triggers_block_update_and_delete() {
        let db = db_with_audit_and_triggers();
        append_audit(&db, &sample_entry()).await.unwrap();

        let update_err: String = db
            .with(|conn| {
                conn.execute("UPDATE audit_log SET actor = 'evil'", [])
                    .map(|_| String::new())
                    .unwrap_or_else(|e| e.to_string())
            })
            .await;
        assert!(
            update_err.contains("audit_log is append-only"),
            "expected trigger message, got: {update_err}",
        );

        let delete_err: String = db
            .with(|conn| {
                conn.execute("DELETE FROM audit_log", [])
                    .map(|_| String::new())
                    .unwrap_or_else(|e| e.to_string())
            })
            .await;
        assert!(
            delete_err.contains("audit_log is append-only"),
            "expected trigger message, got: {delete_err}",
        );
    }
}
