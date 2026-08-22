use super::*;
use crate::error::AppError;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

#[tauri::command]
pub fn todos_list(
    state: State<'_, TodoService>,
    input: ListTodosInput,
) -> Result<TodoList, AppError> {
    state.list(input)
}
#[tauri::command]
pub async fn todos_create(
    state: State<'_, TodoService>,
    hub: State<'_, TodoSubscriptionHub>,
    input: CreateTodoInput,
) -> Result<TodoList, AppError> {
    let result = state.create(input).await?;
    hub.notify(&result.project_id, result.clone());
    Ok(result)
}
#[tauri::command]
pub async fn todos_update(
    state: State<'_, TodoService>,
    hub: State<'_, TodoSubscriptionHub>,
    input: UpdateTodoInput,
) -> Result<TodoList, AppError> {
    let result = state.update(input).await?;
    hub.notify(&result.project_id, result.clone());
    Ok(result)
}
#[tauri::command]
pub async fn todos_reorder(
    state: State<'_, TodoService>,
    hub: State<'_, TodoSubscriptionHub>,
    input: ReorderTodosInput,
) -> Result<TodoList, AppError> {
    let result = state.reorder(input).await?;
    hub.notify(&result.project_id, result.clone());
    Ok(result)
}
#[tauri::command]
pub async fn todos_delete(
    state: State<'_, TodoService>,
    hub: State<'_, TodoSubscriptionHub>,
    input: DeleteTodoInput,
) -> Result<TodoList, AppError> {
    let result = state.delete(input).await?;
    hub.notify(&result.project_id, result.clone());
    Ok(result)
}
#[tauri::command]
pub async fn todos_add_files(
    app: AppHandle,
    state: State<'_, TodoService>,
    hub: State<'_, TodoSubscriptionHub>,
    mut input: AddTodoFilesInput,
) -> Result<TodoList, AppError> {
    // An empty path list means "choose files" in the legacy Electron IPC.
    // Keep the picker here instead of forcing the renderer to know platform
    // dialog details; dropped files still pass their explicit paths through.
    if input.paths.is_empty() {
        let (sender, receiver) = oneshot::channel::<Option<Vec<FilePath>>>();
        app.dialog()
            .file()
            .set_title("Dateien an Todo anhängen")
            .pick_files(move |paths| {
                let _ = sender.send(paths);
            });
        let selected = receiver
            .await
            .map_err(|_| {
                AppError::Internal("Dateiauswahl wurde unerwartet geschlossen".to_owned())
            })?
            .unwrap_or_default();
        if selected.is_empty() {
            let project_id = state.repository.project_id_of(&input.todo_id)?;
            return state.list(ListTodosInput { project_id });
        }
        input.paths = selected
            .into_iter()
            .map(|value| {
                value
                    .into_path()
                    .map_err(|error| AppError::Validation(error.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
    }
    let result = state.add_files(input).await?;
    hub.notify(&result.project_id, result.clone());
    Ok(result)
}
#[tauri::command]
pub async fn todos_add_link(
    state: State<'_, TodoService>,
    hub: State<'_, TodoSubscriptionHub>,
    input: AddTodoLinkInput,
) -> Result<TodoList, AppError> {
    let result = state.add_link(input).await?;
    hub.notify(&result.project_id, result.clone());
    Ok(result)
}
#[tauri::command]
pub async fn todos_attach_attachment(
    state: State<'_, TodoService>,
    hub: State<'_, TodoSubscriptionHub>,
    input: TodoAttachmentInput,
) -> Result<TodoList, AppError> {
    let result = state.attach(input).await?;
    hub.notify(&result.project_id, result.clone());
    Ok(result)
}
#[tauri::command]
pub async fn todos_detach_attachment(
    state: State<'_, TodoService>,
    hub: State<'_, TodoSubscriptionHub>,
    input: TodoAttachmentInput,
) -> Result<TodoList, AppError> {
    let result = state.detach(input).await?;
    hub.notify(&result.project_id, result.clone());
    Ok(result)
}
#[tauri::command]
pub async fn todos_prepare_for_session(
    state: State<'_, TodoService>,
    hub: State<'_, TodoSubscriptionHub>,
    input: PrepareTodoForSessionInput,
) -> Result<TodoPromptDraft, AppError> {
    let result = state.prepare_for_session(input).await?;
    hub.notify(
        &result.context_attachments.project_id,
        state.list(ListTodosInput {
            project_id: result.context_attachments.project_id.clone(),
        })?,
    );
    Ok(result)
}
