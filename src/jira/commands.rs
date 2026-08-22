//! Tauri command adapters for the Jira integration.

use super::contracts::*;
use super::service::{ContextAttachmentIngestor, JiraService};
use crate::error::AppError;
use std::sync::Arc;
use tauri::State;

#[derive(Debug, serde::Serialize)]
pub struct VoidResult {
    pub ok: bool,
}

pub struct JiraCommandState {
    pub service: Arc<JiraService<Arc<dyn ContextAttachmentIngestor>>>,
}

#[tauri::command]
pub fn jira_list_configs(state: State<'_, JiraCommandState>) -> Result<Vec<JiraConfig>, AppError> {
    state.service.list_configs()
}

#[tauri::command]
pub fn jira_save_config(
    state: State<'_, JiraCommandState>,
    input: SaveJiraConfigInput,
) -> Result<JiraConfig, AppError> {
    state.service.save_config(input)
}

#[tauri::command]
pub fn jira_delete_config(
    state: State<'_, JiraCommandState>,
    input: DeleteJiraConfigInput,
) -> Result<VoidResult, AppError> {
    state.service.delete_config(input)?;
    Ok(VoidResult { ok: true })
}

#[tauri::command]
pub fn jira_get_project_integration(
    state: State<'_, JiraCommandState>,
    input: GetJiraProjectIntegrationInput,
) -> Result<JiraProjectIntegration, AppError> {
    state.service.project_integration(&input.project_id)
}

#[tauri::command]
pub fn jira_activate_project_integration(
    state: State<'_, JiraCommandState>,
    input: ActivateJiraProjectIntegrationInput,
) -> Result<JiraProjectIntegration, AppError> {
    state.service.activate(input)
}

#[tauri::command]
pub fn jira_deactivate_project_integration(
    state: State<'_, JiraCommandState>,
    input: DeactivateJiraProjectIntegrationInput,
) -> Result<JiraProjectIntegration, AppError> {
    state.service.deactivate(input)
}

#[tauri::command]
pub fn jira_attach_issue(
    state: State<'_, JiraCommandState>,
    input: AttachJiraIssueInput,
) -> Result<AttachJiraIssueResult, AppError> {
    state.service.attach_issue(input)
}
