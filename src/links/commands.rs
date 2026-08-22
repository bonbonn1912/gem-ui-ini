use super::{
    assert_public_url, normalize_url, resolve_attachment_target, PreviewBounds, PreviewHost,
    PreviewTarget,
};
use crate::context_attachments::{ContextAttachmentService, VoidResult};
use crate::error::AppError;
use crate::idempotency::idempotent;
use serde::Deserialize;
use tauri::{AppHandle, State};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenLinkPreviewInput {
    #[serde(default)]
    pub attachment_id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearLinkPreviewStorageInput {
    pub client_request_id: String,
}

#[tauri::command]
pub fn link_preview_open(
    app: AppHandle,
    context: State<'_, ContextAttachmentService>,
    host: State<'_, PreviewHost>,
    input: OpenLinkPreviewInput,
) -> Result<super::PreviewViewState, AppError> {
    let (attachment_id, url) = match (input.attachment_id, input.url) {
        (Some(attachment_id), Some(url)) => {
            let (stored, _) = resolve_attachment_target(&context.repository, &attachment_id)?;
            let supplied = normalize_url(&url)?.url;
            if normalize_url(&stored)?.url != supplied {
                return Err(AppError::Conflict(
                    "Die Vorschau-URL stimmt nicht mit dem Link-Anhang überein.".to_owned(),
                ));
            }
            (Some(attachment_id), stored)
        }
        (Some(attachment_id), None) => {
            let (stored, _) = resolve_attachment_target(&context.repository, &attachment_id)?;
            (Some(attachment_id), stored)
        }
        (None, Some(url)) => (None, url),
        (None, None) => {
            return Err(AppError::Validation(
                "attachmentId oder url ist erforderlich.".to_owned(),
            ))
        }
    };
    let normalized = assert_public_url(&url)?.url;
    host.open(
        &app,
        PreviewTarget {
            attachment_id,
            url: normalized,
        },
    )
}

#[tauri::command]
pub fn link_preview_set_bounds(
    host: State<'_, PreviewHost>,
    input: PreviewBounds,
) -> Result<VoidResult, AppError> {
    host.set_bounds(input)?;
    Ok(VoidResult { ok: true })
}

#[tauri::command]
pub fn link_preview_close(host: State<'_, PreviewHost>) -> Result<VoidResult, AppError> {
    host.close()?;
    Ok(VoidResult { ok: true })
}

#[tauri::command]
pub async fn link_preview_clear_storage(
    host: State<'_, PreviewHost>,
    context: State<'_, ContextAttachmentService>,
    input: ClearLinkPreviewStorageInput,
) -> Result<VoidResult, AppError> {
    idempotent(
        &context.client_requests,
        &input.client_request_id,
        "link-preview.clear-storage",
        || async {
            host.clear_storage()?;
            Ok(VoidResult { ok: true })
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::OpenLinkPreviewInput;

    #[test]
    fn open_input_rejects_missing_target_at_command_boundary() {
        let value = OpenLinkPreviewInput {
            attachment_id: None,
            url: None,
        };
        assert!(value.attachment_id.is_none() && value.url.is_none());
    }
}
