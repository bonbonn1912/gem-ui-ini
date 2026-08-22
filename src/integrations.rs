use crate::db::DbPool;
use crate::error::AppError;
use crate::gitlab::GitLabRepository;
use crate::jira::JiraRepository;
use serde::{Deserialize, Serialize};
use tauri::State;

pub struct IntegrationCommandState {
    db: DbPool,
}

impl IntegrationCommandState {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListProjectIntegrationsInput {
    pub project_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIntegrationStatus {
    pub kind: &'static str,
    pub enabled: bool,
    pub active_bindings_count: usize,
    pub total_bindings_count: usize,
}

#[tauri::command]
pub fn integrations_list_project(
    state: State<'_, IntegrationCommandState>,
    input: ListProjectIntegrationsInput,
) -> Result<Vec<ProjectIntegrationStatus>, AppError> {
    let exists: i64 = state.db.connection()?.query_row(
        "SELECT COUNT(*) FROM projects WHERE id = ?1",
        [&input.project_id],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Err(AppError::NotFound("Projekt nicht gefunden.".to_owned()));
    }

    let gitlab = GitLabRepository::new(state.db.clone());
    let bindings = gitlab.list_bindings(&input.project_id)?;
    let active_gitlab = bindings.iter().filter(|binding| binding.enabled).count();
    let jira = JiraRepository::new(state.db.clone());
    let active_jira = usize::from(jira.get_project_integration(&input.project_id)?.is_some());
    let jira_configs = jira.list_configs()?.len();

    Ok(vec![
        ProjectIntegrationStatus {
            kind: "gitlab",
            enabled: active_gitlab > 0,
            active_bindings_count: active_gitlab,
            total_bindings_count: bindings.len(),
        },
        ProjectIntegrationStatus {
            kind: "jira",
            enabled: active_jira > 0,
            active_bindings_count: active_jira,
            total_bindings_count: jira_configs,
        },
    ])
}
