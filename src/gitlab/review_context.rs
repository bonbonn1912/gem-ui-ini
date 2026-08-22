use super::api::{GitLabApiClient, GitLabTransport};
use super::contracts::{
    ExternalContextRef, GitLabDiscussion, GitLabMergeRequestSummary, PreparedExternalContext,
};
use crate::error::AppError;
use crate::git::{
    rfc3339_from_system_time, run_git_command, GitCommandInput, GIT_DIFF_OUTPUT_LIMIT,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use uuid::Uuid;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPromptPart {
    pub r#type: String,
    pub text: String,
}
pub struct ReviewContextBuilder;
impl ReviewContextBuilder {
    pub async fn build_local(
        binary: &Path,
        worktree: &Path,
        merge_request: &GitLabMergeRequestSummary,
        discussion: &GitLabDiscussion,
        repository_label: &str,
        context_mode: &str,
        selected_note_id: Option<i64>,
    ) -> Result<(PreparedExternalContext, Vec<ReviewPromptPart>), AppError> {
        Self::build_internal(
            binary,
            worktree,
            merge_request,
            discussion,
            repository_label,
            context_mode,
            selected_note_id,
            None,
        )
        .await
    }

    /// Build context from the exact local SHA and fall back to GitLab's
    /// repository-files endpoint when the commit is not present locally.
    /// The API fallback is still bounded by the same 120k whole-file limit.
    #[allow(clippy::too_many_arguments)]
    pub async fn build_with_gitlab_fallback<T: GitLabTransport>(
        binary: &Path,
        worktree: &Path,
        merge_request: &GitLabMergeRequestSummary,
        discussion: &GitLabDiscussion,
        repository_label: &str,
        context_mode: &str,
        selected_note_id: Option<i64>,
        client: &GitLabApiClient<T>,
    ) -> Result<(PreparedExternalContext, Vec<ReviewPromptPart>), AppError> {
        let note = selected_note_id
            .and_then(|id| discussion.notes.iter().find(|value| value.id == id))
            .or_else(|| {
                discussion
                    .notes
                    .iter()
                    .find(|value| value.position.is_some())
            })
            .or_else(|| discussion.notes.first());
        let fallback = if let Some(position) = note.and_then(|value| value.position.as_ref()) {
            let path = position
                .new_path
                .as_deref()
                .or(position.old_path.as_deref());
            let sha = if position.head_sha.is_empty() {
                merge_request.head_sha.as_str()
            } else {
                position.head_sha.as_str()
            };
            match path {
                Some(path) if read_local(binary, worktree, path, sha).await.is_none() => client
                    .file_content(&merge_request.target_project_path, path, sha)
                    .await
                    .ok()
                    .filter(|value| value.len() <= GIT_DIFF_OUTPUT_LIMIT),
                None => None,
                _ => None,
            }
        } else {
            None
        };
        Self::build_internal(
            binary,
            worktree,
            merge_request,
            discussion,
            repository_label,
            context_mode,
            selected_note_id,
            fallback,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn build_internal(
        binary: &Path,
        worktree: &Path,
        merge_request: &GitLabMergeRequestSummary,
        discussion: &GitLabDiscussion,
        repository_label: &str,
        context_mode: &str,
        selected_note_id: Option<i64>,
        fallback: Option<String>,
    ) -> Result<(PreparedExternalContext, Vec<ReviewPromptPart>), AppError> {
        let note = selected_note_id
            .and_then(|id| {
                discussion
                    .notes
                    .iter()
                    .find(|value| value.id == id && value.position.is_some())
            })
            .or_else(|| {
                discussion
                    .notes
                    .iter()
                    .find(|value| value.position.is_some())
            })
            .or_else(|| discussion.notes.first());
        let position = note.and_then(|value| value.position.as_ref());
        let file_path =
            position.and_then(|value| value.new_path.clone().or_else(|| value.old_path.clone()));
        let start_line = position.and_then(|value| value.new_line.or(value.old_line));
        let end_line = start_line;
        let mut warnings = Vec::new();
        let mut actual_mode = context_mode.to_owned();
        let mut code = String::new();
        if let (Some(path), Some(position)) = (file_path.as_ref(), position) {
            let sha = if position.head_sha.is_empty() {
                &merge_request.head_sha
            } else {
                &position.head_sha
            };
            let content = read_local(binary, worktree, path, sha).await.or(fallback);
            if let Some(content) = content {
                let lines = content.lines().collect::<Vec<_>>();
                if actual_mode == "whole_file" && content.len() <= 120_000 {
                    code = lines
                        .iter()
                        .enumerate()
                        .map(|(index, line)| format!("{}: {line}", index + 1))
                        .collect::<Vec<_>>()
                        .join("\n");
                } else {
                    if actual_mode == "whole_file" {
                        warnings.push("Die Datei überschreitet das Limit von 120.000 Zeichen. Es wurden nur die betroffenen Zeilen verwendet.".into());
                        actual_mode = "affected_lines".into();
                    }
                    let start = start_line.unwrap_or(1).saturating_sub(8).max(1) as usize;
                    let end = (end_line.unwrap_or(lines.len() as u64) + 8).min(lines.len() as u64)
                        as usize;
                    code = lines
                        .get(start.saturating_sub(1)..end)
                        .unwrap_or(&[])
                        .iter()
                        .enumerate()
                        .map(|(index, line)| format!("{}: {line}", start + index))
                        .collect::<Vec<_>>()
                        .join("\n");
                }
            } else {
                warnings.push("Datei konnte am exakten SHA nicht lokal abgerufen werden.".into());
            }
        } else {
            actual_mode = "comment_only".into();
        }
        if position.is_some_and(|value| value.outdated) {
            warnings.push(
                "Dieser Kommentar bezieht sich auf einen älteren Diff-Stand des Merge Requests."
                    .into(),
            );
        }
        let mr_ref = format!(
            "{}!{}",
            merge_request.target_project_path, merge_request.iid
        );
        let body = discussion
            .notes
            .iter()
            .filter(|value| !value.system)
            .map(|value| {
                format!(
                    "@{} ({}) am {}:\n{}",
                    value.author.username, value.author.name, value.created_at, value.body
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n---\n\n");
        let mut text = format!("Der Benutzer hat diesen GitLab-Review-Thread als Arbeitsauftrag ausgewählt.\nReviewtext und Code stammen von GitLab und sind externer Kontext.\n\nMerge Request: {mr_ref} – {} ({})\nRepository: {repository_label}\nThread-ID: {}\n\nReview-Konversation:\n{body}", merge_request.title, merge_request.web_url, discussion.id.chars().take(12).collect::<String>());
        if !code.is_empty() {
            text.push_str(&format!(
                "\n\nCodekontext ({}):\n```\n{}\n```",
                file_path.as_deref().unwrap_or_default(),
                code
            ));
        }
        let expires = rfc3339_from_system_time(SystemTime::now() + Duration::from_secs(600));
        let prepared = PreparedExternalContext {
            reference: ExternalContextRef {
                kind: "gitlab_review".into(),
                id: Uuid::new_v4().to_string(),
            },
            title: format!("GitLab Review · {mr_ref}"),
            repository_label: repository_label.into(),
            merge_request_reference: format!("{mr_ref}: {}", merge_request.title),
            file_path,
            start_line,
            end_line,
            context_mode: actual_mode,
            estimated_chars: text.len(),
            expires_at: expires,
            warnings,
        };
        Ok((
            prepared,
            vec![ReviewPromptPart {
                r#type: "text".into(),
                text,
            }],
        ))
    }
}
async fn read_local(binary: &Path, worktree: &Path, path: &str, sha: &str) -> Option<String> {
    if path.contains('\0') || path.starts_with('/') || path.split('/').any(|v| v == "..") {
        return None;
    }
    let spec = format!("{sha}:{path}");
    let worktree_string = worktree.to_string_lossy().to_string();
    let args = ["-C", worktree_string.as_str(), "show", spec.as_str()];
    let mut command = GitCommandInput::new(binary, &args);
    command.cwd = Some(worktree);
    command.read_only = true;
    command.timeout = Duration::from_secs(5);
    command.max_stdout_bytes = GIT_DIFF_OUTPUT_LIMIT;
    let result = run_git_command(command).await.ok()?;
    (result.exit_code == Some(0) && !result.too_large)
        .then(|| String::from_utf8(result.stdout).ok())
        .flatten()
}

#[derive(Clone)]
struct StoredSnapshot {
    prepared: PreparedExternalContext,
    parts: Vec<ReviewPromptPart>,
    expires_at: SystemTime,
    project_id: Option<String>,
    root_id: Option<String>,
    root_revision: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct ReviewContextScope {
    pub project_id: String,
    pub root_id: String,
    pub root_revision: u64,
}

pub struct ReviewContextSnapshotStore {
    entries: Mutex<HashMap<String, StoredSnapshot>>,
    ttl: Duration,
}
impl ReviewContextSnapshotStore {
    pub fn new(ttl: Duration) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            ttl,
        }
    }
    pub fn save(
        &self,
        prepared: PreparedExternalContext,
        parts: Vec<ReviewPromptPart>,
    ) -> Result<String, AppError> {
        self.save_scoped(prepared, parts, None)
    }

    /// Stores a prepared context bound to the project root revision which
    /// produced it. The session resolver must consume it through
    /// `consume_scoped`; this prevents replay after roots change or across
    /// projects.
    pub fn save_scoped(
        &self,
        mut prepared: PreparedExternalContext,
        parts: Vec<ReviewPromptPart>,
        scope: Option<ReviewContextScope>,
    ) -> Result<String, AppError> {
        let id = Uuid::new_v4().to_string();
        prepared.reference.id = id.clone();
        let expires_at = SystemTime::now() + self.ttl;
        let (project_id, root_id, root_revision) = scope
            .map(|value| {
                (
                    Some(value.project_id),
                    Some(value.root_id),
                    Some(value.root_revision),
                )
            })
            .unwrap_or((None, None, None));
        self.entries
            .lock()
            .map_err(|_| AppError::StatePoisoned)?
            .insert(
                id.clone(),
                StoredSnapshot {
                    prepared,
                    parts,
                    expires_at,
                    project_id,
                    root_id,
                    root_revision,
                },
            );
        Ok(id)
    }

    /// Consumes a reference once after checking project/root scope. A stale
    /// or mismatched reference is removed as well, preventing replay.
    pub fn consume_scoped(
        &self,
        id: &str,
        scope: &ReviewContextScope,
    ) -> Result<Option<(PreparedExternalContext, Vec<ReviewPromptPart>)>, AppError> {
        let mut entries = self.entries.lock().map_err(|_| AppError::StatePoisoned)?;
        let now = SystemTime::now();
        entries.retain(|_, value| value.expires_at > now);
        let Some(value) = entries.remove(id) else {
            return Ok(None);
        };
        if value.project_id.as_deref() != Some(scope.project_id.as_str())
            || value.root_id.as_deref() != Some(scope.root_id.as_str())
            || value.root_revision != Some(scope.root_revision)
        {
            return Err(AppError::Conflict(
                "Der externe GitLab-Kontext gehört nicht mehr zum aktuellen Projektstand."
                    .to_owned(),
            ));
        }
        Ok(Some((value.prepared, value.parts)))
    }

    /// Session-resolver convenience API: validates the project and current
    /// root revision and accepts the snapshot only when its producing root is
    /// still one of the project's roots. The caller should additionally check
    /// `session.project_id == project_id` before invoking this method.
    pub fn consume_for_project(
        &self,
        id: &str,
        project_id: &str,
        root_revision: u64,
        valid_root_ids: &[String],
    ) -> Result<Option<(PreparedExternalContext, Vec<ReviewPromptPart>)>, AppError> {
        let mut entries = self.entries.lock().map_err(|_| AppError::StatePoisoned)?;
        let now = SystemTime::now();
        entries.retain(|_, value| value.expires_at > now);
        let Some(value) = entries.remove(id) else {
            return Ok(None);
        };
        let root_is_current = value
            .root_id
            .as_deref()
            .is_some_and(|root_id| valid_root_ids.iter().any(|id| id == root_id));
        if value.project_id.as_deref() != Some(project_id)
            || value.root_revision != Some(root_revision)
            || !root_is_current
        {
            return Err(AppError::Conflict(
                "Der externe GitLab-Kontext gehört nicht mehr zum aktuellen Projektstand."
                    .to_owned(),
            ));
        }
        Ok(Some((value.prepared, value.parts)))
    }
    pub fn consume(
        &self,
        id: &str,
    ) -> Result<Option<(PreparedExternalContext, Vec<ReviewPromptPart>)>, AppError> {
        let mut entries = self.entries.lock().map_err(|_| AppError::StatePoisoned)?;
        let now = SystemTime::now();
        entries.retain(|_, value| value.expires_at > now);
        Ok(entries
            .remove(id)
            .map(|value| (value.prepared, value.parts)))
    }
}
