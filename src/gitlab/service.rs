use super::api::{normalize_api_base_url, GitLabApiClient, GitLabTransport};
use super::contracts::*;
use super::discussion::map_gitlab_discussions;
use super::merge_request::{map_raw_merge_request, sort_merge_requests};
use super::repository::GitLabRepository;
use super::review_context::{ReviewContextBuilder, ReviewPromptPart};
use super::vault::GitLabTokenVault;
use crate::error::AppError;
use crate::git::now_iso;
use crate::hub::SubscriptionHub;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::task::JoinHandle;
use uuid::Uuid;

pub struct GitLabService<T> {
    pub repository: GitLabRepository,
    pub vault: GitLabTokenVault,
    pub transport_factory: TransportFactory<T>,
}
pub type TransportFactory<T> =
    Arc<dyn Fn(&GitLabConnectionSummary, String) -> Result<T, AppError> + Send + Sync>;
impl<T: GitLabTransport> GitLabService<T> {
    pub async fn test_connection(
        &self,
        input: TestGitLabConnectionInput,
    ) -> Result<GitLabConnectionSummary, AppError> {
        let token = validate_token(&input.token)?;
        let (instance_url, api_base_url) = normalize_api_base_url(&input.instance_url)?;
        let placeholder = connection_placeholder(
            Uuid::new_v4().to_string(),
            instance_url,
            api_base_url,
            input.allow_self_signed_tls,
        );
        let client = self.client_for_token(&placeholder, token)?;
        let user = client.current_user().await?;
        Ok(connection_from_user(placeholder, &user))
    }

    pub async fn save_connection(
        &self,
        input: SaveGitLabConnectionInput,
    ) -> Result<GitLabConnectionSummary, AppError> {
        let token = validate_token(&input.token)?;
        let (instance_url, api_base_url) = normalize_api_base_url(&input.instance_url)?;
        let placeholder = connection_placeholder(
            Uuid::new_v4().to_string(),
            instance_url,
            api_base_url,
            input.allow_self_signed_tls,
        );
        let client = self.client_for_token(&placeholder, token.clone())?;
        let user = client.current_user().await?;
        let summary = connection_from_user(placeholder, &user);
        let cipher = self
            .vault
            .encrypt_token(&token)
            .map_err(AppError::Upstream)?;
        self.repository.save_connection(&summary, &cipher)
    }

    pub async fn replace_token(
        &self,
        input: ReplaceGitLabTokenInput,
    ) -> Result<GitLabConnectionSummary, AppError> {
        let token = validate_token(&input.token)?;
        let existing = self.connection(&input.connection_id)?;
        let mut probe = existing.clone();
        if let Some(allow) = input.allow_self_signed_tls {
            probe.allow_self_signed_tls = allow;
        }
        let client = self.client_for_token(&probe, token.clone())?;
        let user = client.current_user().await?;
        let mut summary = connection_from_user(probe, &user);
        summary.id = existing.id;
        summary.created_at = existing.created_at;
        let cipher = self
            .vault
            .encrypt_token(&token)
            .map_err(AppError::Upstream)?;
        self.repository.save_connection(&summary, &cipher)
    }

    pub fn connection_summary(&self, id: &str) -> Result<GitLabConnectionSummary, AppError> {
        self.connection(id)
    }

    pub fn client_for_token(
        &self,
        connection: &GitLabConnectionSummary,
        token: String,
    ) -> Result<GitLabApiClient<T>, AppError> {
        let transport = (self.transport_factory)(connection, token.clone())?;
        GitLabApiClient::new(&connection.instance_url, token, transport)
    }

    pub fn binding(&self, binding_id: &str) -> Result<GitLabRepositoryBinding, AppError> {
        self.repository
            .find_binding(binding_id)?
            .ok_or_else(|| AppError::NotFound("GitLab-Binding nicht gefunden.".into()))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn prepare_review_context(
        &self,
        binding: &GitLabRepositoryBinding,
        merge_request: &GitLabMergeRequestSummary,
        discussion: &GitLabDiscussion,
        repository_label: &str,
        context_mode: &str,
        selected_note_id: Option<i64>,
        binary: &std::path::Path,
        worktree: &std::path::Path,
    ) -> Result<(PreparedExternalContext, Vec<ReviewPromptPart>), AppError> {
        let connection = self.connection(&binding.connection_id)?;
        let client = self.client(&connection)?;
        ReviewContextBuilder::build_with_gitlab_fallback(
            binary,
            worktree,
            merge_request,
            discussion,
            repository_label,
            context_mode,
            selected_note_id,
            &client,
        )
        .await
    }

    pub async fn list_merge_requests(
        &self,
        binding: &GitLabRepositoryBinding,
        current_branch: Option<&str>,
    ) -> Result<Vec<GitLabMergeRequestSummary>, AppError> {
        let connection = self.connection(&binding.connection_id)?;
        let client = self.client(&connection)?;
        let raw = client
            .list_merge_requests(&binding.source_project_path, current_branch)
            .await?;
        let mut values = raw
            .iter()
            .filter_map(|item| map_raw_merge_request(item, &binding.source_project_path))
            .collect::<Vec<_>>();
        sort_merge_requests(&mut values, current_branch);
        Ok(values)
    }
    pub async fn review_state(
        &self,
        project_id: &str,
        binding: &GitLabRepositoryBinding,
        repository_display_name: &str,
    ) -> Result<GitLabReviewState, AppError> {
        let connection = self.connection(&binding.connection_id)?;
        let client = self.client(&connection)?;
        let merge_request = match (
            binding.selected_target_project_path.as_deref(),
            binding.selected_merge_request_iid,
        ) {
            (Some(path), Some(iid)) => Some(
                map_raw_merge_request(&client.merge_request(path, iid).await?, path).ok_or_else(
                    || {
                        AppError::Upstream(
                            "GitLab-Merge-Request konnte nicht abgebildet werden.".into(),
                        )
                    },
                )?,
            ),
            _ => None,
        };
        let discussions = if let Some(mr) = &merge_request {
            map_gitlab_discussions(
                &client.discussions(&mr.target_project_path, mr.iid).await?,
                Some(&mr.head_sha),
            )
        } else {
            Vec::new()
        };
        let unresolved = discussions
            .iter()
            .filter(|value| value.resolvable && !value.resolved)
            .count();
        Ok(GitLabReviewState {
            project_id: project_id.into(),
            binding_id: binding.id.clone(),
            repository_display_name: repository_display_name.into(),
            connection,
            binding: binding.clone(),
            merge_request,
            total_discussions_count: discussions.len(),
            unresolved_discussions_count: unresolved,
            discussions,
            last_refreshed_at: now_iso(),
        })
    }

    pub async fn refresh_and_publish(
        &self,
        project_id: &str,
        binding: &GitLabRepositoryBinding,
        repository_display_name: &str,
        hub: &SubscriptionHub<String, Value>,
    ) -> Result<GitLabReviewState, AppError> {
        let state = self
            .review_state(project_id, binding, repository_display_name)
            .await?;
        hub.notify(&state.project_id, serde_json::to_value(&state)?);
        Ok(state)
    }
    pub async fn resolve_discussion(
        &self,
        binding: &GitLabRepositoryBinding,
        project_path: &str,
        iid: i64,
        discussion_id: &str,
        resolved: bool,
    ) -> Result<GitLabDiscussion, AppError> {
        let connection = self.connection(&binding.connection_id)?;
        let client = self.client(&connection)?;
        let raw = client
            .resolve_discussion(project_path, iid, discussion_id, resolved)
            .await?;
        map_gitlab_discussions(&[raw], None)
            .into_iter()
            .next()
            .ok_or_else(|| {
                AppError::Upstream("GitLab-Diskussion konnte nicht abgebildet werden.".into())
            })
    }
    pub async fn reply_discussion(
        &self,
        binding: &GitLabRepositoryBinding,
        project_path: &str,
        iid: i64,
        discussion_id: &str,
        body: &str,
    ) -> Result<GitLabDiscussionNote, AppError> {
        let connection = self.connection(&binding.connection_id)?;
        let client = self.client(&connection)?;
        let raw = client
            .reply_discussion(project_path, iid, discussion_id, body)
            .await?;
        let mapped = map_gitlab_discussions(
            &[serde_json::json!({"id": discussion_id, "notes": [raw]})],
            None,
        );
        mapped
            .into_iter()
            .next()
            .and_then(|value| value.notes.into_iter().next())
            .ok_or_else(|| {
                AppError::Upstream("GitLab-Antwort konnte nicht abgebildet werden.".into())
            })
    }
    fn connection(&self, id: &str) -> Result<GitLabConnectionSummary, AppError> {
        self.repository
            .list_connections()?
            .into_iter()
            .find(|value| value.id == id)
            .ok_or_else(|| AppError::NotFound("GitLab connection not found.".into()))
    }
    fn client(&self, connection: &GitLabConnectionSummary) -> Result<GitLabApiClient<T>, AppError> {
        let token = self
            .vault
            .decrypt_token(&self.repository.token_cipher(&connection.id)?)
            .map_err(AppError::Upstream)?;
        self.client_for_token(connection, token)
    }
}

fn validate_token(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 1_000 || value.chars().any(char::is_control) {
        return Err(AppError::Validation("GitLab-Token ist ungültig.".into()));
    }
    Ok(value.to_owned())
}

fn connection_placeholder(
    id: String,
    instance_url: String,
    api_base_url: String,
    allow_self_signed_tls: bool,
) -> GitLabConnectionSummary {
    let now = now_iso();
    GitLabConnectionSummary {
        id,
        instance_url,
        api_base_url,
        user: GitLabUserSummary {
            id: 1,
            username: "unknown".into(),
            name: "GitLab User".into(),
            avatar_url: None,
        },
        token_configured: true,
        access: GitLabAccessMode::ReadOnly,
        scopes: Vec::new(),
        allow_self_signed_tls,
        expires_at: None,
        last_validated_at: now.clone(),
        created_at: now.clone(),
        updated_at: now,
    }
}

fn connection_from_user(
    mut placeholder: GitLabConnectionSummary,
    user: &serde_json::Value,
) -> GitLabConnectionSummary {
    let id = user
        .get("id")
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(1);
    let username = user
        .get("username")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("unknown")
        .chars()
        .take(255)
        .collect();
    let name = user
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("GitLab User")
        .chars()
        .take(255)
        .collect();
    let avatar_url = user
        .get("avatar_url")
        .and_then(serde_json::Value::as_str)
        .filter(|value| value.starts_with("https://"))
        .map(str::to_owned);
    let now = now_iso();
    placeholder.user = GitLabUserSummary {
        id,
        username,
        name,
        avatar_url,
    };
    placeholder.last_validated_at = now.clone();
    placeholder.updated_at = now;
    placeholder
}

pub struct GitLabReviewPollerHandle {
    stop: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl GitLabReviewPollerHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

impl Drop for GitLabReviewPollerHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.task.abort();
    }
}

pub fn spawn_review_poller<T: GitLabTransport + 'static>(
    service: Arc<GitLabService<T>>,
    project_id: String,
    binding: GitLabRepositoryBinding,
    repository_display_name: String,
    hub: SubscriptionHub<String, Value>,
    interval: Duration,
) -> GitLabReviewPollerHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let poll_stop = Arc::clone(&stop);
    let task = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval.max(Duration::from_millis(500)));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if poll_stop.load(Ordering::Acquire) {
                break;
            }
            let _ = service
                .refresh_and_publish(&project_id, &binding, &repository_display_name, &hub)
                .await;
        }
    });
    GitLabReviewPollerHandle { stop, task }
}
