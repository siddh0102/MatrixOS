use rusqlite::Connection;
use rusqlite::ffi::sqlite3_auto_extension;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Deserialize)]
pub struct VecSearchResult {
    pub id: String,
    pub distance: f64,
    pub metadata: String,
}

pub struct VectorDB {
    conn: Mutex<Connection>,
    dimensions: Mutex<usize>,
}

impl VectorDB {
    /// Open the vector DB. `default_dimensions` is used only when no
    /// vec tables exist yet (first-ever startup). On subsequent starts the
    /// dimension is read from the existing table schema; the in-memory
    /// `dimensions` field is set to that value, NOT to the parameter.
    ///
    /// This avoids a previous footgun: `dimensions` was stored only in
    /// memory and reset to the constructor argument on every startup. If
    /// the caller passed a stale value (e.g. 384 after the default moved
    /// to 768), `get_dimensions()` returned the stale value and the JS
    /// bootstrap would call `recreate_tables(768)` — wiping every vector
    /// on every launch.
    pub fn new(db_path: PathBuf, default_dimensions: usize) -> Result<Self, String> {
        // Register sqlite-vec as an auto-extension BEFORE opening the connection.
        unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }

        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .map_err(|e| e.to_string())?;

        // If vec_semantic already exists on disk, trust its dimension over
        // whatever the caller passed. sqlite-vec encodes the dim in the
        // stored CREATE statement as `embedding float[N]`.
        let existing_dim = read_existing_dimension(&conn, "vec_semantic");
        let effective_dim = existing_dim.unwrap_or(default_dimensions);

        conn.execute_batch(&format!("
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_episodic USING vec0(
                id TEXT PRIMARY KEY,
                embedding float[{dim}],
                +metadata TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_semantic USING vec0(
                id TEXT PRIMARY KEY,
                embedding float[{dim}],
                +metadata TEXT
            );
        ", dim = effective_dim)).map_err(|e| e.to_string())?;

        Ok(Self {
            conn: Mutex::new(conn),
            dimensions: Mutex::new(effective_dim),
        })
    }

    pub fn get_dimensions(&self) -> Result<usize, String> {
        let dims = self.dimensions.lock().map_err(|e| e.to_string())?;
        Ok(*dims)
    }

    pub fn upsert(&self, table: &str, id: &str, embedding: &[f32], metadata: &str)
        -> Result<(), String>
    {
        Self::validate_table(table)?;
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let embedding_bytes = f32_slice_to_bytes(embedding);
        // sqlite-vec's vec0 virtual table does NOT honor `INSERT OR REPLACE`
        // on the declared primary key — it raises a UNIQUE constraint error
        // instead of replacing. So we explicitly DELETE-then-INSERT inside a
        // transaction. The DELETE is a no-op when the row doesn't exist, so
        // this works the same for first-time inserts and updates.
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            &format!("DELETE FROM {} WHERE id = ?1", table),
            rusqlite::params![id],
        ).map_err(|e| e.to_string())?;
        tx.execute(
            &format!("INSERT INTO {} (id, embedding, metadata) VALUES (?1, ?2, ?3)", table),
            rusqlite::params![id, embedding_bytes, metadata],
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn search(&self, table: &str, query_embedding: &[f32], limit: usize)
        -> Result<Vec<VecSearchResult>, String>
    {
        Self::validate_table(table)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let query_bytes = f32_slice_to_bytes(query_embedding);
        let mut stmt = conn.prepare(
            &format!(
                "SELECT id, distance, metadata FROM {} WHERE embedding MATCH ?1 ORDER BY distance LIMIT ?2",
                table,
            ),
        ).map_err(|e| e.to_string())?;

        let results = stmt.query_map(
            rusqlite::params![query_bytes, limit as i64],
            |row| {
                Ok(VecSearchResult {
                    id: row.get(0)?,
                    distance: row.get(1)?,
                    metadata: row.get(2)?,
                })
            },
        ).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

        Ok(results)
    }

    pub fn delete(&self, table: &str, id: &str) -> Result<(), String> {
        Self::validate_table(table)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            &format!("DELETE FROM {} WHERE id = ?1", table),
            rusqlite::params![id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_batch(&self, table: &str, ids: &[String]) -> Result<(), String> {
        Self::validate_table(table)?;
        if ids.is_empty() { return Ok(()); }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!("DELETE FROM {} WHERE id IN ({})", table, placeholders.join(","));
        let params: Vec<&dyn rusqlite::types::ToSql> = ids.iter()
            .map(|id| id as &dyn rusqlite::types::ToSql)
            .collect();
        conn.execute(&sql, params.as_slice()).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear(&self, table: &str) -> Result<(), String> {
        Self::validate_table(table)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(&format!("DELETE FROM {}", table), [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn recreate_tables(&self, dimensions: usize) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch(&format!("
            DROP TABLE IF EXISTS vec_episodic;
            DROP TABLE IF EXISTS vec_semantic;
            CREATE VIRTUAL TABLE vec_episodic USING vec0(
                id TEXT PRIMARY KEY,
                embedding float[{dim}],
                +metadata TEXT
            );
            CREATE VIRTUAL TABLE vec_semantic USING vec0(
                id TEXT PRIMARY KEY,
                embedding float[{dim}],
                +metadata TEXT
            );
        ", dim = dimensions)).map_err(|e| e.to_string())?;

        let mut dims = self.dimensions.lock().map_err(|e| e.to_string())?;
        *dims = dimensions;

        Ok(())
    }

    fn validate_table(table: &str) -> Result<(), String> {
        match table {
            "vec_episodic" | "vec_semantic" => Ok(()),
            _ => Err(format!("Invalid vector table name: {}", table)),
        }
    }
}

// sqlite-vec stores float32 vectors as raw little-endian bytes (BLOB).
fn f32_slice_to_bytes(slice: &[f32]) -> Vec<u8> {
    slice.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// Read the embedding dimension out of an existing vec table's stored
/// CREATE statement. sqlite-vec encodes the dim as `embedding float[N]`.
/// Returns None when the table does not exist yet or the statement does
/// not match the expected shape.
fn read_existing_dimension(conn: &Connection, table: &str) -> Option<usize> {
    let sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",
            rusqlite::params![table],
            |row| row.get::<_, String>(0),
        )
        .ok()?;
    let needle = "float[";
    let start = sql.find(needle)? + needle.len();
    let end = sql[start..].find(']')?;
    sql[start..start + end].trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn mk_conn() -> Connection {
        unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn read_existing_dimension_parses_float_bracket() {
        let conn = mk_conn();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE vec_semantic USING vec0(\
                id TEXT PRIMARY KEY, embedding float[768], +metadata TEXT)",
        )
        .unwrap();
        assert_eq!(read_existing_dimension(&conn, "vec_semantic"), Some(768));
    }

    #[test]
    fn read_existing_dimension_returns_none_when_missing() {
        let conn = mk_conn();
        assert_eq!(read_existing_dimension(&conn, "vec_semantic"), None);
    }

    #[test]
    fn vector_db_new_respects_existing_table_dim() {
        // Seed a tmp file DB with a 768-dim vec_semantic, close it, reopen
        // via VectorDB::new passing 384, and assert get_dimensions() is 768.
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        // First open writes 768-dim tables.
        let db = VectorDB::new(path.clone(), 768).unwrap();
        assert_eq!(db.get_dimensions().unwrap(), 768);
        drop(db);

        // Reopen with default 384 — must still report 768.
        let db = VectorDB::new(path, 384).unwrap();
        assert_eq!(db.get_dimensions().unwrap(), 768);
    }

    #[test]
    fn vector_db_new_uses_default_when_no_existing_tables() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        let db = VectorDB::new(path, 384).unwrap();
        assert_eq!(db.get_dimensions().unwrap(), 384);
    }

    #[test]
    fn upsert_replaces_existing_row_without_unique_constraint_error() {
        // Regression: sqlite-vec's vec0 virtual table rejects `INSERT OR
        // REPLACE` with a UNIQUE constraint error instead of replacing. The
        // upsert() method must paper over this by deleting first.
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let path = tmp.path().to_path_buf();
        let db = VectorDB::new(path, 4).unwrap();

        let v1 = vec![0.1_f32, 0.2, 0.3, 0.4];
        let v2 = vec![0.9_f32, 0.8, 0.7, 0.6];

        db.upsert("vec_semantic", "chunk-1", &v1, "{\"version\":1}").unwrap();
        // Second upsert with same id MUST succeed, not raise UNIQUE error.
        db.upsert("vec_semantic", "chunk-1", &v2, "{\"version\":2}").unwrap();

        // After the second upsert there should still be exactly one row
        // and its metadata should be the v2 payload (i.e. it actually
        // replaced, not duplicated or no-op'd).
        let conn = db.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM vec_semantic", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let meta: String = conn
            .query_row(
                "SELECT metadata FROM vec_semantic WHERE id = 'chunk-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(meta, "{\"version\":2}");
    }
}
