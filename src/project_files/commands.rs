use super::*;
use crate::error::AppError;
use tauri::State;

#[tauri::command]
pub async fn project_files_search(
    state: State<'_, ProjectFileService>,
    input: SearchProjectFilesInput,
) -> Result<ProjectFileSearchResult, AppError> {
    let service = state.inner().clone();
    tokio::task::spawn_blocking(move || service.search(input))
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?
}
