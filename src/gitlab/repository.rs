use super::contracts::*;
use crate::db::DbPool;
use crate::error::AppError;
use rusqlite::OptionalExtension;

#[derive(Clone)]
pub struct GitLabRepository {
    db: DbPool,
}
impl GitLabRepository {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }
    pub fn list_connections(&self) -> Result<Vec<GitLabConnectionSummary>, AppError> {
        let connection = self.db.connection()?;
        let mut stmt = connection.prepare("SELECT id, instance_url, api_base_url, user_id, username, display_name, access_mode, scopes_json, expires_at, last_validated_at, created_at, updated_at, allow_self_signed_tls FROM gitlab_connections ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |row| {
            let scopes =
                serde_json::from_str::<Vec<String>>(&row.get::<_, String>(7)?).unwrap_or_default();
            Ok(GitLabConnectionSummary {
                id: row.get(0)?,
                instance_url: row.get(1)?,
                api_base_url: row.get(2)?,
                user: GitLabUserSummary {
                    id: row.get(3)?,
                    username: row.get(4)?,
                    name: row.get(5)?,
                    avatar_url: None,
                },
                token_configured: true,
                access: parse_access(&row.get::<_, String>(6)?),
                scopes,
                expires_at: row.get(8)?,
                last_validated_at: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
                allow_self_signed_tls: row.get::<_, i64>(12)? != 0,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }
    pub fn token_cipher(&self, connection_id: &str) -> Result<Vec<u8>, AppError> {
        let connection = self.db.connection()?;
        connection
            .query_row(
                "SELECT token_cipher FROM gitlab_connections WHERE id = ?",
                [connection_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("GitLab connection not found.".into()))
    }
    pub fn save_connection(
        &self,
        summary: &GitLabConnectionSummary,
        token_cipher: &[u8],
    ) -> Result<GitLabConnectionSummary, AppError> {
        let connection = self.db.connection()?;
        connection.execute("INSERT INTO gitlab_connections(id,instance_url,api_base_url,user_id,username,display_name,token_cipher,access_mode,scopes_json,expires_at,last_validated_at,created_at,updated_at,allow_self_signed_tls) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instance_url,user_id) DO UPDATE SET api_base_url=excluded.api_base_url,username=excluded.username,display_name=excluded.display_name,token_cipher=excluded.token_cipher,access_mode=excluded.access_mode,scopes_json=excluded.scopes_json,expires_at=excluded.expires_at,last_validated_at=excluded.last_validated_at,updated_at=excluded.updated_at,allow_self_signed_tls=excluded.allow_self_signed_tls", rusqlite::params![summary.id, summary.instance_url, summary.api_base_url, summary.user.id, summary.user.username, summary.user.name, token_cipher, access_name(&summary.access), serde_json::to_string(&summary.scopes)?, summary.expires_at, summary.last_validated_at, summary.created_at, summary.updated_at, summary.allow_self_signed_tls as i64])?;
        drop(connection);
        self.list_connections()?
            .into_iter()
            .find(|value| {
                value.instance_url == summary.instance_url && value.user.id == summary.user.id
            })
            .ok_or_else(|| {
                AppError::Internal("GitLab-Verbindung konnte nicht gespeichert werden.".into())
            })
    }
    pub fn remove_connection(
        &self,
        connection_id: &str,
        force_disable_bindings: bool,
        now: &str,
    ) -> Result<(), AppError> {
        let connection = self.db.connection()?;
        let active: i64 = connection.query_row(
            "SELECT COUNT(*) FROM gitlab_repository_bindings WHERE connection_id=? AND enabled=1",
            [connection_id],
            |row| row.get(0),
        )?;
        if active > 0 && !force_disable_bindings {
            return Err(AppError::Conflict(
                "Diese Verbindung wird noch von aktiven Repository-Bindings verwendet.".into(),
            ));
        }
        if force_disable_bindings {
            connection.execute("UPDATE gitlab_repository_bindings SET enabled=0,updated_at=? WHERE connection_id=?", rusqlite::params![now, connection_id])?;
        }
        connection.execute(
            "DELETE FROM gitlab_repository_bindings WHERE connection_id=?",
            [connection_id],
        )?;
        if connection.execute("DELETE FROM gitlab_connections WHERE id=?", [connection_id])? == 0 {
            return Err(AppError::NotFound("GitLab connection not found.".into()));
        }
        Ok(())
    }
    pub fn list_bindings(
        &self,
        project_id: &str,
    ) -> Result<Vec<GitLabRepositoryBinding>, AppError> {
        let connection = self.db.connection()?;
        let mut stmt = connection.prepare("SELECT id, project_id, root_id, connection_id, repository_key, remote_name, remote_url, source_project_id, source_project_path, enabled, selected_target_project_id, selected_target_project_path, selected_merge_request_iid, last_synced_at, created_at, updated_at FROM gitlab_repository_bindings WHERE project_id = ? ORDER BY created_at ASC")?;
        let result = stmt
            .query_map([project_id], map_binding)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from);
        result
    }
    pub fn find_binding(
        &self,
        binding_id: &str,
    ) -> Result<Option<GitLabRepositoryBinding>, AppError> {
        let connection = self.db.connection()?;
        connection.query_row("SELECT id, project_id, root_id, connection_id, repository_key, remote_name, remote_url, source_project_id, source_project_path, enabled, selected_target_project_id, selected_target_project_path, selected_merge_request_iid, last_synced_at, created_at, updated_at FROM gitlab_repository_bindings WHERE id = ?", [binding_id], map_binding).optional().map_err(AppError::from)
    }
    pub fn save_binding(
        &self,
        binding: &GitLabRepositoryBinding,
    ) -> Result<GitLabRepositoryBinding, AppError> {
        let connection = self.db.connection()?;
        connection.execute("INSERT INTO gitlab_repository_bindings (id, project_id, root_id, connection_id, repository_key, remote_name, remote_url, source_project_id, source_project_path, enabled, selected_target_project_id, selected_target_project_path, selected_merge_request_iid, last_synced_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, repository_key) DO UPDATE SET root_id=excluded.root_id, connection_id=excluded.connection_id, remote_name=excluded.remote_name, remote_url=excluded.remote_url, source_project_id=excluded.source_project_id, source_project_path=excluded.source_project_path, enabled=excluded.enabled, selected_target_project_id=excluded.selected_target_project_id, selected_target_project_path=excluded.selected_target_project_path, selected_merge_request_iid=excluded.selected_merge_request_iid, last_synced_at=excluded.last_synced_at, updated_at=excluded.updated_at", rusqlite::params![binding.id, binding.project_id, binding.root_id, binding.connection_id, binding.repository_key, binding.remote_name, binding.remote_url, binding.source_project_id, binding.source_project_path, binding.enabled as i64, binding.selected_target_project_id, binding.selected_target_project_path, binding.selected_merge_request_iid, binding.last_synced_at, binding.created_at, binding.updated_at])?;
        drop(connection);
        self.find_binding(&binding.id)?
            .ok_or_else(|| AppError::Database(rusqlite::Error::QueryReturnedNoRows))
    }
    pub fn update_selection(
        &self,
        binding_id: &str,
        target_project_id: i64,
        target_project_path: &str,
        merge_request_iid: i64,
        updated_at: &str,
    ) -> Result<GitLabRepositoryBinding, AppError> {
        let connection = self.db.connection()?;
        let changed = connection.execute("UPDATE gitlab_repository_bindings SET selected_target_project_id=?, selected_target_project_path=?, selected_merge_request_iid=?, updated_at=? WHERE id=?", rusqlite::params![target_project_id, target_project_path, merge_request_iid, updated_at, binding_id])?;
        if changed == 0 {
            return Err(AppError::NotFound("GitLab binding not found.".into()));
        }
        drop(connection);
        self.find_binding(binding_id)?
            .ok_or_else(|| AppError::NotFound("GitLab binding not found.".into()))
    }
    pub fn disable_binding(&self, binding_id: &str, updated_at: &str) -> Result<(), AppError> {
        let connection = self.db.connection()?;
        if connection.execute(
            "UPDATE gitlab_repository_bindings SET enabled=0, updated_at=? WHERE id=?",
            [updated_at, binding_id],
        )? == 0
        {
            return Err(AppError::NotFound("GitLab binding not found.".into()));
        }
        Ok(())
    }
}

fn parse_access(value: &str) -> GitLabAccessMode {
    match value {
        "read_only" => GitLabAccessMode::ReadOnly,
        "read_write" => GitLabAccessMode::ReadWrite,
        "reauthentication_required" => GitLabAccessMode::ReauthenticationRequired,
        _ => GitLabAccessMode::Unknown,
    }
}
fn access_name(value: &GitLabAccessMode) -> &'static str {
    match value {
        GitLabAccessMode::ReadOnly => "read_only",
        GitLabAccessMode::ReadWrite => "read_write",
        GitLabAccessMode::ReauthenticationRequired => "reauthentication_required",
        GitLabAccessMode::Unknown => "unknown",
    }
}
fn map_binding(row: &rusqlite::Row<'_>) -> rusqlite::Result<GitLabRepositoryBinding> {
    Ok(GitLabRepositoryBinding {
        id: row.get(0)?,
        project_id: row.get(1)?,
        root_id: row.get(2)?,
        connection_id: row.get(3)?,
        repository_key: row.get(4)?,
        remote_name: row.get(5)?,
        remote_url: row.get(6)?,
        source_project_id: row.get(7)?,
        source_project_path: row.get(8)?,
        enabled: row.get::<_, i64>(9)? != 0,
        selected_target_project_id: row.get(10)?,
        selected_target_project_path: row.get(11)?,
        selected_merge_request_iid: row.get(12)?,
        last_synced_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}
