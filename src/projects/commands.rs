use super::contracts::{
    ArchiveProjectInput, CreateProjectInput, DeleteProjectInput, GetProjectApprovalPolicyInput,
    GetProjectInput, ListProjectsInput, PickProjectFoldersInput, ProjectAccess,
    ProjectApprovalPolicy, ProjectRootCandidate, ProjectRootReauthorizationResult,
    ProjectWithRoots, ReauthorizeProjectRootInput, ReauthorizeProjectRootSelectionInput,
    RenameProjectInput, SetProjectApprovalPolicyInput, SetProjectRootsInput,
};
use crate::constants::MAX_ROOTS;
use crate::error::AppError;
use crate::sessions::SessionCommandService;
use crate::state::AppState;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

#[derive(Debug, Serialize)]
pub struct VoidResult {
    ok: bool,
}

/// Thin Tauri command wrappers.  Validation, idempotency and persistence stay
/// in ProjectService so these commands cannot accidentally bypass the domain.
#[tauri::command]
pub async fn projects_list(
    state: State<'_, AppState>,
    input: ListProjectsInput,
) -> Result<Vec<ProjectWithRoots>, AppError> {
    state.project_service().list(input)
}

#[tauri::command]
pub async fn projects_get(
    state: State<'_, AppState>,
    input: GetProjectInput,
) -> Result<ProjectWithRoots, AppError> {
    state.project_service().get(&input.project_id)
}

#[tauri::command]
pub async fn projects_get_approval_policy(
    state: State<'_, AppState>,
    sessions: State<'_, SessionCommandService>,
    input: GetProjectApprovalPolicyInput,
) -> Result<ProjectApprovalPolicy, AppError> {
    let project = state.project_service().get(&input.project_id)?;
    let modes = sessions
        .project_approval_snapshot(&input.project_id, true)
        .await?;
    Ok(super::to_project_approval_policy(&project, modes.as_ref()))
}

#[tauri::command]
pub async fn projects_set_approval_policy(
    state: State<'_, AppState>,
    sessions: State<'_, SessionCommandService>,
    input: SetProjectApprovalPolicyInput,
) -> Result<ProjectApprovalPolicy, AppError> {
    let modes = if let Some(mode_id) = input.mode_id.as_deref() {
        Some(
            sessions
                .apply_project_mode(&input.project_id, mode_id)
                .await?,
        )
    } else {
        sessions
            .project_approval_snapshot(&input.project_id, false)
            .await?
    };
    state
        .project_service()
        .set_approval_policy(input, modes)
        .await
}

#[tauri::command]
pub async fn projects_pick_folders(
    app: AppHandle,
    input: PickProjectFoldersInput,
) -> Result<Vec<ProjectRootCandidate>, AppError> {
    let selected = if input.allow_multiple {
        let (sender, receiver) = oneshot::channel();
        app.dialog().file().pick_folders(move |paths| {
            let _ = sender.send(paths);
        });
        receiver
            .await
            .map_err(|_| AppError::Internal("folder picker closed unexpectedly".to_owned()))?
            .unwrap_or_default()
    } else {
        let (sender, receiver) = oneshot::channel();
        app.dialog().file().pick_folder(move |path| {
            let _ = sender.send(path);
        });
        receiver
            .await
            .map_err(|_| AppError::Internal("folder picker closed unexpectedly".to_owned()))?
            .into_iter()
            .collect()
    };
    if selected.len() > MAX_ROOTS {
        return Err(AppError::Validation(format!(
            "at most {MAX_ROOTS} project folders can be selected"
        )));
    }
    selected.into_iter().map(root_candidate).collect()
}

fn root_candidate(path: FilePath) -> Result<ProjectRootCandidate, AppError> {
    let path = path
        .into_path()
        .map_err(|_| AppError::Validation("selected folder is not a local path".to_owned()))?;
    let label = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty());
    Ok(ProjectRootCandidate {
        path: path.to_string_lossy().into_owned(),
        label,
    })
}

#[tauri::command]
pub async fn projects_create(
    state: State<'_, AppState>,
    input: CreateProjectInput,
) -> Result<ProjectWithRoots, AppError> {
    state.project_service().create(input).await
}

#[tauri::command]
pub async fn projects_rename(
    state: State<'_, AppState>,
    input: RenameProjectInput,
) -> Result<ProjectWithRoots, AppError> {
    state.project_service().rename(input).await
}

#[tauri::command]
pub async fn projects_set_archived(
    state: State<'_, AppState>,
    input: ArchiveProjectInput,
) -> Result<ProjectWithRoots, AppError> {
    state.project_service().set_archived(input).await
}

#[tauri::command]
pub async fn projects_set_additional_roots(
    state: State<'_, AppState>,
    input: SetProjectRootsInput,
) -> Result<ProjectWithRoots, AppError> {
    state.project_service().set_additional_roots(input).await
}

#[tauri::command]
pub async fn projects_delete(
    state: State<'_, AppState>,
    input: DeleteProjectInput,
) -> Result<VoidResult, AppError> {
    state.project_service().delete(input).await?;
    Ok(VoidResult { ok: true })
}

#[tauri::command]
pub async fn projects_get_current_access(
    state: State<'_, AppState>,
    input: GetProjectInput,
) -> Result<ProjectAccess, AppError> {
    state
        .project_service()
        .get_current_access(&input.project_id)
        .await
}

#[tauri::command]
pub async fn projects_reauthorize_root(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ReauthorizeProjectRootInput,
) -> Result<ProjectRootReauthorizationResult, AppError> {
    let (sender, receiver) = oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = sender.send(path);
    });
    let selected = receiver
        .await
        .map_err(|_| AppError::Internal("folder picker closed unexpectedly".to_owned()))?;
    let Some(selected) = selected else {
        return Ok(ProjectRootReauthorizationResult::Cancelled);
    };
    let selected_path = selected
        .into_path()
        .map_err(|_| AppError::Validation("selected folder is not a local path".to_owned()))?;
    state
        .project_service()
        .reauthorize_root_selection(ReauthorizeProjectRootSelectionInput {
            project_id: input.project_id,
            root_id: input.root_id,
            selected_path: selected_path.to_string_lossy().into_owned(),
        })
        .await
        .map(|root| ProjectRootReauthorizationResult::Authorized { root })
}
