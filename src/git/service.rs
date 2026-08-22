//! Project-scoped Git status and diff service.

use super::diff::{parse_unified_diff, DiffLineKind, ParsedUnifiedDiff, UnifiedDiffError};
use super::discovery::{
    discover_project_repositories, DiscoveredRepositoryContext, ReadyRepositoryContext,
    RepositoryState,
};
use super::runner::{
    run_git_command, GitCommandInput, GIT_DIFF_OUTPUT_LIMIT, GIT_STATUS_OUTPUT_LIMIT,
};
use super::status::{ParsedGitStatus, ParsedGitStatusEntry};
use crate::error::AppError;
use crate::hub::SubscriptionHub;
use crate::projects::{sha256_hex, ProjectAccess, ProjectService};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, RwLock,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::task::JoinHandle;
use uuid::Uuid;

pub const MAX_GIT_REPOSITORIES: usize = 6;
pub const MAX_GIT_CHANGES: usize = 10_000;
const SNAPSHOT_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitRepositoryState {
    Ready,
    NotGit,
    OutsideAuthority,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRepositorySummary {
    pub repository_id: String,
    pub root_ids: Vec<String>,
    pub display_name: String,
    pub worktree_label: String,
    pub branch: Option<String>,
    pub head_oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub state: GitRepositoryState,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitFileChange {
    pub file_id: String,
    pub repository_id: String,
    pub path: String,
    pub previous_path: Option<String>,
    pub index_status: String,
    pub worktree_status: String,
    pub conflict: bool,
    pub untracked: bool,
    pub submodule: bool,
    pub rename_score: Option<u8>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitProjectStatus {
    pub project_id: String,
    pub root_revision: u64,
    pub refreshed_at: String,
    pub repositories: Vec<GitRepositorySummary>,
    pub changes: Vec<GitFileChange>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitStatusSubscriptionResult {
    pub subscription_id: String,
    pub status: GitProjectStatus,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitArea {
    Unstaged,
    Staged,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitFileDiffState {
    Text,
    Binary,
    Submodule,
    Conflict,
    TooLarge,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitDiffLineKind {
    Context,
    Addition,
    Deletion,
    NoNewline,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffLine {
    pub kind: GitDiffLineKind,
    pub content: String,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffHunk {
    pub hunk_id: String,
    pub header: String,
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<GitDiffLine>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitFileDiff {
    pub snapshot_id: String,
    pub repository_id: String,
    pub file_id: String,
    pub area: GitArea,
    pub path: String,
    pub previous_path: Option<String>,
    pub state: GitFileDiffState,
    pub message: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    pub metadata: Vec<String>,
    pub hunks: Vec<GitDiffHunk>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetGitProjectStatusInput {
    pub project_id: String,
    pub expected_root_revision: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetGitFileDiffInput {
    pub project_id: String,
    pub expected_root_revision: u64,
    pub repository_id: String,
    pub file_id: String,
    pub area: GitArea,
}

#[derive(Debug, Clone)]
struct FileSnapshot {
    key: String,
    created_at: SystemTime,
    project_id: String,
    root_revision: u64,
    repository_id: String,
    repository_identity: String,
    entry: ParsedGitStatusEntry,
}

pub struct GitService {
    projects: Arc<ProjectService>,
    binary_path: RwLock<Option<PathBuf>>,
    repository_ids: Mutex<HashMap<String, String>>,
    snapshots: Mutex<HashMap<String, FileSnapshot>>,
}

impl GitService {
    pub fn new(projects: Arc<ProjectService>, binary_path: Option<PathBuf>) -> Self {
        Self {
            projects,
            binary_path: RwLock::new(binary_path),
            repository_ids: Mutex::new(HashMap::new()),
            snapshots: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_binary_path(&self, binary_path: Option<PathBuf>) -> Result<(), AppError> {
        *self
            .binary_path
            .write()
            .map_err(|_| AppError::StatePoisoned)? = binary_path;
        Ok(())
    }

    pub fn binary_path(&self) -> Result<Option<PathBuf>, AppError> {
        Ok(self
            .binary_path
            .read()
            .map_err(|_| AppError::StatePoisoned)?
            .clone())
    }

    pub async fn list_project_repositories(
        &self,
        input: GetGitProjectStatusInput,
    ) -> Result<GitRepositoryList, AppError> {
        let status = self.get_project_status(input).await?;
        Ok(GitRepositoryList {
            project_id: status.project_id,
            root_revision: status.root_revision,
            repositories: status.repositories,
        })
    }

    pub async fn get_project_status(
        &self,
        input: GetGitProjectStatusInput,
    ) -> Result<GitProjectStatus, AppError> {
        self.prune_snapshots();
        let access = self.projects.get_current_access(&input.project_id).await?;
        ensure_revision(&access, input.expected_root_revision)?;
        let Some(binary) = self.binary_path()? else {
            return Ok(self.unavailable_status(&access));
        };
        let contexts = discover_project_repositories(&access, &binary, None).await;
        let mut repositories = Vec::new();
        let mut changes = Vec::new();
        for context in contexts {
            let (repo_id, root_ids, display_name, worktree_label) = match &context {
                DiscoveredRepositoryContext::Ready(value) => (
                    self.repository_id(&value.identity)?,
                    value.root_ids.clone(),
                    value.display_name.clone(),
                    value.worktree_label.clone(),
                ),
                DiscoveredRepositoryContext::Unavailable(value) => (
                    self.repository_id(&value.identity)?,
                    value.root_ids.clone(),
                    value.display_name.clone(),
                    value.worktree_label.clone(),
                ),
            };
            let Some(ready) = (match &context {
                DiscoveredRepositoryContext::Ready(value) => Some(value),
                _ => None,
            }) else {
                if let DiscoveredRepositoryContext::Unavailable(value) = context {
                    repositories.push(GitRepositorySummary {
                        repository_id: repo_id,
                        root_ids,
                        display_name,
                        worktree_label,
                        branch: None,
                        head_oid: None,
                        upstream: None,
                        ahead: 0,
                        behind: 0,
                        state: state_from_discovery(value.state),
                        message: Some(value.message),
                    });
                }
                continue;
            };
            let parsed = match self.read_status(&binary, ready).await {
                Ok(value) => value,
                Err(message) => {
                    repositories.push(GitRepositorySummary {
                        repository_id: repo_id,
                        root_ids,
                        display_name,
                        worktree_label,
                        branch: None,
                        head_oid: None,
                        upstream: None,
                        ahead: 0,
                        behind: 0,
                        state: GitRepositoryState::Error,
                        message: Some(message),
                    });
                    continue;
                }
            };
            if changes.len().saturating_add(parsed.entries.len()) > MAX_GIT_CHANGES {
                repositories.push(GitRepositorySummary {
                    repository_id: repo_id,
                    root_ids,
                    display_name,
                    worktree_label,
                    branch: parsed.branch.head.clone(),
                    head_oid: parsed.branch.oid.clone(),
                    upstream: parsed.branch.upstream.clone(),
                    ahead: parsed.branch.ahead,
                    behind: parsed.branch.behind,
                    state: GitRepositoryState::Error,
                    message: Some(
                        "Dieses Projekt enthält zu viele Änderungen für eine sichere Anzeige."
                            .into(),
                    ),
                });
                continue;
            }
            repositories.push(GitRepositorySummary {
                repository_id: repo_id.clone(),
                root_ids,
                display_name,
                worktree_label,
                branch: parsed.branch.head.clone(),
                head_oid: parsed.branch.oid.clone(),
                upstream: parsed.branch.upstream.clone(),
                ahead: parsed.branch.ahead,
                behind: parsed.branch.behind,
                state: GitRepositoryState::Ready,
                message: None,
            });
            for entry in parsed.entries {
                let file_id = self.store_snapshot(&access, &repo_id, ready, entry.clone())?;
                changes.push(GitFileChange {
                    file_id,
                    repository_id: repo_id.clone(),
                    path: entry.path,
                    previous_path: entry.previous_path,
                    index_status: entry.index_status,
                    worktree_status: entry.worktree_status,
                    conflict: entry.conflict,
                    untracked: entry.untracked,
                    submodule: entry.submodule,
                    rename_score: entry.rename_score,
                });
            }
        }
        Ok(GitProjectStatus {
            project_id: access.project_id,
            root_revision: access.root_revision,
            refreshed_at: now_iso(),
            repositories,
            changes,
        })
    }

    /// Refresh a project and fan the contract-shaped status out to the
    /// existing Tauri subscription hub. The generic `Value` hub is used here
    /// because the app state intentionally keeps all channel payloads behind
    /// one shared hub type.
    pub async fn refresh_and_publish(
        &self,
        input: GetGitProjectStatusInput,
        hub: &SubscriptionHub<String, Value>,
    ) -> Result<GitProjectStatus, AppError> {
        let status = self.get_project_status(input).await?;
        let payload = serde_json::to_value(&status)?;
        hub.notify(&status.project_id, payload);
        Ok(status)
    }

    pub async fn get_file_diff(&self, input: GetGitFileDiffInput) -> Result<GitFileDiff, AppError> {
        self.prune_snapshots();
        let snapshot = self
            .snapshots
            .lock()
            .map_err(|_| AppError::StatePoisoned)?
            .get(&input.file_id)
            .cloned()
            .ok_or_else(|| {
                AppError::Conflict(
                    "Der Änderungsstand ist nicht mehr aktuell. Bitte lade die Änderungen neu."
                        .into(),
                )
            })?;
        if snapshot.project_id != input.project_id
            || snapshot.root_revision != input.expected_root_revision
            || snapshot.repository_id != input.repository_id
        {
            return Err(AppError::Conflict(
                "Der Änderungsstand ist nicht mehr aktuell. Bitte lade die Änderungen neu.".into(),
            ));
        }
        ensure_area(&snapshot.entry, &input.area)?;
        let access = self.projects.get_current_access(&input.project_id).await?;
        ensure_revision(&access, input.expected_root_revision)?;
        let Some(binary) = self.binary_path()? else {
            return Ok(special_diff(
                &input,
                &snapshot.entry,
                GitFileDiffState::Unavailable,
                "Git ist nicht verfügbar.",
            ));
        };
        let contexts = discover_project_repositories(&access, &binary, None).await;
        let Some(ready) = contexts.into_iter().find_map(|value| match value {
            DiscoveredRepositoryContext::Ready(value)
                if value.identity == snapshot.repository_identity =>
            {
                Some(value)
            }
            _ => None,
        }) else {
            return Err(AppError::NotFound("Das Git-Repository ist nicht mehr innerhalb der freigegebenen Projektordner verfügbar.".into()));
        };
        if snapshot.entry.conflict {
            return Ok(special_diff(&input, &snapshot.entry, GitFileDiffState::Conflict, "Diese Datei enthält einen Merge-Konflikt. Ein normaler Textdiff ist hier nicht eindeutig."));
        }
        if snapshot.entry.submodule {
            return Ok(special_diff(&input, &snapshot.entry, GitFileDiffState::Submodule, "Das Submodule wird als Commit-Änderung angezeigt; sein eigener Inhalt gehört nicht zu diesem Viewer."));
        }
        if snapshot.entry.untracked {
            return self.untracked_diff(&input, &snapshot.entry, &ready).await;
        }
        let args = build_diff_args(&ready.worktree_path, &snapshot.entry, &input.area);
        let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
        let mut command = GitCommandInput::new(&binary, &refs);
        command.cwd = Some(&ready.worktree_path);
        command.read_only = true;
        command.timeout = Duration::from_secs(15);
        command.max_stdout_bytes = GIT_DIFF_OUTPUT_LIMIT;
        let result = run_git_command(command).await?;
        if result.too_large {
            return Ok(special_diff(
                &input,
                &snapshot.entry,
                GitFileDiffState::TooLarge,
                "Der Diff ist größer als 5 MiB und wird deshalb nicht teilweise angezeigt.",
            ));
        }
        if result.aborted {
            return Err(AppError::Conflict(
                "Der Diff-Aufruf wurde abgebrochen.".into(),
            ));
        }
        if result.timed_out || result.exit_code != Some(0) {
            return Ok(special_diff(
                &input,
                &snapshot.entry,
                GitFileDiffState::Error,
                "Der Git-Diff konnte nicht vollständig erzeugt werden.",
            ));
        }
        if result.stdout.is_empty() {
            return Ok(special_diff(&input, &snapshot.entry, GitFileDiffState::Unavailable, "Für den aktuellen Dateistand ist kein Diff mehr vorhanden. Lade die Änderungen neu."));
        }
        match parse_unified_diff(&result.stdout) {
            Ok(parsed) => Ok(parsed_diff(&input, &snapshot.entry, parsed)),
            Err(UnifiedDiffError::DiffLineLimit(_)) => Ok(special_diff(
                &input,
                &snapshot.entry,
                GitFileDiffState::TooLarge,
                "Der Diff enthält zu viele Zeilen und wird deshalb nicht teilweise angezeigt.",
            )),
            Err(_) => Ok(special_diff(
                &input,
                &snapshot.entry,
                GitFileDiffState::Error,
                "Der vollständige Git-Diff konnte nicht sicher geparst werden.",
            )),
        }
    }

    async fn read_status(
        &self,
        binary: &Path,
        context: &ReadyRepositoryContext,
    ) -> Result<ParsedGitStatus, String> {
        let path = context.worktree_path.to_string_lossy().to_string();
        let args = [
            "--literal-pathspecs",
            "-c",
            "color.ui=false",
            "-c",
            "core.quotepath=false",
            "-C",
            path.as_str(),
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ];
        let mut command = GitCommandInput::new(binary, &args);
        command.cwd = Some(&context.worktree_path);
        command.read_only = true;
        command.timeout = Duration::from_secs(10);
        command.max_stdout_bytes = GIT_STATUS_OUTPUT_LIMIT;
        let result = run_git_command(command)
            .await
            .map_err(|_| "Der Git-Status konnte nicht gelesen werden.".to_owned())?;
        if result.exit_code != Some(0) || result.timed_out || result.aborted || result.too_large {
            return Err(
                "Der Git-Status ist zu groß oder konnte nicht vollständig gelesen werden.".into(),
            );
        }
        super::status::parse_porcelain_v2(&result.stdout)
            .map_err(|_| "Der Git-Status konnte nicht sicher geparst werden.".into())
    }

    async fn untracked_diff(
        &self,
        input: &GetGitFileDiffInput,
        entry: &ParsedGitStatusEntry,
        context: &ReadyRepositoryContext,
    ) -> Result<GitFileDiff, AppError> {
        let absolute = resolve_repository_path(&context.worktree_path, &entry.path)?;
        let metadata = fs::symlink_metadata(&absolute)?;
        let mut bytes = Vec::new();
        let mode;
        if metadata.file_type().is_symlink() {
            bytes = fs::read_link(&absolute)?
                .to_string_lossy()
                .as_bytes()
                .to_vec();
            mode = "120000".to_owned();
        } else if metadata.is_file() {
            if metadata.len() > GIT_DIFF_OUTPUT_LIMIT as u64 {
                return Ok(special_diff(
                    input,
                    entry,
                    GitFileDiffState::TooLarge,
                    "Die unversionierte Datei ist größer als 5 MiB.",
                ));
            }
            let mut file = OpenOptions::new().read(true).open(&absolute)?;
            let opened = file.metadata()?;
            if !opened.is_file() || opened.len() > GIT_DIFF_OUTPUT_LIMIT as u64 {
                return Ok(special_diff(
                    input,
                    entry,
                    GitFileDiffState::TooLarge,
                    "Die unversionierte Datei ist zu groß oder kein regulärer Textinhalt.",
                ));
            }
            file.read_to_end(&mut bytes)?;
            mode = if metadata.permissions().mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            }
            .to_owned();
        } else {
            return Ok(special_diff(
                input,
                entry,
                GitFileDiffState::Unavailable,
                "Dieser unversionierte Dateityp kann nicht als Textdiff angezeigt werden.",
            ));
        }
        if looks_binary(&bytes) {
            return Ok(special_diff_with_metadata(
                input,
                entry,
                GitFileDiffState::Binary,
                "Binärdatei – es gibt keinen darstellbaren Textdiff.",
                vec![format!("new file mode {mode}")],
            ));
        }
        if bytes.len() > GIT_DIFF_OUTPUT_LIMIT {
            return Ok(special_diff(
                input,
                entry,
                GitFileDiffState::TooLarge,
                "Die unversionierte Datei ist größer als 5 MiB.",
            ));
        }
        Ok(parsed_diff(
            input,
            entry,
            create_untracked_diff(&bytes, &mode)?,
        ))
    }

    fn repository_id(&self, identity: &str) -> Result<String, AppError> {
        let mut ids = self
            .repository_ids
            .lock()
            .map_err(|_| AppError::StatePoisoned)?;
        Ok(ids
            .entry(identity.to_owned())
            .or_insert_with(|| Uuid::new_v4().to_string())
            .clone())
    }

    fn store_snapshot(
        &self,
        access: &ProjectAccess,
        repository_id: &str,
        context: &ReadyRepositoryContext,
        entry: ParsedGitStatusEntry,
    ) -> Result<String, AppError> {
        let signature = if entry.untracked || entry.worktree_status != "." || entry.conflict {
            metadata_signature(&context.worktree_path, &entry.path)
        } else {
            None
        };
        let key = sha256_hex(
            serde_json::to_string(&(
                access.project_id.as_str(),
                access.root_revision,
                repository_id,
                &entry,
                signature,
            ))
            .unwrap_or_default()
            .as_bytes(),
        );
        let mut snapshots = self.snapshots.lock().map_err(|_| AppError::StatePoisoned)?;
        if let Some((file_id, existing)) = snapshots.iter_mut().find(|(_, value)| value.key == key)
        {
            existing.created_at = SystemTime::now();
            existing.entry = entry;
            return Ok(file_id.clone());
        }
        let file_id = Uuid::new_v4().to_string();
        snapshots.insert(
            file_id.clone(),
            FileSnapshot {
                key,
                created_at: SystemTime::now(),
                project_id: access.project_id.clone(),
                root_revision: access.root_revision,
                repository_id: repository_id.to_owned(),
                repository_identity: context.identity.clone(),
                entry,
            },
        );
        Ok(file_id)
    }

    fn prune_snapshots(&self) {
        if let Ok(mut snapshots) = self.snapshots.lock() {
            let cutoff = SystemTime::now()
                .checked_sub(SNAPSHOT_TTL)
                .unwrap_or(UNIX_EPOCH);
            snapshots.retain(|_, value| value.created_at >= cutoff);
        }
    }

    fn unavailable_status(&self, access: &ProjectAccess) -> GitProjectStatus {
        let roots = std::iter::once(&access.primary_root).chain(access.additional_roots.iter());
        let repositories = roots
            .map(|root| GitRepositorySummary {
                repository_id: self
                    .repository_id(&format!("unavailable:{}", root.id))
                    .unwrap_or_else(|_| root.id.clone()),
                root_ids: vec![root.id.clone()],
                display_name: root.label.clone(),
                worktree_label: root.label.clone(),
                branch: None,
                head_oid: None,
                upstream: None,
                ahead: 0,
                behind: 0,
                state: GitRepositoryState::Unavailable,
                message: Some(
                    "Git wurde nicht gefunden. Chat und Gemini funktionieren weiterhin.".into(),
                ),
            })
            .collect();
        GitProjectStatus {
            project_id: access.project_id.clone(),
            root_revision: access.root_revision,
            refreshed_at: now_iso(),
            repositories,
            changes: Vec::new(),
        }
    }
}

/// A bounded, cancellable status poller. Command handlers subscribe their
/// `tauri::ipc::Channel<Value>` to the shared hub and retain this handle while
/// the subscription is active.
pub struct GitStatusPollerHandle {
    stop: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl GitStatusPollerHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

impl Drop for GitStatusPollerHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.task.abort();
    }
}

pub fn spawn_status_poller(
    service: Arc<GitService>,
    input: GetGitProjectStatusInput,
    hub: SubscriptionHub<String, Value>,
    interval: Duration,
) -> GitStatusPollerHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let poll_stop = Arc::clone(&stop);
    let task = tokio::spawn(async move {
        let interval = interval.max(Duration::from_millis(250));
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if poll_stop.load(Ordering::Acquire) {
                break;
            }
            let _ = service.refresh_and_publish(input.clone(), &hub).await;
        }
    });
    GitStatusPollerHandle { stop, task }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRepositoryList {
    pub project_id: String,
    pub root_revision: u64,
    pub repositories: Vec<GitRepositorySummary>,
}

fn state_from_discovery(value: RepositoryState) -> GitRepositoryState {
    match value {
        RepositoryState::Ready => GitRepositoryState::Ready,
        RepositoryState::NotGit => GitRepositoryState::NotGit,
        RepositoryState::OutsideAuthority => GitRepositoryState::OutsideAuthority,
        RepositoryState::Error => GitRepositoryState::Error,
    }
}

fn ensure_revision(access: &ProjectAccess, expected: u64) -> Result<(), AppError> {
    if access.root_revision == expected {
        Ok(())
    } else {
        Err(AppError::Conflict("Die Projektordner wurden geändert. Lade die Änderungen für die aktuelle Root-Liste neu.".into()))
    }
}
fn ensure_area(entry: &ParsedGitStatusEntry, area: &GitArea) -> Result<(), AppError> {
    let available = match area {
        GitArea::Staged => entry.index_status != "." && !entry.untracked,
        GitArea::Unstaged => entry.worktree_status != "." || entry.untracked || entry.conflict,
    };
    if available {
        Ok(())
    } else {
        Err(AppError::Conflict(
            "Die angeforderte Diff-Ansicht gehört nicht zu diesem Dateistand.".into(),
        ))
    }
}

fn build_diff_args(worktree: &Path, entry: &ParsedGitStatusEntry, area: &GitArea) -> Vec<String> {
    let mut args = vec![
        "--literal-pathspecs".into(),
        "-c".into(),
        "color.ui=false".into(),
        "-c".into(),
        "core.quotepath=false".into(),
        "-C".into(),
        worktree.to_string_lossy().into_owned(),
        "diff".into(),
    ];
    if matches!(area, GitArea::Staged) {
        args.push("--cached".into());
    }
    args.extend(
        [
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--unified=3",
            "--find-renames",
            "--",
        ]
        .into_iter()
        .map(str::to_owned),
    );
    if let Some(path) = entry.previous_path.as_ref() {
        args.push(path.clone());
    }
    args.push(entry.path.clone());
    args
}

fn resolve_repository_path(worktree: &Path, git_path: &str) -> Result<PathBuf, AppError> {
    if git_path.is_empty()
        || git_path.contains('\0')
        || Path::new(git_path).is_absolute()
        || git_path.split('/').any(|part| part == "..")
    {
        return Err(AppError::Validation("Git returned an unsafe path".into()));
    }
    let path = worktree.join(git_path.split('/').collect::<PathBuf>());
    if !super::discovery::is_within(worktree, &path) {
        return Err(AppError::Validation(
            "Git returned a path outside the worktree".into(),
        ));
    }
    Ok(path)
}
fn metadata_signature(worktree: &Path, path: &str) -> Option<String> {
    let metadata = fs::symlink_metadata(resolve_repository_path(worktree, path).ok()?).ok()?;
    Some(format!(
        "{}:{}:{}",
        metadata.len(),
        metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
        if metadata.file_type().is_symlink() {
            "link"
        } else if metadata.is_file() {
            "file"
        } else {
            "other"
        }
    ))
}
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8_192).any(|value| *value == 0) || String::from_utf8(bytes.to_vec()).is_err()
}

fn create_untracked_diff(bytes: &[u8], mode: &str) -> Result<ParsedUnifiedDiff, AppError> {
    let text =
        String::from_utf8(bytes.to_vec()).map_err(|_| AppError::Validation("binary".into()))?;
    let trailing = text.ends_with('\n');
    let mut lines = text.split('\n').map(str::to_owned).collect::<Vec<_>>();
    if trailing {
        lines.pop();
    }
    if lines.len() > super::diff::MAX_GIT_DIFF_LINES
        || lines.iter().any(|line| line.len() > 131_072)
    {
        return Err(AppError::Conflict(
            "Die unversionierte Datei enthält zu viele oder zu lange Zeilen.".into(),
        ));
    }
    let additions = lines.len();
    let mut diff_lines = lines
        .iter()
        .enumerate()
        .map(|(index, line)| super::diff::DiffLine {
            kind: DiffLineKind::Addition,
            content: line.strip_suffix('\r').unwrap_or(line).to_owned(),
            old_line: None,
            new_line: Some(index + 1),
        })
        .collect::<Vec<_>>();
    if !trailing && !bytes.is_empty() {
        diff_lines.push(super::diff::DiffLine {
            kind: DiffLineKind::NoNewline,
            content: "No newline at end of file".into(),
            old_line: None,
            new_line: None,
        });
    }
    Ok(ParsedUnifiedDiff {
        binary: false,
        additions,
        deletions: 0,
        metadata: vec![format!("new file mode {mode}")],
        hunks: if lines.is_empty() {
            Vec::new()
        } else {
            vec![super::diff::DiffHunk {
                hunk_id: sha256_hex(
                    format!("untracked\0{}\0{}", bytes.len(), lines.len()).as_bytes(),
                ),
                header: format!("@@ -0,0 +1,{} @@", lines.len()),
                old_start: 0,
                old_lines: 0,
                new_start: 1,
                new_lines: lines.len(),
                lines: diff_lines,
            }]
        },
    })
}

fn parsed_diff(
    input: &GetGitFileDiffInput,
    entry: &ParsedGitStatusEntry,
    parsed: ParsedUnifiedDiff,
) -> GitFileDiff {
    let binary = parsed.binary;
    GitFileDiff {
        snapshot_id: Uuid::new_v4().to_string(),
        repository_id: input.repository_id.clone(),
        file_id: input.file_id.clone(),
        area: input.area.clone(),
        path: entry.path.clone(),
        previous_path: entry.previous_path.clone(),
        state: if binary {
            GitFileDiffState::Binary
        } else {
            GitFileDiffState::Text
        },
        message: binary.then(|| "Binärdatei – es gibt keinen darstellbaren Textdiff.".into()),
        additions: parsed.additions,
        deletions: parsed.deletions,
        metadata: parsed.metadata,
        hunks: parsed
            .hunks
            .into_iter()
            .map(|hunk| GitDiffHunk {
                hunk_id: hunk.hunk_id,
                header: hunk.header,
                old_start: hunk.old_start,
                old_lines: hunk.old_lines,
                new_start: hunk.new_start,
                new_lines: hunk.new_lines,
                lines: hunk
                    .lines
                    .into_iter()
                    .map(|line| GitDiffLine {
                        kind: match line.kind {
                            DiffLineKind::Context => GitDiffLineKind::Context,
                            DiffLineKind::Addition => GitDiffLineKind::Addition,
                            DiffLineKind::Deletion => GitDiffLineKind::Deletion,
                            DiffLineKind::NoNewline => GitDiffLineKind::NoNewline,
                        },
                        content: line.content,
                        old_line: line.old_line,
                        new_line: line.new_line,
                    })
                    .collect(),
            })
            .collect(),
    }
}
fn special_diff(
    input: &GetGitFileDiffInput,
    entry: &ParsedGitStatusEntry,
    state: GitFileDiffState,
    message: &str,
) -> GitFileDiff {
    special_diff_with_metadata(input, entry, state, message, Vec::new())
}
fn special_diff_with_metadata(
    input: &GetGitFileDiffInput,
    entry: &ParsedGitStatusEntry,
    state: GitFileDiffState,
    message: &str,
    metadata: Vec<String>,
) -> GitFileDiff {
    GitFileDiff {
        snapshot_id: Uuid::new_v4().to_string(),
        repository_id: input.repository_id.clone(),
        file_id: input.file_id.clone(),
        area: input.area.clone(),
        path: entry.path.clone(),
        previous_path: entry.previous_path.clone(),
        state,
        message: Some(message.into()),
        additions: 0,
        deletions: 0,
        metadata,
        hunks: Vec::new(),
    }
}
/// Format an instant as a real UTC RFC3339 timestamp.
///
/// Keeping this conversion here avoids bringing another time dependency into
/// the small service modules while still producing calendar-correct dates
/// (including dates after 1970, unlike the old placeholder formatter).
pub fn rfc3339_from_system_time(value: SystemTime) -> String {
    let duration = value.duration_since(UNIX_EPOCH).unwrap_or_default();
    let millis = duration.subsec_millis();
    let days = (duration.as_secs() / 86_400) as i64;
    let seconds = duration.as_secs() % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

pub fn now_iso() -> String {
    rfc3339_from_system_time(SystemTime::now())
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    (year + if month <= 2 { 1 } else { 0 }, month, day)
}

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[cfg(not(unix))]
trait PermissionsExt {
    fn mode(&self) -> u32;
}
#[cfg(not(unix))]
impl PermissionsExt for std::fs::Permissions {
    fn mode(&self) -> u32 {
        0o644
    }
}

#[cfg(test)]
mod timestamp_tests {
    use super::rfc3339_from_system_time;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn formats_calendar_date_and_milliseconds_in_utc() {
        let value = UNIX_EPOCH + Duration::from_secs(1_704_067_200) + Duration::from_millis(123);
        assert_eq!(rfc3339_from_system_time(value), "2024-01-01T00:00:00.123Z");
    }
}
