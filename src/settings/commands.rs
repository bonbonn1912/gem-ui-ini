//! Binary selection commands.  Probing happens before persistence so a bad
//! path can never replace a working configured binary.

use super::repository::SettingsRepository;
use crate::error::AppError;
use crate::git::{now_iso, GitService};
use crate::processes::binary_probe::{
    probe_gemini_binary, Environment, GeminiProbeResult, GeminiProbeSuccess,
};
use crate::processes::git_binary_probe::{probe_git_binary, GitProbeResult, GitProbeSuccess};
use serde::Serialize;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCapabilities {
    pub app_version: String,
    pub platform: &'static str,
    pub gemini: GeminiCapabilities,
    pub git: GitCapabilities,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiCapabilities {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub acp: bool,
    pub session_load: bool,
    pub images: bool,
    pub modes: bool,
    pub models: bool,
    pub max_additional_roots: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCapabilities {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
}

/// Runtime hook for changing Gemini. The application root must stop/close
/// active ACP processes (or reject while a turn is running), then update its
/// process-config factory to `path`. Keeping this callback async makes the
/// safety boundary explicit without coupling settings to session internals.
pub type GeminiBinaryChangeHook = Arc<
    dyn Fn(PathBuf) -> Pin<Box<dyn Future<Output = Result<(), AppError>> + Send>> + Send + Sync,
>;

pub struct SettingsCommandState {
    pub repository: SettingsRepository,
    gemini_path: RwLock<Option<String>>,
    git_path: RwLock<Option<String>>,
    git_service: Option<Arc<GitService>>,
    gemini_binary_change: Option<GeminiBinaryChangeHook>,
}

impl SettingsCommandState {
    pub fn new(repository: SettingsRepository) -> Result<Self, AppError> {
        let gemini_path = repository.gemini()?.and_then(|value| value.binary_path);
        let git_path = repository.git()?.and_then(|value| value.binary_path);
        Ok(Self {
            repository,
            gemini_path: RwLock::new(gemini_path),
            git_path: RwLock::new(git_path),
            git_service: None,
            gemini_binary_change: None,
        })
    }

    pub fn with_git_service(mut self, service: Arc<GitService>) -> Self {
        self.git_service = Some(service);
        self
    }

    pub fn with_gemini_binary_change_hook(mut self, hook: GeminiBinaryChangeHook) -> Self {
        self.gemini_binary_change = Some(hook);
        self
    }
}

#[tauri::command]
pub async fn settings_choose_gemini_binary(
    app: AppHandle,
    state: State<'_, SettingsCommandState>,
) -> Result<AppCapabilities, AppError> {
    let path = pick_file(&app).await?;
    let Some(path) = path else {
        return current_capabilities(&state).await;
    };
    let environment: Environment = std::env::vars().collect();
    let probe = probe_gemini_binary(Some(&path), &environment, None).await;
    if !matches!(probe, GeminiProbeResult::Ok(_)) {
        return Err(AppError::Validation(
            "Die ausgewählte Gemini-Datei konnte nicht geprüft werden.".into(),
        ));
    }
    let change = state.gemini_binary_change.clone().ok_or_else(|| {
        AppError::Internal("Gemini-Laufzeit-Hook ist nicht im App-State verdrahtet.".into())
    })?;
    let previous = state
        .gemini_path
        .read()
        .map_err(|_| AppError::StatePoisoned)?
        .clone();
    state.repository.set_gemini(Some(&path), &now_iso())?;
    if let Err(error) = change(PathBuf::from(&path)).await {
        let rollback = state.repository.set_gemini(previous.as_deref(), &now_iso());
        if let Err(rollback_error) = rollback {
            return Err(AppError::Internal(format!(
                "Gemini-Wechsel fehlgeschlagen ({error}); Rollback fehlgeschlagen ({rollback_error})"
            )));
        }
        return Err(error);
    }
    *state
        .gemini_path
        .write()
        .map_err(|_| AppError::StatePoisoned)? = Some(path);
    current_capabilities(&state).await
}

#[tauri::command]
pub async fn settings_choose_git_binary(
    app: AppHandle,
    state: State<'_, SettingsCommandState>,
) -> Result<AppCapabilities, AppError> {
    let path = pick_file(&app).await?;
    let Some(path) = path else {
        return current_capabilities(&state).await;
    };
    let environment: Environment = std::env::vars().collect();
    let probe = probe_git_binary(Some(&path), &environment, None).await;
    if !matches!(probe, GitProbeResult::Ok(_)) {
        return Err(AppError::Validation(
            "Die ausgewählte Git-Datei konnte nicht geprüft werden.".into(),
        ));
    }
    let service = state.git_service.clone().ok_or_else(|| {
        AppError::Internal("GitService ist nicht im App-State verdrahtet.".into())
    })?;
    let previous = state
        .git_path
        .read()
        .map_err(|_| AppError::StatePoisoned)?
        .clone();
    state.repository.set_git(Some(&path), &now_iso())?;
    if let Err(error) = service.set_binary_path(Some(PathBuf::from(&path))) {
        let rollback = state.repository.set_git(previous.as_deref(), &now_iso());
        if let Err(rollback_error) = rollback {
            return Err(AppError::Internal(format!(
                "Git-Wechsel fehlgeschlagen ({error}); Rollback fehlgeschlagen ({rollback_error})"
            )));
        }
        return Err(error);
    }
    *state
        .git_path
        .write()
        .map_err(|_| AppError::StatePoisoned)? = Some(path);
    current_capabilities(&state).await
}

pub async fn current_capabilities(
    state: &SettingsCommandState,
) -> Result<AppCapabilities, AppError> {
    let environment: Environment = std::env::vars().collect();
    let gemini_path = state
        .gemini_path
        .read()
        .map_err(|_| AppError::StatePoisoned)?
        .clone();
    let git_path = state
        .git_path
        .read()
        .map_err(|_| AppError::StatePoisoned)?
        .clone();
    let (gemini, git) = tokio::join!(
        probe_gemini_binary(gemini_path.as_deref(), &environment, None),
        probe_git_binary(git_path.as_deref(), &environment, None),
    );
    Ok(capabilities(gemini, git))
}

fn capabilities(gemini: GeminiProbeResult, git: GitProbeResult) -> AppCapabilities {
    AppCapabilities {
        app_version: env!("CARGO_PKG_VERSION").into(),
        platform: if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "windows") {
            "win32"
        } else {
            "linux"
        },
        gemini: gemini_capabilities(gemini),
        git: git_capabilities(git),
    }
}

fn gemini_capabilities(value: GeminiProbeResult) -> GeminiCapabilities {
    let GeminiProbeResult::Ok(GeminiProbeSuccess {
        binary_path,
        version,
        features,
        ..
    }) = value
    else {
        return GeminiCapabilities {
            available: false,
            binary_path: None,
            version: None,
            acp: false,
            session_load: false,
            images: false,
            modes: false,
            models: false,
            max_additional_roots: 0,
        };
    };
    GeminiCapabilities {
        available: true,
        binary_path: Some(binary_path.to_string_lossy().into_owned()),
        version: Some(version),
        acp: features.acp,
        session_load: features.resume,
        images: features.acp,
        modes: features.approval_mode,
        models: features.acp,
        max_additional_roots: if features.include_directories { 5 } else { 0 },
    }
}

fn git_capabilities(value: GitProbeResult) -> GitCapabilities {
    let GitProbeResult::Ok(GitProbeSuccess {
        binary_path,
        version,
        ..
    }) = value
    else {
        return GitCapabilities {
            available: false,
            binary_path: None,
            version: None,
        };
    };
    GitCapabilities {
        available: true,
        binary_path: Some(binary_path.to_string_lossy().into_owned()),
        version: Some(version),
    }
}

async fn pick_file(app: &AppHandle) -> Result<Option<String>, AppError> {
    let (sender, receiver) = oneshot::channel();
    app.dialog().file().pick_file(move |path| {
        let _ = sender.send(path);
    });
    receiver
        .await
        .map_err(|_| AppError::Internal("Dateiauswahl wurde unerwartet beendet.".into()))?
        .map(file_path)
        .transpose()
}

fn file_path(path: FilePath) -> Result<String, AppError> {
    path.into_path()
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|_| AppError::Validation("Die ausgewählte Datei liegt nicht lokal vor.".into()))
}
