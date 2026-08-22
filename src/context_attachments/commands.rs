use super::*;
use crate::error::AppError;
use crate::links::LinkMetadataFetcherService;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

#[tauri::command]
pub fn context_attachments_list(
    state: State<'_, ContextAttachmentService>,
    input: ListContextAttachmentsInput,
) -> Result<ContextAttachmentList, AppError> {
    state.list(input)
}

#[tauri::command]
pub async fn context_attachments_add_files(
    app: AppHandle,
    state: State<'_, ContextAttachmentService>,
    hub: State<'_, ContextAttachmentSubscriptionHub>,
    mut input: AddContextFilesInput,
) -> Result<ContextAttachmentList, AppError> {
    // The Electron handler opened the native picker when the renderer sent an
    // empty path list.  Keep that behavior in the command boundary so the
    // Solid UI can use the same request for both picker and drag/drop flows.
    if input.paths.is_empty() {
        let (sender, receiver) = oneshot::channel::<Option<Vec<FilePath>>>();
        app.dialog()
            .file()
            .set_title("Dateien anhängen")
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
            return state.list(ListContextAttachmentsInput {
                project_id: input.project_id,
                session_id: input.session_id,
            });
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
    let result = state.add_files_request(input).await?;
    hub.notify(&state, &result.project_id);
    Ok(result)
}

#[tauri::command]
pub async fn context_attachments_add_link(
    state: State<'_, ContextAttachmentService>,
    hub: State<'_, ContextAttachmentSubscriptionHub>,
    input: AddContextLinkInput,
) -> Result<ContextAttachmentList, AppError> {
    let result = state.add_link_request(input).await?;
    hub.notify(&state, &result.project_id);
    Ok(result)
}

#[tauri::command]
pub async fn context_attachments_update(
    state: State<'_, ContextAttachmentService>,
    hub: State<'_, ContextAttachmentSubscriptionHub>,
    input: UpdateContextAttachmentInput,
) -> Result<ContextAttachmentList, AppError> {
    let result = state.update_request(input).await?;
    hub.notify(&state, &result.project_id);
    Ok(result)
}

#[tauri::command]
pub async fn context_attachments_set_inclusion(
    state: State<'_, ContextAttachmentService>,
    hub: State<'_, ContextAttachmentSubscriptionHub>,
    input: SetContextInclusionInput,
) -> Result<ContextAttachmentList, AppError> {
    let result = state.set_inclusion_request(input).await?;
    hub.notify(&state, &result.project_id);
    Ok(result)
}

#[tauri::command]
pub async fn context_attachments_remove(
    state: State<'_, ContextAttachmentService>,
    hub: State<'_, ContextAttachmentSubscriptionHub>,
    input: RemoveContextAttachmentInput,
) -> Result<ContextAttachmentList, AppError> {
    let result = state.remove_request(input).await?;
    hub.notify(&state, &result.project_id);
    Ok(result)
}

#[tauri::command]
pub async fn context_attachments_refresh_link_preview(
    state: State<'_, ContextAttachmentService>,
    hub: State<'_, ContextAttachmentSubscriptionHub>,
    fetcher: State<'_, LinkMetadataFetcherService>,
    input: RefreshLinkPreviewInput,
) -> Result<ContextAttachmentList, AppError> {
    let result = state
        .refresh_link_preview_request(input, Arc::clone(&fetcher.inner))
        .await?;
    hub.notify(&state, &result.project_id);
    Ok(result)
}

#[tauri::command]
pub fn context_attachments_get_bytes(
    state: State<'_, ContextAttachmentService>,
    input: ContextAttachmentBytesInput,
) -> Result<Vec<u8>, AppError> {
    state.get_bytes(input)
}

#[tauri::command]
pub fn context_attachments_open_file(
    app: AppHandle,
    state: State<'_, ContextAttachmentService>,
    input: OpenContextAttachmentInput,
) -> Result<VoidResult, AppError> {
    let path = state.original_path(&input.attachment_id)?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<String>)
        .map_err(|_| AppError::Upstream("Die Datei konnte nicht geöffnet werden.".to_owned()))?;
    Ok(VoidResult { ok: true })
}
