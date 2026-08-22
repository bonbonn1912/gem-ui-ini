use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalRect, LogicalSize, Manager, Webview, WebviewUrl};
use tauri_plugin_opener::OpenerExt;

const PREVIEW_LABEL: &str = "preview";
const PREVIEW_DATA_STORE_ID: [u8; 16] = [
    0x8a, 0x62, 0x2f, 0x4b, 0x9c, 0x31, 0x44, 0xa7, 0x93, 0xe1, 0x11, 0x5d, 0x75, 0x0a, 0xc9, 0x42,
];

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PreviewBounds {
    pub fn validate(&self) -> Result<(), AppError> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite())
            || self.width < 0.0
            || self.height < 0.0
            || self.width > 10_000.0
            || self.height > 10_000.0
        {
            return Err(AppError::Validation(
                "preview bounds are outside the supported range".to_owned(),
            ));
        }
        Ok(())
    }

    fn rect(&self) -> LogicalRect<f64, f64> {
        LogicalRect {
            position: LogicalPosition::new(self.x.round(), self.y.round()),
            size: LogicalSize::new(self.width.round(), self.height.round()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct PreviewTarget {
    pub attachment_id: Option<String>,
    pub url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewViewState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
    pub url: String,
    pub host: String,
    pub loading: bool,
}

struct ActivePreview {
    webview: Webview,
    bounds: PreviewBounds,
}

/// Owns the single isolated browser surface shared by link attachments and
/// Jira. The child WebView has no Tauri command capability, denies downloads,
/// rejects non-HTTPS navigation and uses a dedicated persistent data store.
pub struct PreviewHost {
    data_directory: PathBuf,
    active: Mutex<Option<ActivePreview>>,
}

impl PreviewHost {
    pub fn new(data_directory: PathBuf) -> Self {
        Self {
            data_directory,
            active: Mutex::new(None),
        }
    }

    pub fn open(
        &self,
        app: &AppHandle,
        target: PreviewTarget,
    ) -> Result<PreviewViewState, AppError> {
        let url = normalize_https_url(&target.url)?;
        let host = url
            .host_str()
            .ok_or_else(|| AppError::Validation("Die Adresse besitzt keinen Host.".to_owned()))?
            .to_owned();
        self.close()?;

        let window = app
            .get_window("main")
            .ok_or_else(|| AppError::Internal("main window is unavailable".to_owned()))?;
        let opener = app.clone();
        let builder = WebviewBuilder::new(PREVIEW_LABEL, WebviewUrl::External(url.clone()))
            .data_directory(self.data_directory.clone())
            .data_store_identifier(PREVIEW_DATA_STORE_ID)
            .devtools(false)
            .on_navigation(is_safe_https)
            .on_new_window(move |candidate, _features| {
                if is_safe_https(&candidate) {
                    let _ = opener
                        .opener()
                        .open_url(candidate.to_string(), None::<String>);
                }
                NewWindowResponse::Deny
            })
            .on_download(|_webview, event| !matches!(event, DownloadEvent::Requested { .. }));
        let initial_bounds = PreviewBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
        let webview = window
            .add_child(
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(0.0, 0.0),
            )
            .map_err(|_| AppError::Internal("preview webview could not be created".to_owned()))?;
        *self.active.lock().map_err(|_| AppError::StatePoisoned)? = Some(ActivePreview {
            webview,
            bounds: initial_bounds,
        });

        Ok(PreviewViewState {
            attachment_id: target.attachment_id,
            url: url.to_string(),
            host,
            loading: false,
        })
    }

    pub fn set_bounds(&self, bounds: PreviewBounds) -> Result<(), AppError> {
        bounds.validate()?;
        let mut active = self.active.lock().map_err(|_| AppError::StatePoisoned)?;
        if let Some(preview) = active.as_mut() {
            preview
                .webview
                .set_bounds(tauri::Rect {
                    position: tauri::Position::Logical(bounds.rect().position),
                    size: tauri::Size::Logical(bounds.rect().size),
                })
                .map_err(|_| {
                    AppError::Internal("preview bounds could not be updated".to_owned())
                })?;
            preview.bounds = bounds;
        }
        Ok(())
    }

    pub fn close(&self) -> Result<(), AppError> {
        let preview = self
            .active
            .lock()
            .map_err(|_| AppError::StatePoisoned)?
            .take();
        if let Some(preview) = preview {
            preview.webview.close().map_err(|_| {
                AppError::Internal("preview webview could not be closed".to_owned())
            })?;
        }
        Ok(())
    }

    pub fn clear_storage(&self) -> Result<(), AppError> {
        let preview = self
            .active
            .lock()
            .map_err(|_| AppError::StatePoisoned)?
            .take();
        if let Some(preview) = preview {
            preview.webview.clear_all_browsing_data().map_err(|_| {
                AppError::Internal("preview browsing data could not be cleared".to_owned())
            })?;
            preview.webview.close().map_err(|_| {
                AppError::Internal("preview webview could not be closed".to_owned())
            })?;
        }
        Ok(())
    }
}

fn normalize_https_url(value: &str) -> Result<tauri::Url, AppError> {
    let mut url = value
        .trim()
        .parse::<tauri::Url>()
        .map_err(|_| AppError::Validation("Die Adresse ist keine gültige URL.".to_owned()))?;
    if !is_safe_https(&url) {
        return Err(AppError::Validation(
            "Nur HTTPS-Links ohne eingebettete Zugangsdaten sind erlaubt.".to_owned(),
        ));
    }
    url.set_fragment(None);
    if url.port() == Some(443) {
        let _ = url.set_port(None);
    }
    Ok(url)
}

fn is_safe_https(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::{normalize_https_url, PreviewBounds};

    #[test]
    fn preview_accepts_https_and_removes_credentials_adjacent_noise() {
        let url = normalize_https_url(" https://Example.COM:443/path#fragment ").unwrap();
        assert_eq!(url.as_str(), "https://example.com/path");
        assert!(normalize_https_url("http://example.com").is_err());
        assert!(normalize_https_url("https://user:secret@example.com").is_err());
    }

    #[test]
    fn bounds_reject_non_finite_negative_and_giant_sizes() {
        assert!(PreviewBounds {
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 800.0,
        }
        .validate()
        .is_ok());
        for bounds in [
            PreviewBounds {
                x: f64::NAN,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            PreviewBounds {
                x: 0.0,
                y: 0.0,
                width: -1.0,
                height: 1.0,
            },
            PreviewBounds {
                x: 0.0,
                y: 0.0,
                width: 10_001.0,
                height: 1.0,
            },
        ] {
            assert!(bounds.validate().is_err());
        }
    }
}
