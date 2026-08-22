use super::contracts::{
    AppProject, ProjectApprovalModeState, ProjectRoot, ProjectRootKind, ProjectWithRoots,
    MAX_ADDITIONAL_ROOTS,
};
use crate::db::DbPool;
use crate::error::AppError;
use rusqlite::{params, OptionalExtension, TransactionBehavior};

#[derive(Clone)]
pub struct ProjectRepository {
    db: DbPool,
}

impl ProjectRepository {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }

    pub fn database(&self) -> DbPool {
        self.db.clone()
    }

    pub fn create(
        &self,
        project: AppProject,
        roots: &[ProjectRoot],
    ) -> Result<ProjectWithRoots, AppError> {
        let value = ProjectWithRoots {
            project,
            roots: roots.to_vec(),
        };
        value.validate().map_err(AppError::Validation)?;
        if value
            .roots
            .iter()
            .filter(|root| root.kind == ProjectRootKind::Additional)
            .count()
            > MAX_ADDITIONAL_ROOTS
        {
            return Err(AppError::Validation(
                "at most five additional roots are supported".to_owned(),
            ));
        }
        let mut connection = self.db.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO projects (id, name, primary_root_id, root_revision, root_fingerprint, approval_mode_id, approval_mode_state, archived, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                value.project.id,
                value.project.name,
                value.project.primary_root_id,
                value.project.root_revision as i64,
                value.project.root_fingerprint,
                value.project.approval_mode_id,
                approval_state_as_str(&value.project.approval_mode_state),
                value.project.archived as i64,
                value.project.created_at,
                value.project.updated_at,
            ],
        )?;
        for root in &value.roots {
            insert_root(&transaction, root)?;
        }
        transaction.commit()?;
        self.get_by_id(&value.project.id)
    }

    pub fn get_by_id(&self, project_id: &str) -> Result<ProjectWithRoots, AppError> {
        let connection = self.db.connection()?;
        let project = connection
            .query_row(
                "SELECT id, name, primary_root_id, root_revision, root_fingerprint, approval_mode_id, approval_mode_state, archived, created_at, updated_at FROM projects WHERE id = ?1",
                [project_id],
                project_from_row,
            )
            .optional()?;
        let Some(project) = project else {
            return Err(AppError::NotFound(format!(
                "Project {project_id} was not found"
            )));
        };
        let mut statement = connection.prepare(
            "SELECT id, project_id, kind, path, real_path, label, sort_order, created_at, updated_at FROM project_roots WHERE project_id = ?1 ORDER BY sort_order",
        )?;
        let roots = statement
            .query_map([project_id], root_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        let value = ProjectWithRoots { project, roots };
        value.validate().map_err(|error| {
            AppError::Internal(format!("Stored project data is invalid: {error}"))
        })?;
        Ok(value)
    }

    pub fn find_by_id(&self, project_id: &str) -> Result<Option<ProjectWithRoots>, AppError> {
        match self.get_by_id(project_id) {
            Ok(project) => Ok(Some(project)),
            Err(AppError::NotFound(_)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn list(&self, include_archived: bool) -> Result<Vec<ProjectWithRoots>, AppError> {
        let connection = self.db.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, name, primary_root_id, root_revision, root_fingerprint, approval_mode_id, approval_mode_state, archived, created_at, updated_at FROM projects WHERE archived = 0 OR ?1 = 1 ORDER BY archived, updated_at DESC, name COLLATE NOCASE",
        )?;
        let projects = statement
            .query_map([include_archived as i64], project_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        projects
            .into_iter()
            .map(|project| {
                let mut roots_statement = connection.prepare(
                    "SELECT id, project_id, kind, path, real_path, label, sort_order, created_at, updated_at FROM project_roots WHERE project_id = ?1 ORDER BY sort_order",
                )?;
                let roots = roots_statement
                    .query_map([&project.id], root_from_row)?
                    .collect::<Result<Vec<_>, _>>()?;
                let value = ProjectWithRoots { project, roots };
                value.validate().map_err(|error| AppError::Internal(format!("Stored project data is invalid: {error}")))?;
                Ok(value)
            })
            .collect()
    }

    pub fn rename(
        &self,
        project_id: &str,
        name: &str,
        updated_at: &str,
    ) -> Result<ProjectWithRoots, AppError> {
        let connection = self.db.connection()?;
        let changed = connection.execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, updated_at, project_id],
        )?;
        if changed != 1 {
            return Err(AppError::NotFound(format!(
                "Project {project_id} was not found"
            )));
        }
        drop(connection);
        self.get_by_id(project_id)
    }

    pub fn set_archived(
        &self,
        project_id: &str,
        archived: bool,
        updated_at: &str,
    ) -> Result<ProjectWithRoots, AppError> {
        let connection = self.db.connection()?;
        let changed = connection.execute(
            "UPDATE projects SET archived = ?1, updated_at = ?2 WHERE id = ?3",
            params![archived as i64, updated_at, project_id],
        )?;
        if changed != 1 {
            return Err(AppError::NotFound(format!(
                "Project {project_id} was not found"
            )));
        }
        drop(connection);
        self.get_by_id(project_id)
    }

    pub fn set_approval_mode(
        &self,
        project_id: &str,
        mode_id: Option<&str>,
        state: ProjectApprovalModeState,
        updated_at: &str,
    ) -> Result<ProjectWithRoots, AppError> {
        if (mode_id.is_none()) != matches!(state, ProjectApprovalModeState::GeminiDefault) {
            return Err(AppError::Validation(
                "Gemini default requires no mode id; explicit modes require an availability state"
                    .to_owned(),
            ));
        }
        let connection = self.db.connection()?;
        let changed = connection.execute(
            "UPDATE projects SET approval_mode_id = ?1, approval_mode_state = ?2, updated_at = ?3 WHERE id = ?4",
            params![mode_id, approval_state_as_str(&state), updated_at, project_id],
        )?;
        if changed != 1 {
            return Err(AppError::NotFound(format!(
                "Project {project_id} was not found"
            )));
        }
        drop(connection);
        self.get_by_id(project_id)
    }

    pub fn replace_additional_roots(
        &self,
        project_id: &str,
        expected_root_revision: u64,
        new_root_revision: u64,
        root_fingerprint: &str,
        additional_roots: &[ProjectRoot],
        updated_at: &str,
    ) -> Result<ProjectWithRoots, AppError> {
        if additional_roots.len() > MAX_ADDITIONAL_ROOTS
            || additional_roots
                .iter()
                .any(|root| root.kind != ProjectRootKind::Additional)
        {
            return Err(AppError::Validation(
                "replaceAdditionalRoots accepts at most five additional roots only".to_owned(),
            ));
        }
        let mut connection = self.db.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE projects SET root_revision = ?1, root_fingerprint = ?2, updated_at = ?3 WHERE id = ?4 AND root_revision = ?5",
            params![new_root_revision as i64, root_fingerprint, updated_at, project_id, expected_root_revision as i64],
        )?;
        if changed != 1 {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                [project_id],
                |row| row.get(0),
            )?;
            return if exists {
                Err(AppError::Conflict(
                    "The project root revision changed before the update was committed".to_owned(),
                ))
            } else {
                Err(AppError::NotFound(format!(
                    "Project {project_id} was not found"
                )))
            };
        }
        transaction.execute(
            "DELETE FROM project_roots WHERE project_id = ?1 AND kind = 'additional'",
            [project_id],
        )?;
        for root in additional_roots {
            insert_root(&transaction, root)?;
        }
        transaction.execute(
            "UPDATE sessions SET status = 'roots_changed', updated_at = ?1 WHERE project_id = ?2",
            params![updated_at, project_id],
        )?;
        transaction.commit()?;
        self.get_by_id(project_id)
    }

    pub fn delete(&self, project_id: &str) -> Result<(), AppError> {
        let connection = self.db.connection()?;
        let changed = connection.execute("DELETE FROM projects WHERE id = ?1", [project_id])?;
        if changed != 1 {
            return Err(AppError::NotFound(format!(
                "Project {project_id} was not found"
            )));
        }
        Ok(())
    }
}

fn insert_root(
    transaction: &rusqlite::Transaction<'_>,
    root: &ProjectRoot,
) -> Result<(), AppError> {
    transaction.execute(
        "INSERT INTO project_roots (id, project_id, kind, path, real_path, label, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![root.id, root.project_id, root_kind_as_str(&root.kind), root.path, root.real_path, root.label, root.sort_order as i64, root.created_at, root.updated_at],
    )?;
    Ok(())
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AppProject> {
    Ok(AppProject {
        id: row.get(0)?,
        name: row.get(1)?,
        primary_root_id: row.get(2)?,
        root_revision: row.get::<_, i64>(3)? as u64,
        root_fingerprint: row.get(4)?,
        approval_mode_id: row.get(5)?,
        approval_mode_state: approval_state_from_str(&row.get::<_, String>(6)?)?,
        archived: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn root_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectRoot> {
    Ok(ProjectRoot {
        id: row.get(0)?,
        project_id: row.get(1)?,
        kind: root_kind_from_str(&row.get::<_, String>(2)?)?,
        path: row.get(3)?,
        real_path: row.get(4)?,
        label: row.get(5)?,
        sort_order: row.get::<_, i64>(6)? as usize,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn root_kind_as_str(kind: &ProjectRootKind) -> &'static str {
    match kind {
        ProjectRootKind::Primary => "primary",
        ProjectRootKind::Additional => "additional",
    }
}

fn root_kind_from_str(value: &str) -> rusqlite::Result<ProjectRootKind> {
    match value {
        "primary" => Ok(ProjectRootKind::Primary),
        "additional" => Ok(ProjectRootKind::Additional),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unknown root kind",
            )),
        )),
    }
}

fn approval_state_as_str(state: &ProjectApprovalModeState) -> &'static str {
    match state {
        ProjectApprovalModeState::GeminiDefault => "gemini_default",
        ProjectApprovalModeState::Available => "available",
        ProjectApprovalModeState::Unavailable => "unavailable",
    }
}

fn approval_state_from_str(value: &str) -> rusqlite::Result<ProjectApprovalModeState> {
    match value {
        "gemini_default" => Ok(ProjectApprovalModeState::GeminiDefault),
        "available" => Ok(ProjectApprovalModeState::Available),
        "unavailable" => Ok(ProjectApprovalModeState::Unavailable),
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            6,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unknown approval state",
            )),
        )),
    }
}
