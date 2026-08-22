use super::contracts::{JiraConfig, JiraProjectIntegration};
use crate::db::DbPool;
use crate::error::AppError;
use rusqlite::OptionalExtension;

pub struct JiraRepository {
    db: DbPool,
}
impl JiraRepository {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }
    pub fn list_configs(&self) -> Result<Vec<JiraConfig>, AppError> {
        let connection = self.db.connection()?;
        let mut stmt = connection.prepare("SELECT id,name,base_url,issue_prefixes_json,created_at,updated_at FROM jira_configs ORDER BY name COLLATE NOCASE")?;
        let result = stmt
            .query_map([], map_config)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from);
        result
    }
    pub fn find_config(&self, id: &str) -> Result<Option<JiraConfig>, AppError> {
        let connection = self.db.connection()?;
        connection.query_row("SELECT id,name,base_url,issue_prefixes_json,created_at,updated_at FROM jira_configs WHERE id=?", [id], map_config).optional().map_err(AppError::from)
    }
    pub fn find_config_by_name(&self, name: &str) -> Result<Option<JiraConfig>, AppError> {
        let connection = self.db.connection()?;
        connection
            .query_row(
                "SELECT id,name,base_url,issue_prefixes_json,created_at,updated_at FROM jira_configs WHERE name=? COLLATE NOCASE",
                [name],
                map_config,
            )
            .optional()
            .map_err(AppError::from)
    }
    pub fn save_config(&self, config: &JiraConfig) -> Result<JiraConfig, AppError> {
        let connection = self.db.connection()?;
        connection.execute("INSERT INTO jira_configs (id,name,base_url,issue_prefixes_json,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,issue_prefixes_json=excluded.issue_prefixes_json,updated_at=excluded.updated_at", rusqlite::params![config.id, config.name, config.base_url, serde_json::to_string(&config.issue_prefixes)?, config.created_at, config.updated_at])?;
        drop(connection);
        self.find_config(&config.id)?
            .ok_or_else(|| AppError::NotFound("Jira-Konfiguration nicht gefunden.".into()))
    }
    pub fn delete_config(&self, id: &str) -> Result<(), AppError> {
        let connection = self.db.connection()?;
        if connection.execute("DELETE FROM jira_configs WHERE id=?", [id])? == 0 {
            return Err(AppError::NotFound(
                "Jira-Konfiguration nicht gefunden.".into(),
            ));
        }
        Ok(())
    }
    pub fn get_project_integration(
        &self,
        project_id: &str,
    ) -> Result<Option<(String, String)>, AppError> {
        let connection = self.db.connection()?;
        connection
            .query_row(
                "SELECT config_id,updated_at FROM jira_project_integrations WHERE project_id=?",
                [project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(AppError::from)
    }
    pub fn activate(&self, project_id: &str, config_id: &str, now: &str) -> Result<(), AppError> {
        let connection = self.db.connection()?;
        connection.execute("INSERT INTO jira_project_integrations(project_id,config_id,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET config_id=excluded.config_id,updated_at=excluded.updated_at", rusqlite::params![project_id, config_id, now, now])?;
        Ok(())
    }
    pub fn deactivate(&self, project_id: &str) -> Result<(), AppError> {
        self.db.connection()?.execute(
            "DELETE FROM jira_project_integrations WHERE project_id=?",
            [project_id],
        )?;
        Ok(())
    }
    pub fn project_integration(
        &self,
        project_id: &str,
    ) -> Result<JiraProjectIntegration, AppError> {
        let Some((config_id, updated_at)) = self.get_project_integration(project_id)? else {
            return Ok(JiraProjectIntegration {
                project_id: project_id.into(),
                active_config_id: None,
                active_config: None,
                updated_at: None,
            });
        };
        let config = self.find_config(&config_id)?.ok_or_else(|| {
            AppError::Internal("Jira activation points to missing config.".into())
        })?;
        Ok(JiraProjectIntegration {
            project_id: project_id.into(),
            active_config_id: Some(config.id.clone()),
            active_config: Some(config),
            updated_at: Some(updated_at),
        })
    }
}
fn map_config(row: &rusqlite::Row<'_>) -> rusqlite::Result<JiraConfig> {
    let prefixes =
        serde_json::from_str::<Vec<String>>(&row.get::<_, String>(3)?).unwrap_or_default();
    Ok(JiraConfig {
        id: row.get(0)?,
        name: row.get(1)?,
        base_url: row.get(2)?,
        issue_prefixes: prefixes,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}
