//! Tauri adapters for GitLab connections, bindings and review state.

use super::api::ReqwestGitLabTransport;
use super::binding::{BindingRoot, RepositoryBindingResolver};
use super::contracts::*;
use super::merge_request::parse_merge_request_url;
use super::review_context::{ReviewContextScope, ReviewContextSnapshotStore};
use super::service::{spawn_review_poller, GitLabService};
use crate::error::AppError;
use crate::git::{now_iso, GitService};
use crate::hub::{Subscription, SubscriptionHub};
use crate::projects::ProjectService;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, State};
use uuid::Uuid;

#[derive(Debug, serde::Serialize)]
pub struct VoidResult {
    pub ok: bool,
}

pub struct GitLabCommandState {
    pub service: Arc<GitLabService<ReqwestGitLabTransport>>,
    pub projects: Arc<ProjectService>,
    pub git: Arc<GitService>,
    pub hub: SubscriptionHub<String, Value>,
    /// One-shot review-context snapshots shared with the session resolver.
    pub review_context_snapshots: Arc<ReviewContextSnapshotStore>,
    subscriptions: Mutex<HashMap<String, ActiveSubscription>>,
    pub poll_interval: Duration,
}

struct ActiveSubscription {
    _hub_subscription: Subscription<String, Value>,
    _poller: super::service::GitLabReviewPollerHandle,
}

impl GitLabCommandState {
    pub fn new(
        service: Arc<GitLabService<ReqwestGitLabTransport>>,
        projects: Arc<ProjectService>,
        git: Arc<GitService>,
        hub: SubscriptionHub<String, Value>,
    ) -> Self {
        Self {
            service,
            projects,
            git,
            hub,
            review_context_snapshots: Arc::new(ReviewContextSnapshotStore::new(
                Duration::from_secs(600),
            )),
            subscriptions: Mutex::new(HashMap::new()),
            poll_interval: Duration::from_secs(15),
        }
    }

    pub fn with_review_context_snapshots(
        mut self,
        snapshots: Arc<ReviewContextSnapshotStore>,
    ) -> Self {
        self.review_context_snapshots = snapshots;
        self
    }

    fn git_binary(&self) -> Result<PathBuf, AppError> {
        Ok(self
            .git
            .binary_path()?
            .unwrap_or_else(|| PathBuf::from("git")))
    }
}

#[tauri::command]
pub async fn gitlab_list_repository_candidates(
    state: State<'_, GitLabCommandState>,
    input: ListGitLabRepositoryCandidatesInput,
) -> Result<Vec<GitLabRepositoryCandidate>, AppError> {
    let project = state.projects.get(&input.project_id)?;
    let roots = project
        .roots
        .iter()
        .map(|root| BindingRoot {
            id: root.id.clone(),
            label: root.label.clone(),
            real_path: PathBuf::from(&root.real_path),
        })
        .collect::<Vec<_>>();
    let git_binary = state.git_binary()?;
    RepositoryBindingResolver::new(state.service.repository.clone())
        .discover_candidates(&git_binary, &input.project_id, &roots)
        .await
}

#[tauri::command]
pub fn gitlab_list_connections(
    state: State<'_, GitLabCommandState>,
) -> Result<Vec<GitLabConnectionSummary>, AppError> {
    state.service.repository.list_connections()
}

#[tauri::command]
pub async fn gitlab_test_connection(
    state: State<'_, GitLabCommandState>,
    input: TestGitLabConnectionInput,
) -> Result<GitLabConnectionSummary, AppError> {
    state.service.test_connection(input).await
}

#[tauri::command]
pub async fn gitlab_save_connection(
    state: State<'_, GitLabCommandState>,
    input: SaveGitLabConnectionInput,
) -> Result<GitLabConnectionSummary, AppError> {
    state.service.save_connection(input).await
}

#[tauri::command]
pub async fn gitlab_replace_token(
    state: State<'_, GitLabCommandState>,
    input: ReplaceGitLabTokenInput,
) -> Result<GitLabConnectionSummary, AppError> {
    state.service.replace_token(input).await
}

#[tauri::command]
pub fn gitlab_remove_connection(
    state: State<'_, GitLabCommandState>,
    input: RemoveGitLabConnectionInput,
) -> Result<VoidResult, AppError> {
    state.service.repository.remove_connection(
        &input.connection_id,
        input.force_disable_bindings,
        &now_iso(),
    )?;
    Ok(VoidResult { ok: true })
}

#[tauri::command]
pub fn gitlab_enable_binding(
    state: State<'_, GitLabCommandState>,
    input: EnableGitLabBindingInput,
) -> Result<GitLabRepositoryBinding, AppError> {
    let project = state.projects.get(&input.project_id)?;
    if project.root_revision != input.expected_root_revision {
        return Err(AppError::Conflict(
            "Die Projektordner wurden geändert. Lade die GitLab-Bindings neu.".into(),
        ));
    }
    if !project.roots.iter().any(|root| root.id == input.root_id) {
        return Err(AppError::Validation(
            "Der GitLab-Root gehört nicht zum Projekt.".into(),
        ));
    }
    if input.source_project_id <= 0 || !valid_sha256(&input.repository_key) {
        return Err(AppError::Validation(
            "Repository-Key oder GitLab-Projekt-ID ist ungültig.".into(),
        ));
    }
    if state
        .service
        .connection_summary(&input.connection_id)
        .is_err()
    {
        return Err(AppError::NotFound(
            "GitLab-Verbindung nicht gefunden.".into(),
        ));
    }
    let now = now_iso();
    let binding = state
        .service
        .repository
        .list_bindings(&input.project_id)?
        .into_iter()
        .find(|value| value.repository_key == input.repository_key)
        .map(|mut value| {
            value.root_id = input.root_id.clone();
            value.connection_id = input.connection_id.clone();
            value.remote_name = input.remote_name.clone();
            value.remote_url = input.remote_url.clone();
            value.source_project_id = input.source_project_id;
            value.source_project_path = input.source_project_path.clone();
            value.enabled = true;
            value.updated_at = now.clone();
            value
        })
        .unwrap_or_else(|| GitLabRepositoryBinding {
            id: Uuid::new_v4().to_string(),
            project_id: input.project_id.clone(),
            root_id: input.root_id.clone(),
            connection_id: input.connection_id.clone(),
            repository_key: input.repository_key.clone(),
            remote_name: input.remote_name.clone(),
            remote_url: input.remote_url.clone(),
            source_project_id: input.source_project_id,
            source_project_path: input.source_project_path.clone(),
            enabled: true,
            selected_target_project_id: None,
            selected_target_project_path: None,
            selected_merge_request_iid: None,
            last_synced_at: None,
            created_at: now.clone(),
            updated_at: now,
        });
    state.service.repository.save_binding(&binding)
}

#[tauri::command]
pub fn gitlab_disable_binding(
    state: State<'_, GitLabCommandState>,
    input: DisableGitLabBindingInput,
) -> Result<VoidResult, AppError> {
    let project = state.projects.get(&input.project_id)?;
    if project.root_revision != input.expected_root_revision {
        return Err(AppError::Conflict(
            "Die Projektordner wurden geändert. Lade die GitLab-Bindings neu.".into(),
        ));
    }
    let binding = state.service.binding(&input.binding_id)?;
    if binding.project_id != input.project_id {
        return Err(AppError::NotFound("GitLab-Binding nicht gefunden.".into()));
    }
    state
        .service
        .repository
        .disable_binding(&input.binding_id, &now_iso())?;
    Ok(VoidResult { ok: true })
}

#[tauri::command]
pub async fn gitlab_list_merge_requests(
    state: State<'_, GitLabCommandState>,
    input: ListGitLabMergeRequestsInput,
) -> Result<Vec<GitLabMergeRequestSummary>, AppError> {
    let project = state.projects.get(&input.project_id)?;
    if project.root_revision != input.expected_root_revision {
        return Err(AppError::Conflict(
            "Die Projektordner wurden geändert. Lade die GitLab-Bindings neu.".into(),
        ));
    }
    let binding = state.service.binding(&input.binding_id)?;
    if binding.project_id != input.project_id {
        return Err(AppError::NotFound("GitLab-Binding nicht gefunden.".into()));
    }
    state.service.list_merge_requests(&binding, None).await
}

#[tauri::command]
pub fn gitlab_select_merge_request(
    state: State<'_, GitLabCommandState>,
    input: SelectGitLabMergeRequestInput,
) -> Result<GitLabRepositoryBinding, AppError> {
    let project = state.projects.get(&input.project_id)?;
    if project.root_revision != input.expected_root_revision
        || input.target_project_id <= 0
        || input.merge_request_iid <= 0
    {
        return Err(AppError::Conflict(
            "Der GitLab-Auswahlstand ist nicht mehr aktuell.".into(),
        ));
    }
    let binding = state.service.binding(&input.binding_id)?;
    if binding.project_id != input.project_id {
        return Err(AppError::NotFound("GitLab-Binding nicht gefunden.".into()));
    }
    state.service.repository.update_selection(
        &binding.id,
        input.target_project_id,
        &input.target_project_path,
        input.merge_request_iid,
        &now_iso(),
    )
}

#[tauri::command]
pub fn gitlab_connect_merge_request_url(
    state: State<'_, GitLabCommandState>,
    input: ConnectGitLabMergeRequestUrlInput,
) -> Result<GitLabRepositoryBinding, AppError> {
    let project = state.projects.get(&input.project_id)?;
    if project.root_revision != input.expected_root_revision {
        return Err(AppError::Conflict(
            "Die Projektordner wurden geändert. Lade die GitLab-Bindings neu.".into(),
        ));
    }
    let binding = state.service.binding(&input.binding_id)?;
    let connection = state.service.connection_summary(&binding.connection_id)?;
    let parsed = parse_merge_request_url(&connection.instance_url, &input.merge_request_url)
        .ok_or_else(|| {
            AppError::Validation(
                "Die Merge-Request-URL gehört nicht zur konfigurierten GitLab-Instanz.".into(),
            )
        })?;
    state.service.repository.update_selection(
        &binding.id,
        binding.source_project_id,
        &parsed.project_path,
        parsed.merge_request_iid,
        &now_iso(),
    )
}

#[tauri::command]
pub async fn gitlab_get_review_state(
    state: State<'_, GitLabCommandState>,
    input: GetGitLabReviewStateInput,
) -> Result<GitLabReviewState, AppError> {
    review_state_for(
        &state,
        &input.project_id,
        input.expected_root_revision,
        &input.binding_id,
    )
    .await
}

#[tauri::command]
pub async fn gitlab_subscribe_review_state(
    state: State<'_, GitLabCommandState>,
    input: SubscribeGitLabReviewStateInput,
    on_change: Channel<Value>,
) -> Result<GitLabReviewStateSubscriptionResult, AppError> {
    let initial = review_state_for(
        &state,
        &input.project_id,
        input.expected_root_revision,
        &input.binding_id,
    )
    .await?;
    let subscription_id = Uuid::new_v4().to_string();
    let hub_subscription = state
        .hub
        .subscribe_channel(input.project_id.clone(), on_change);
    let poller = spawn_review_poller(
        Arc::clone(&state.service),
        input.project_id,
        initial.binding.clone(),
        initial.repository_display_name.clone(),
        state.hub.clone(),
        state.poll_interval,
    );
    state
        .subscriptions
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .insert(
            subscription_id.clone(),
            ActiveSubscription {
                _hub_subscription: hub_subscription,
                _poller: poller,
            },
        );
    Ok(GitLabReviewStateSubscriptionResult {
        subscription_id,
        initial,
    })
}

#[tauri::command]
pub fn gitlab_unsubscribe_review_state(
    state: State<'_, GitLabCommandState>,
    input: UnsubscribeGitLabReviewStateInput,
) -> Result<VoidResult, AppError> {
    state
        .subscriptions
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .remove(&input.subscription_id);
    Ok(VoidResult { ok: true })
}

#[tauri::command]
pub async fn gitlab_prepare_review_context(
    state: State<'_, GitLabCommandState>,
    input: PrepareGitLabReviewContextInput,
) -> Result<PreparedExternalContext, AppError> {
    let state_value = review_state_for(
        &state,
        &input.project_id,
        input.expected_root_revision,
        &input.binding_id,
    )
    .await?;
    if state_value.merge_request.as_ref().map_or(true, |value| {
        value.target_project_id != input.target_project_id || value.iid != input.merge_request_iid
    }) {
        return Err(AppError::Conflict(
            "Der Merge Request ist nicht mehr ausgewählt.".into(),
        ));
    }
    let merge_request = state_value
        .merge_request
        .as_ref()
        .ok_or_else(|| AppError::Conflict("Der Merge Request ist nicht mehr ausgewählt.".into()))?;
    let discussion = state_value
        .discussions
        .iter()
        .find(|value| value.id == input.discussion_id)
        .ok_or_else(|| AppError::NotFound("GitLab-Diskussion nicht gefunden.".into()))?;
    let project = state.projects.get(&input.project_id)?;
    let root = project
        .roots
        .iter()
        .find(|value| value.id == state_value.binding.root_id)
        .ok_or_else(|| AppError::NotFound("GitLab-Root nicht gefunden.".into()))?;
    let git_binary = state.git_binary()?;
    let (prepared, parts) = state
        .service
        .prepare_review_context(
            &state_value.binding,
            merge_request,
            discussion,
            &state_value.repository_display_name,
            &input.context_mode,
            input.selected_note_id,
            &git_binary,
            std::path::Path::new(&root.real_path),
        )
        .await?;
    let mut prepared = prepared;
    let prepared_id = state.review_context_snapshots.save_scoped(
        prepared.clone(),
        parts,
        Some(ReviewContextScope {
            project_id: input.project_id,
            root_id: root.id.clone(),
            root_revision: input.expected_root_revision,
        }),
    )?;
    prepared.reference.id = prepared_id;
    Ok(prepared)
}

#[tauri::command]
pub async fn gitlab_resolve_discussion(
    state: State<'_, GitLabCommandState>,
    input: ResolveGitLabDiscussionInput,
) -> Result<GitLabDiscussion, AppError> {
    let binding = checked_binding(
        &state,
        &input.project_id,
        input.expected_root_revision,
        &input.binding_id,
    )?;
    let path = selected_project_path(&binding, input.target_project_id)?;
    let note = state
        .service
        .resolve_discussion(
            &binding,
            &path,
            input.merge_request_iid,
            &input.discussion_id,
            input.resolved,
        )
        .await?;
    Ok(note)
}

#[tauri::command]
pub async fn gitlab_reply_to_discussion(
    state: State<'_, GitLabCommandState>,
    input: ReplyToGitLabDiscussionInput,
) -> Result<GitLabDiscussion, AppError> {
    if input.body.trim().is_empty() || input.body.chars().count() > 100_000 {
        return Err(AppError::Validation(
            "Die GitLab-Antwort ist leer oder zu lang.".into(),
        ));
    }
    let binding = checked_binding(
        &state,
        &input.project_id,
        input.expected_root_revision,
        &input.binding_id,
    )?;
    let path = selected_project_path(&binding, input.target_project_id)?;
    let note = state
        .service
        .reply_discussion(
            &binding,
            &path,
            input.merge_request_iid,
            &input.discussion_id,
            &input.body,
        )
        .await?;
    Ok(discussion_from_note(input.discussion_id, note))
}

async fn review_state_for(
    state: &GitLabCommandState,
    project_id: &str,
    expected_root_revision: u64,
    binding_id: &str,
) -> Result<GitLabReviewState, AppError> {
    let binding = checked_binding(state, project_id, expected_root_revision, binding_id)?;
    state
        .service
        .review_state(project_id, &binding, &binding.source_project_path)
        .await
}

fn checked_binding(
    state: &GitLabCommandState,
    project_id: &str,
    expected_root_revision: u64,
    binding_id: &str,
) -> Result<GitLabRepositoryBinding, AppError> {
    let project = state.projects.get(project_id)?;
    if project.root_revision != expected_root_revision {
        return Err(AppError::Conflict(
            "Die Projektordner wurden geändert. Lade die GitLab-Bindings neu.".into(),
        ));
    }
    let binding = state.service.binding(binding_id)?;
    if binding.project_id != project_id {
        return Err(AppError::NotFound("GitLab-Binding nicht gefunden.".into()));
    }
    Ok(binding)
}

fn selected_project_path(
    binding: &GitLabRepositoryBinding,
    target_project_id: i64,
) -> Result<String, AppError> {
    if target_project_id <= 0 || binding.selected_target_project_id != Some(target_project_id) {
        return Err(AppError::Conflict(
            "Der Ziel-Projektstand des Merge Requests ist veraltet.".into(),
        ));
    }
    binding.selected_target_project_path.clone().ok_or_else(|| {
        AppError::Conflict("Für diesen Binding ist kein Zielprojekt ausgewählt.".into())
    })
}

fn discussion_from_note(id: String, note: GitLabDiscussionNote) -> GitLabDiscussion {
    let resolvable = note.resolvable;
    GitLabDiscussion {
        id,
        individual_note: false,
        resolved: !resolvable || note.resolved,
        resolvable,
        notes: vec![note],
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
