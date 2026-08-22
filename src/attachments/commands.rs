use super::*;
use crate::error::AppError;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

#[tauri::command]
pub async fn attachments_pick_images(
    app: AppHandle,
    state: State<'_, AttachmentService>,
    input: PickImagesInput,
) -> Result<Vec<Attachment>, AppError> {
    let (sender, receiver) = oneshot::channel::<Option<Vec<FilePath>>>();
    app.dialog()
        .file()
        .set_title("Bilder auswählen")
        .add_filter("Bilder", &["png", "jpg", "jpeg", "webp", "gif"])
        .pick_files(move |paths| {
            let _ = sender.send(paths);
        });
    let paths = receiver
        .await
        .map_err(|_| AppError::Internal("Bildauswahl wurde unerwartet geschlossen".to_owned()))?
        .unwrap_or_default()
        .into_iter()
        .map(|value| {
            value
                .into_path()
                .map_err(|error| AppError::Validation(error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    state.stage_picked_paths(input, paths).await
}
#[tauri::command]
pub async fn attachments_stage_dropped_paths(
    state: State<'_, AttachmentService>,
    input: StageDroppedPathInput,
) -> Result<Vec<Attachment>, AppError> {
    state.stage_dropped_paths(input).await
}
#[tauri::command]
pub async fn attachments_stage_clipboard_image(
    state: State<'_, AttachmentService>,
    input: ClipboardImageInput,
) -> Result<Attachment, AppError> {
    state.stage_clipboard_image(input).await
}
#[tauri::command]
pub fn attachments_get_preview(
    state: State<'_, AttachmentService>,
    input: AttachmentPreviewInput,
) -> Result<Vec<u8>, AppError> {
    state.preview_bytes(&input.attachment_id)
}
#[tauri::command]
pub async fn attachments_remove(
    state: State<'_, AttachmentService>,
    input: RemoveAttachmentInput,
) -> Result<AttachmentVoidResult, AppError> {
    state.remove_request(input).await
}
