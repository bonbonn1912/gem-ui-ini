//! Repository discovery constrained to the project's authorised roots.

use super::runner::{run_git_command, GitCommandInput};
use crate::error::AppError;
use crate::projects::{ProjectAccess, ProjectRoot};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyRepositoryContext {
    pub state: RepositoryState,
    pub identity: String,
    pub root_ids: Vec<String>,
    pub display_name: String,
    pub worktree_label: String,
    pub worktree_path: PathBuf,
    pub git_dir: PathBuf,
    pub git_common_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepositoryState {
    Ready,
    NotGit,
    OutsideAuthority,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnavailableRepositoryContext {
    pub state: RepositoryState,
    pub identity: String,
    pub root_ids: Vec<String>,
    pub display_name: String,
    pub worktree_label: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveredRepositoryContext {
    Ready(ReadyRepositoryContext),
    Unavailable(UnavailableRepositoryContext),
}

pub async fn discover_project_repositories(
    access: &ProjectAccess,
    binary_path: &Path,
    aborted: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Vec<DiscoveredRepositoryContext> {
    let roots = std::iter::once(&access.primary_root).chain(access.additional_roots.iter());
    let mut result = Vec::new();
    let mut ready_by_identity: HashMap<String, usize> = HashMap::new();
    for root in roots {
        let found = discover_root(root, binary_path, aborted.clone()).await;
        if let DiscoveredRepositoryContext::Ready(ready) = &found {
            if let Some(existing_index) = ready_by_identity.get(&ready.identity).copied() {
                if let DiscoveredRepositoryContext::Ready(existing) = &mut result[existing_index] {
                    existing.root_ids.extend(ready.root_ids.iter().cloned());
                }
                continue;
            }
            ready_by_identity.insert(ready.identity.clone(), result.len());
        }
        result.push(found);
    }
    result
}

async fn discover_root(
    root: &ProjectRoot,
    binary_path: &Path,
    aborted: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> DiscoveredRepositoryContext {
    let fallback = (
        vec![root.id.clone()],
        root.label.clone(),
        root.label.clone(),
    );
    let inside = match read_rev_parse(
        binary_path,
        &root.real_path,
        &["--is-inside-work-tree"],
        aborted.clone(),
        true,
    )
    .await
    {
        Ok(Some(value)) if value == "true" => true,
        Ok(_) => false,
        Err(_) => {
            return unavailable(
                root,
                RepositoryState::Error,
                "Der Git-Kontext dieses Projektordners konnte nicht geprüft werden.",
            );
        }
    };
    if !inside {
        return unavailable(
            root,
            RepositoryState::NotGit,
            "Dieser Projektordner ist kein Git-Worktree.",
        );
    }
    if matches!(read_rev_parse(binary_path, &root.real_path, &["--is-bare-repository"], aborted.clone(), false).await, Ok(Some(value)) if value == "true")
    {
        return unavailable(
            root,
            RepositoryState::NotGit,
            "Bare Git-Repositories werden im Diff-Viewer nicht unterstützt.",
        );
    }

    let top = read_rev_parse(
        binary_path,
        &root.real_path,
        &["--path-format=absolute", "--show-toplevel"],
        aborted.clone(),
        false,
    )
    .await;
    let git_dir = read_rev_parse(
        binary_path,
        &root.real_path,
        &["--path-format=absolute", "--absolute-git-dir"],
        aborted.clone(),
        false,
    )
    .await;
    let common_dir = read_rev_parse(
        binary_path,
        &root.real_path,
        &["--path-format=absolute", "--git-common-dir"],
        aborted,
        false,
    )
    .await;
    let (Ok(Some(top)), Ok(Some(git_dir)), Ok(Some(common_dir))) = (top, git_dir, common_dir)
    else {
        return unavailable(
            root,
            RepositoryState::Error,
            "Der Git-Kontext dieses Projektordners konnte nicht geprüft werden.",
        );
    };
    let worktree_path = canonical_or_normalize(Path::new(&top));
    let authority = canonical_or_normalize(Path::new(&root.real_path));
    if !is_within(&authority, &worktree_path) {
        return unavailable(root, RepositoryState::OutsideAuthority, "Der ausgewählte Ordner liegt in einem größeren Git-Repository. Füge den Repository-Hauptordner als Projektroot hinzu, um alle Änderungen sicher anzuzeigen.");
    }
    let git_dir = canonical_or_normalize(Path::new(&git_dir));
    let common_dir = canonical_or_normalize(Path::new(&common_dir));
    let worktree_display = worktree_path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or(&root.label)
        .to_owned();
    DiscoveredRepositoryContext::Ready(ReadyRepositoryContext {
        state: RepositoryState::Ready,
        identity: format!(
            "{}\0{}",
            comparison_key(&worktree_path),
            comparison_key(&git_dir)
        ),
        root_ids: fallback.0,
        display_name: worktree_display.clone(),
        worktree_label: worktree_display,
        worktree_path,
        git_dir,
        git_common_dir: common_dir,
    })
}

fn unavailable(
    root: &ProjectRoot,
    state: RepositoryState,
    message: &str,
) -> DiscoveredRepositoryContext {
    DiscoveredRepositoryContext::Unavailable(UnavailableRepositoryContext {
        state,
        identity: format!("unavailable:{}", root.id),
        root_ids: vec![root.id.clone()],
        display_name: root.label.clone(),
        worktree_label: root.label.clone(),
        message: message.to_owned(),
    })
}

async fn read_rev_parse(
    binary: &Path,
    cwd: &str,
    args: &[&str],
    aborted: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    allow_failure: bool,
) -> Result<Option<String>, AppError> {
    let mut all_args = vec!["-C", cwd, "rev-parse"];
    all_args.extend_from_slice(args);
    let mut input = GitCommandInput::new(binary, &all_args);
    input.cwd = Some(Path::new(cwd));
    input.timeout = Duration::from_secs(5);
    input.max_stdout_bytes = 128 * 1024;
    input.max_stderr_bytes = 128 * 1024;
    input.read_only = true;
    input.aborted = aborted;
    let result = run_git_command(input).await?;
    if result.exit_code != Some(0) || result.timed_out || result.aborted || result.too_large {
        return if allow_failure {
            Ok(None)
        } else {
            Err(AppError::Upstream("git rev-parse failed".into()))
        };
    }
    Ok(Some(remove_line_ending(&String::from_utf8_lossy(
        &result.stdout,
    ))))
}

fn remove_line_ending(value: &str) -> String {
    value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value)
        .to_owned()
}

fn canonical_or_normalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn is_within(parent: &Path, candidate: &Path) -> bool {
    candidate == parent || candidate.strip_prefix(parent).is_ok()
}

pub fn comparison_key(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn containment_never_allows_a_sibling_prefix() {
        assert!(is_within(Path::new("/tmp/a"), Path::new("/tmp/a/b")));
        assert!(!is_within(Path::new("/tmp/a"), Path::new("/tmp/ab")));
    }
}
