//! SQLite persistence for app sessions and their historical root sets.

use super::contracts::{
    AppSession, SessionRootAuditSnapshot, SessionRootEntry, SessionStatus, SessionUpdate,
};
use crate::db::DbPool;
use crate::error::AppError;
use rusqlite::{params, OptionalExtension, TransactionBehavior};

#[derive(Clone)]
pub struct SessionRepository {
    db: DbPool,
}

impl SessionRepository {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }

    pub fn database(&self) -> DbPool {
        self.db.clone()
    }

    /// Inserts the session and, when supplied, its root audit snapshot in one
    /// transaction.  The snapshot is deliberately historical: replacing a
    /// project's roots must not rewrite what an older session used.
    pub fn create(
        &self,
        session: AppSession,
        roots: Option<&SessionRootAuditSnapshot>,
    ) -> Result<AppSession, AppError> {
        session.validate().map_err(AppError::Validation)?;
        let mut connection = self.db.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO sessions (id, provider, provider_session_id, project_id,
             last_root_revision, last_root_fingerprint, title, status, model, mode,
             available_models_json, available_modes_json, pinned, archived, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                session.id,
                session.provider,
                session.provider_session_id,
                session.project_id,
                as_i64(session.last_root_revision)?,
                session.last_root_fingerprint,
                session.title,
                session.status.as_str(),
                session.model,
                session.mode,
                serde_json::to_string(&session.available_models)?,
                serde_json::to_string(&session.available_modes)?,
                session.pinned as i64,
                session.archived as i64,
                session.created_at,
                session.updated_at,
            ],
        )?;
        if let Some(roots) = roots {
            insert_root_snapshot(&transaction, roots)?;
        }
        transaction.commit()?;
        drop(connection);
        self.get_by_id(&session.id)
    }

    pub fn get_by_id(&self, session_id: &str) -> Result<AppSession, AppError> {
        let connection = self.db.connection()?;
        connection
            .query_row(
                "SELECT id, provider, provider_session_id, project_id,
                 last_root_revision, last_root_fingerprint, title, status, model, mode,
                 available_models_json, available_modes_json, pinned, archived,
                 created_at, updated_at FROM sessions WHERE id = ?1",
                [session_id],
                session_from_row,
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound(format!("Session {session_id} was not found")))
    }

    pub fn find_by_id(&self, session_id: &str) -> Result<Option<AppSession>, AppError> {
        match self.get_by_id(session_id) {
            Ok(session) => Ok(Some(session)),
            Err(AppError::NotFound(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn list_by_project(
        &self,
        project_id: &str,
        include_archived: bool,
    ) -> Result<Vec<AppSession>, AppError> {
        let connection = self.db.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, provider, provider_session_id, project_id,
             last_root_revision, last_root_fingerprint, title, status, model, mode,
             available_models_json, available_modes_json, pinned, archived,
             created_at, updated_at FROM sessions
             WHERE project_id = ?1 AND (archived = 0 OR ?2 = 1)
             ORDER BY pinned DESC, updated_at DESC",
        )?;
        let result = statement
            .query_map(
                params![project_id, include_archived as i64],
                session_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from);
        result
    }

    /// Updates only supplied fields.  In particular, a status-only update does
    /// not clear the last model/mode picker lists.
    pub fn update(&self, session_id: &str, update: SessionUpdate) -> Result<AppSession, AppError> {
        let existing = self.get_by_id(session_id)?;
        let next = AppSession {
            provider_session_id: update
                .provider_session_id
                .unwrap_or(existing.provider_session_id.clone()),
            last_root_revision: update
                .last_root_revision
                .unwrap_or(existing.last_root_revision),
            last_root_fingerprint: update
                .last_root_fingerprint
                .unwrap_or(existing.last_root_fingerprint.clone()),
            title: update.title.unwrap_or(existing.title.clone()),
            status: update.status.unwrap_or(existing.status.clone()),
            model: update.model.unwrap_or(existing.model.clone()),
            mode: update.mode.unwrap_or(existing.mode.clone()),
            available_models: update
                .available_models
                .unwrap_or(existing.available_models.clone()),
            available_modes: update
                .available_modes
                .unwrap_or(existing.available_modes.clone()),
            pinned: update.pinned.unwrap_or(existing.pinned),
            archived: update.archived.unwrap_or(existing.archived),
            updated_at: update.updated_at,
            ..existing
        };
        next.validate().map_err(AppError::Validation)?;
        let connection = self.db.connection()?;
        let changed = connection.execute(
            "UPDATE sessions SET provider_session_id = ?1, last_root_revision = ?2,
             last_root_fingerprint = ?3, title = ?4, status = ?5, model = ?6, mode = ?7,
             available_models_json = ?8, available_modes_json = ?9, pinned = ?10,
             archived = ?11, updated_at = ?12 WHERE id = ?13",
            params![
                next.provider_session_id,
                as_i64(next.last_root_revision)?,
                next.last_root_fingerprint,
                next.title,
                next.status.as_str(),
                next.model,
                next.mode,
                serde_json::to_string(&next.available_models)?,
                serde_json::to_string(&next.available_modes)?,
                next.pinned as i64,
                next.archived as i64,
                next.updated_at,
                session_id,
            ],
        )?;
        if changed != 1 {
            return Err(AppError::NotFound(format!(
                "Session {session_id} was not found"
            )));
        }
        drop(connection);
        self.get_by_id(session_id)
    }

    pub fn record_root_snapshot(
        &self,
        snapshot: &SessionRootAuditSnapshot,
    ) -> Result<(), AppError> {
        validate_snapshot(snapshot)?;
        let mut connection = self.db.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM session_roots WHERE session_id = ?1 AND root_revision = ?2",
            params![snapshot.session_id, as_i64(snapshot.root_revision)?],
        )?;
        insert_root_snapshot(&transaction, snapshot)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn get_root_snapshot(
        &self,
        session_id: &str,
        root_revision: Option<u64>,
    ) -> Result<Option<SessionRootAuditSnapshot>, AppError> {
        let connection = self.db.connection()?;
        let revision = match root_revision {
            Some(value) => Some(as_i64(value)?),
            None => connection.query_row(
                "SELECT MAX(root_revision) FROM session_roots WHERE session_id = ?1",
                [session_id],
                |row| row.get::<_, Option<i64>>(0),
            )?,
        };
        let Some(revision) = revision else {
            return Ok(None);
        };
        let mut statement = connection.prepare(
            "SELECT session_id, root_revision, root_fingerprint, kind, path,
             real_path, label, sort_order, captured_at FROM session_roots
             WHERE session_id = ?1 AND root_revision = ?2 ORDER BY sort_order",
        )?;
        let rows = statement
            .query_map(params![session_id, revision], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    SessionRootEntry {
                        kind: row.get(3)?,
                        path: row.get(4)?,
                        real_path: row.get(5)?,
                        label: row.get(6)?,
                        sort_order: row.get::<_, i64>(7)? as usize,
                    },
                    row.get::<_, String>(8)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let Some((first_session, first_revision, fingerprint, _, captured_at)) =
            rows.first().cloned()
        else {
            return Ok(None);
        };
        Ok(Some(SessionRootAuditSnapshot {
            session_id: first_session,
            root_revision: first_revision as u64,
            root_fingerprint: fingerprint,
            captured_at,
            roots: rows.into_iter().map(|(_, _, _, root, _)| root).collect(),
        }))
    }

    pub fn delete(&self, session_id: &str) -> Result<(), AppError> {
        let connection = self.db.connection()?;
        let changed = connection.execute("DELETE FROM sessions WHERE id = ?1", [session_id])?;
        if changed != 1 {
            return Err(AppError::NotFound(format!(
                "Session {session_id} was not found"
            )));
        }
        Ok(())
    }
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AppSession> {
    let status: String = row.get(7)?;
    let status = SessionStatus::parse(&status).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            7,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unknown session status",
            )),
        )
    })?;
    let available_models_json: String = row.get(10)?;
    let available_modes_json: String = row.get(11)?;
    let session = AppSession {
        id: row.get(0)?,
        provider: row.get(1)?,
        provider_session_id: row.get(2)?,
        project_id: row.get(3)?,
        last_root_revision: row
            .get::<_, i64>(4)?
            .try_into()
            .map_err(|_| invalid_row(4))?,
        last_root_fingerprint: row.get(5)?,
        title: row.get(6)?,
        status,
        model: row.get(8)?,
        mode: row.get(9)?,
        available_models: serde_json::from_str(&available_models_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                10,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        available_modes: serde_json::from_str(&available_modes_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                11,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        pinned: row.get::<_, i64>(12)? == 1,
        archived: row.get::<_, i64>(13)? == 1,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    };
    session.validate().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })?;
    Ok(session)
}

fn insert_root_snapshot(
    transaction: &rusqlite::Transaction<'_>,
    snapshot: &SessionRootAuditSnapshot,
) -> Result<(), AppError> {
    for root in &snapshot.roots {
        transaction.execute(
            "INSERT INTO session_roots (session_id, root_revision, root_fingerprint,
             kind, path, real_path, label, sort_order, captured_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                snapshot.session_id,
                as_i64(snapshot.root_revision)?,
                snapshot.root_fingerprint,
                root.kind,
                root.path,
                root.real_path,
                root.label,
                root.sort_order as i64,
                snapshot.captured_at,
            ],
        )?;
    }
    Ok(())
}

fn validate_snapshot(snapshot: &SessionRootAuditSnapshot) -> Result<(), AppError> {
    if snapshot.session_id.trim().is_empty()
        || snapshot.root_revision == 0
        || snapshot.root_fingerprint.len() != 64
        || snapshot
            .root_fingerprint
            .bytes()
            .any(|byte| !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase())
    {
        return Err(AppError::Validation(
            "invalid session root snapshot".to_owned(),
        ));
    }
    if snapshot.roots.is_empty() || snapshot.roots.len() > 6 {
        return Err(AppError::Validation(
            "a session must have one to six roots".to_owned(),
        ));
    }
    for root in &snapshot.roots {
        if root.kind != "primary" && root.kind != "additional" {
            return Err(AppError::Validation("unknown root kind".to_owned()));
        }
        if root.path.is_empty() || root.real_path.is_empty() || root.label.trim().is_empty() {
            return Err(AppError::Validation(
                "session root fields must not be empty".to_owned(),
            ));
        }
        if (root.kind == "primary" && root.sort_order != 0)
            || (root.kind == "additional" && (root.sort_order == 0 || root.sort_order > 5))
        {
            return Err(AppError::Validation(
                "root kind and sort order do not match".to_owned(),
            ));
        }
    }
    Ok(())
}

fn as_i64(value: u64) -> Result<i64, AppError> {
    i64::try_from(value).map_err(|_| AppError::Validation("integer is too large".to_owned()))
}

fn invalid_row(column: usize) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Integer,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid integer",
        )),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbPool;
    use crate::sessions::contracts::SessionOption;
    use uuid::Uuid;

    fn session(project_id: &str) -> AppSession {
        AppSession {
            id: Uuid::new_v4().to_string(),
            provider: "gemini-cli".into(),
            provider_session_id: None,
            project_id: project_id.into(),
            last_root_revision: 1,
            last_root_fingerprint: "a".repeat(64),
            title: "Neue Session".into(),
            status: SessionStatus::Idle,
            model: None,
            mode: None,
            available_models: vec![],
            available_modes: vec![],
            pinned: false,
            archived: false,
            created_at: "2026-08-20T12:00:00.000Z".into(),
            updated_at: "2026-08-20T12:00:00.000Z".into(),
        }
    }

    #[test]
    fn persists_picker_cache_and_updates_without_wiping_it() {
        let db = DbPool::open_in_memory().unwrap();
        let project_id = Uuid::new_v4().to_string();
        // projects has a deferred FK to project_roots, so insert via one txn.
        let mut connection = db.connection().unwrap();
        let tx = connection.transaction().unwrap();
        let root_id = Uuid::new_v4().to_string();
        tx.execute("INSERT INTO project_roots (id, project_id, kind, path, real_path, label, sort_order, created_at, updated_at) VALUES (?1, ?2, 'primary', '/tmp', '/tmp', 'tmp', 0, 'now', 'now')", params![root_id, project_id]).unwrap();
        tx.execute("INSERT INTO projects (id, name, primary_root_id, root_revision, root_fingerprint, archived, created_at, updated_at) VALUES (?1, 'p', ?2, 1, ?3, 0, 'now', 'now')", params![project_id, root_id, "a".repeat(64)]).unwrap();
        tx.commit().unwrap();
        drop(connection);
        let repo = SessionRepository::new(db);
        let mut value = session(&project_id);
        value.available_models = vec![SessionOption {
            id: "pro".into(),
            name: "Pro".into(),
            description: Some("best".into()),
        }];
        let value = repo.create(value, None).unwrap();
        repo.update(
            &value.id,
            SessionUpdate {
                status: Some(SessionStatus::Running),
                updated_at: value.updated_at.clone(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            repo.get_by_id(&value.id).unwrap().available_models[0].id,
            "pro"
        );
    }
}
