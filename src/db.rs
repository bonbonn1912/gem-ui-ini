use crate::error::AppError;
use rusqlite::{Connection, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

const INITIAL_SCHEMA_VERSION: i64 = 1;

/// SQLite is deliberately kept behind one mutex for M1. SQLite remains the
/// source of truth, while later repositories can move read-heavy work to a
/// small connection pool without changing the state or command contracts.
#[derive(Clone)]
pub struct DbPool {
    path: Arc<PathBuf>,
    connection: Arc<Mutex<Connection>>,
}

impl DbPool {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AppError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(&path)?;
        configure_connection(&connection)?;
        apply_initial_schema(&connection)?;
        Ok(Self {
            path: Arc::new(path),
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn open_in_memory() -> Result<Self, AppError> {
        let connection = Connection::open_in_memory()?;
        configure_connection(&connection)?;
        apply_initial_schema(&connection)?;
        Ok(Self {
            path: Arc::new(PathBuf::from(":memory:")),
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn path(&self) -> &Path {
        self.path.as_path()
    }

    pub fn connection(&self) -> Result<MutexGuard<'_, Connection>, AppError> {
        self.connection.lock().map_err(|_| AppError::StatePoisoned)
    }

    pub fn schema_version(&self) -> Result<i64, AppError> {
        let connection = self.connection()?;
        Ok(connection.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )?)
    }
}

fn configure_connection(connection: &Connection) -> Result<(), AppError> {
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "busy_timeout", 5_000_i64)?;
    // SQLite cannot use WAL for an in-memory database and reports `memory` in
    // that case. File-backed application databases always use WAL.
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

fn apply_initial_schema(connection: &Connection) -> Result<(), AppError> {
    // The migration file owns schema creation, but is applied only once. This
    // check is what makes opening an existing database safe and idempotent.
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL) STRICT;",
    )?;
    let applied: Option<i64> = connection
        .query_row(
            "SELECT version FROM schema_migrations WHERE version = ?1",
            [INITIAL_SCHEMA_VERSION],
            |row| row.get(0),
        )
        .optional()?;
    if applied.is_none() {
        connection.execute_batch("BEGIN IMMEDIATE")?;
        let migration_result = (|| -> Result<(), AppError> {
            connection.execute_batch(include_str!("migrations/001_initial.sql"))?;
            connection.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                (INITIAL_SCHEMA_VERSION, "initial_schema_v1"),
            )?;
            connection.execute_batch("COMMIT")?;
            Ok(())
        })();
        if migration_result.is_err() {
            let _ = connection.execute_batch("ROLLBACK");
        }
        migration_result?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::DbPool;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "geminui-db-test-{}-{nonce}.sqlite",
            std::process::id()
        ))
    }

    #[test]
    fn opens_with_wal_foreign_keys_and_schema_v1() {
        let path = temp_db_path();
        let db = DbPool::open(&path).unwrap();
        let connection = db.connection().unwrap();
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert!(connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jira_project_integrations'",
                [],
                |row| row.get::<_, String>(0),
            )
            .is_ok());
        drop(connection);
        assert_eq!(db.schema_version().unwrap(), 1);
        drop(db);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn opening_again_is_idempotent() {
        let path = temp_db_path();
        {
            let db = DbPool::open(&path).unwrap();
            assert_eq!(db.schema_version().unwrap(), 1);
        }
        let db = DbPool::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), 1);
        let migration_rows: i64 = db
            .connection()
            .unwrap()
            .query_row("SELECT count(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(migration_rows, 1);
        drop(db);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let db = DbPool::open_in_memory().unwrap();
        let error = db
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO sessions (id, provider, project_id, last_root_revision, last_root_fingerprint, title, status, created_at, updated_at) VALUES ('s', 'gemini-cli', 'missing', 1, printf('%064d', 0), 'Session', 'idle', 'now', 'now')",
                [],
            )
            .unwrap_err();
        assert!(error.to_string().contains("FOREIGN KEY"));
    }
}
