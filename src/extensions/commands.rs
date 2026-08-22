//! Tauri command adapters for the bounded Gemini extension scanner.

use super::scanner::{
    AgentExtensionService, GeminiSkillList, ListAgentExtensionsInput, McpServerList,
};
use crate::error::AppError;
use std::sync::Arc;
use tauri::State;

pub struct AgentExtensionCommandState {
    pub service: Arc<AgentExtensionService>,
}

#[tauri::command]
pub fn agent_extensions_list_skills(
    state: State<'_, AgentExtensionCommandState>,
    input: ListAgentExtensionsInput,
) -> Result<GeminiSkillList, AppError> {
    state.service.list_skills(input)
}

#[tauri::command]
pub fn agent_extensions_list_mcp_servers(
    state: State<'_, AgentExtensionCommandState>,
    input: ListAgentExtensionsInput,
) -> Result<McpServerList, AppError> {
    state.service.list_mcp_servers(input)
}
