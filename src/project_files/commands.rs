use super::*;
use crate::error::AppError;
use tauri::State;

#[tauri::command]
pub fn project_files_search(
    state: State<'_, ProjectFileService>,
    input: SearchProjectFilesInput,
) -> Result<ProjectFileSearchResult, AppError> {
    state.search(input)
}
