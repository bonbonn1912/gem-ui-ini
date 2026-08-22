//! Signed update commands backed exclusively by `tauri-plugin-updater`.
//!
//! The renderer keeps its existing explicit check/download/install workflow.
//! The plugin fetches `latest.json`, verifies the Minisign signature while
//! downloading and performs the native installation.

use crate::error::AppError;
use crate::updates::service::{AppUpdateDownloadProgress, AppUpdateInfo, DownloadUpdateResult};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{plugin::TauriPlugin, Emitter, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use uuid::Uuid;

const PROGRESS_EVENT: &str = "app:update-download-progress";
const DOWNLOAD_DIR: &str = "geminui-updates";
const DOWNLOAD_PREFIX: &str = "geminui-update-";
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;

pub fn init<R: Runtime>() -> TauriPlugin<R, tauri_plugin_updater::Config> {
    tauri_plugin_updater::Builder::new().build()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadUpdateInput {
    pub download_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallUpdateInput {
    pub file_path: String,
}

#[derive(Debug, serde::Serialize)]
pub struct VoidResult {
    pub ok: bool,
}

#[tauri::command]
pub async fn app_check_for_updates(app: tauri::AppHandle) -> Result<AppUpdateInfo, AppError> {
    let current_version = app.package_info().version.to_string();
    match app.updater().map_err(updater_error)?.check().await {
        Ok(Some(update)) => Ok(AppUpdateInfo {
            current_version,
            latest_version: Some(update.version.clone()),
            update_available: true,
            release_name: Some(format!("GeminUI {}", update.version)),
            release_notes: update.body.clone(),
            published_at: update.date.and_then(|date| {
                date.format(&time::format_description::well_known::Rfc3339)
                    .ok()
            }),
            html_url: None,
            download_url: Some(update.download_url.to_string()),
            error: None,
        }),
        Ok(None) => Ok(AppUpdateInfo {
            current_version,
            latest_version: None,
            update_available: false,
            release_name: None,
            release_notes: None,
            published_at: None,
            html_url: None,
            download_url: None,
            error: None,
        }),
        Err(error) => Ok(AppUpdateInfo {
            current_version,
            latest_version: None,
            update_available: false,
            release_name: None,
            release_notes: None,
            published_at: None,
            html_url: None,
            download_url: None,
            error: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn app_download_update(
    app: tauri::AppHandle,
    input: DownloadUpdateInput,
) -> Result<DownloadUpdateResult, AppError> {
    let update = require_current_update(&app).await?;
    if update.download_url.as_str() != input.download_url.trim() {
        return Err(AppError::Conflict(
            "Die Update-URL ist nicht mehr aktuell. Bitte prüfe erneut auf Updates.".into(),
        ));
    }

    let app_for_events = app.clone();
    let mut received = 0_u64;
    let bytes = update
        .download(
            move |chunk_size, content_length| {
                received = received.saturating_add(chunk_size as u64);
                let total = content_length.unwrap_or(0).max(received);
                let progress = AppUpdateDownloadProgress {
                    received_bytes: received,
                    total_bytes: total,
                    percent: received
                        .saturating_mul(100)
                        .checked_div(total)
                        .unwrap_or(0)
                        .min(100) as u8,
                };
                let _ = app_for_events.emit(PROGRESS_EVENT, progress);
            },
            || {},
        )
        .await
        .map_err(updater_error)?;
    if bytes.len() as u64 > MAX_UPDATE_BYTES {
        return Err(AppError::Validation(
            "Das Update überschreitet die maximal erlaubte Größe.".into(),
        ));
    }

    let directory = download_directory();
    ensure_private_directory(&directory).await?;
    let path = directory.join(format!("{DOWNLOAD_PREFIX}{}", Uuid::new_v4()));
    write_private_file(&path, &bytes).await?;
    if let Err(error) =
        write_metadata(&path, update.download_url.as_str(), &update.version, &bytes).await
    {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    Ok(DownloadUpdateResult {
        file_path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn app_install_update(
    app: tauri::AppHandle,
    input: InstallUpdateInput,
) -> Result<VoidResult, AppError> {
    let path = validate_download_path(&input.file_path)?;
    let bytes = tokio::fs::read(&path).await?;
    if bytes.len() as u64 > MAX_UPDATE_BYTES {
        return Err(AppError::Validation(
            "Das Update überschreitet die maximal erlaubte Größe.".into(),
        ));
    }
    let metadata = verify_metadata(&path, &bytes).await?;
    let update = require_current_update(&app).await?;
    if update.download_url.as_str() != metadata.url || update.version != metadata.version {
        return Err(AppError::Conflict(
            "Das Update ist nicht mehr aktuell. Bitte prüfe erneut auf Updates.".into(),
        ));
    }
    update.install(&bytes).map_err(updater_error)?;
    Ok(VoidResult { ok: true })
}

async fn require_current_update(app: &tauri::AppHandle) -> Result<Update, AppError> {
    app.updater()
        .map_err(updater_error)?
        .check()
        .await
        .map_err(updater_error)?
        .ok_or_else(|| AppError::NotFound("Kein signiertes Update verfügbar.".into()))
}

fn updater_error(error: impl std::fmt::Display) -> AppError {
    AppError::Upstream(format!("Tauri-Updater: {error}"))
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct DownloadMetadata {
    url: String,
    version: String,
    sha256: String,
}

async fn write_metadata(
    path: &Path,
    url: &str,
    version: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    let mut digest = Sha256::new();
    digest.update(bytes);
    let metadata = DownloadMetadata {
        url: url.to_owned(),
        version: version.to_owned(),
        sha256: format!("{:x}", digest.finalize()),
    };
    write_private_file(
        &path.with_extension("meta"),
        &serde_json::to_vec(&metadata)?,
    )
    .await
}

async fn verify_metadata(path: &Path, bytes: &[u8]) -> Result<DownloadMetadata, AppError> {
    let data = tokio::fs::read(path.with_extension("meta")).await?;
    let metadata: DownloadMetadata = serde_json::from_slice(&data)
        .map_err(|_| AppError::Validation("Die Update-Metadaten sind ungültig.".into()))?;
    if !metadata.url.starts_with("https://") || metadata.version.trim().is_empty() {
        return Err(AppError::Validation(
            "Die Update-Quelle ist ungültig.".into(),
        ));
    }
    let mut digest = Sha256::new();
    digest.update(bytes);
    if format!("{:x}", digest.finalize()) != metadata.sha256 {
        return Err(AppError::Conflict(
            "Die Update-Datei wurde nach dem Download verändert.".into(),
        ));
    }
    Ok(metadata)
}

fn download_directory() -> PathBuf {
    std::env::temp_dir().join(DOWNLOAD_DIR)
}

fn validate_download_path(value: &str) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(value);
    let directory = download_directory();
    let directory_metadata = std::fs::symlink_metadata(&directory)?;
    if !directory_metadata.file_type().is_dir() {
        return Err(AppError::Validation(
            "Das Update-Verzeichnis ist kein sicherer Ordner.".into(),
        ));
    }
    let canonical_directory = std::fs::canonicalize(&directory).map_err(AppError::from)?;
    let canonical_path = std::fs::canonicalize(&path).map_err(AppError::from)?;
    if canonical_path.parent() != Some(canonical_directory.as_path())
        || !canonical_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(DOWNLOAD_PREFIX))
    {
        return Err(AppError::Validation(
            "Die Update-Datei stammt nicht aus dem geschützten Download-Verzeichnis.".into(),
        ));
    }
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_UPDATE_BYTES {
        return Err(AppError::Validation("Ungültige Update-Datei.".into()));
    }
    Ok(canonical_path)
}

async fn ensure_private_directory(path: &Path) -> Result<(), AppError> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if !metadata.file_type().is_dir() => {
            return Err(AppError::Validation(
                "Das Update-Verzeichnis ist kein sicherer Ordner.".into(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(path).await?;
        }
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    }
    Ok(())
}

async fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await?;
    file.write_all(bytes).await?;
    file.flush().await?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{verify_metadata, write_metadata, write_private_file};
    use uuid::Uuid;

    #[tokio::test]
    async fn downloaded_update_metadata_detects_file_tampering() {
        let directory =
            std::env::temp_dir().join(format!("geminui-updater-metadata-test-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let path = directory.join("update");
        write_private_file(&path, b"signed updater bytes")
            .await
            .unwrap();
        write_metadata(
            &path,
            "https://example.invalid/update.tar.gz",
            "0.11.1",
            b"signed updater bytes",
        )
        .await
        .unwrap();

        let metadata = verify_metadata(&path, b"signed updater bytes")
            .await
            .unwrap();
        assert_eq!(metadata.version, "0.11.1");
        assert!(verify_metadata(&path, b"modified bytes").await.is_err());

        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}
