use super::contracts::*;
use super::remote_url::parse_gitlab_remote_url;
use super::repository::GitLabRepository;
use crate::error::AppError;
use crate::git::{run_git_command, GitCommandInput};
use crate::projects::sha256_hex;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub fn compute_repository_key(toplevel: &Path, git_dir: &Path) -> String {
    sha256_hex(
        format!(
            "worktree:{}\ngitdir:{}",
            toplevel.to_string_lossy(),
            git_dir.to_string_lossy()
        )
        .as_bytes(),
    )
}

#[derive(Debug, Clone)]
pub struct BindingRoot {
    pub id: String,
    pub label: String,
    pub real_path: PathBuf,
}
pub struct RepositoryBindingResolver {
    repository: GitLabRepository,
}
impl RepositoryBindingResolver {
    pub fn new(repository: GitLabRepository) -> Self {
        Self { repository }
    }
    pub async fn discover_candidates(
        &self,
        git_binary: &Path,
        project_id: &str,
        roots: &[BindingRoot],
    ) -> Result<Vec<GitLabRepositoryCandidate>, AppError> {
        let existing = self.repository.list_bindings(project_id)?;
        let mut candidates = Vec::new();
        for root in roots {
            let Some(info) = inspect_root(git_binary, root).await? else {
                continue;
            };
            if !info.toplevel.starts_with(&root.real_path) {
                continue;
            };
            let key = compute_repository_key(&info.toplevel, &info.git_dir);
            if let Some(candidate) = candidates
                .iter_mut()
                .find(|value: &&mut GitLabRepositoryCandidate| value.candidate_id == key)
            {
                candidate.root_ids.push(root.id.clone());
                continue;
            }
            let binding = existing
                .iter()
                .find(|value| value.repository_key == key)
                .cloned();
            candidates.push(GitLabRepositoryCandidate {
                candidate_id: key,
                root_ids: vec![root.id.clone()],
                display_name: info
                    .toplevel
                    .file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or(&root.label)
                    .into(),
                branch: info.branch,
                head_sha: info.head_sha,
                remotes: info.remotes,
                binding,
            });
        }
        Ok(candidates)
    }
}
struct RootInfo {
    toplevel: PathBuf,
    git_dir: PathBuf,
    branch: Option<String>,
    head_sha: Option<String>,
    remotes: Vec<GitLabRepositoryCandidateRemote>,
}
async fn inspect_root(binary: &Path, root: &BindingRoot) -> Result<Option<RootInfo>, AppError> {
    let inside = git_value(
        binary,
        &root.real_path,
        &["rev-parse", "--is-inside-work-tree"],
    )
    .await?;
    if inside.as_deref() != Some("true") {
        return Ok(None);
    }
    let Some(toplevel) = git_value(binary, &root.real_path, &["rev-parse", "--show-toplevel"])
        .await?
        .map(PathBuf::from)
    else {
        return Ok(None);
    };
    let git_dir = git_value(
        binary,
        &root.real_path,
        &["rev-parse", "--absolute-git-dir"],
    )
    .await?
    .map(PathBuf::from)
    .unwrap_or_else(|| toplevel.join(".git"));
    let branch = git_value(
        binary,
        &root.real_path,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .await?;
    let head_sha = git_value(binary, &root.real_path, &["rev-parse", "HEAD"]).await?;
    let remote_text = git_value(
        binary,
        &root.real_path,
        &["config", "--local", "--get-regexp", "^remote\\..*\\.url$"],
    )
    .await?
    .unwrap_or_default();
    let remotes = remote_text
        .lines()
        .filter_map(|line| {
            let (name, url) = line.trim().split_once(' ')?;
            let name = name.strip_prefix("remote.")?.strip_suffix(".url")?;
            let parsed = parse_gitlab_remote_url(url);
            Some(GitLabRepositoryCandidateRemote {
                name: name.into(),
                url: parsed
                    .as_ref()
                    .map(|v| v.sanitized_url.clone())
                    .unwrap_or_else(|| url.into()),
                suggested_instance_url: parsed.as_ref().map(|v| v.instance_url.clone()),
                suggested_project_path: parsed.map(|v| v.project_path),
            })
        })
        .collect();
    Ok(Some(RootInfo {
        toplevel,
        git_dir,
        branch,
        head_sha,
        remotes,
    }))
}
async fn git_value(binary: &Path, cwd: &Path, args: &[&str]) -> Result<Option<String>, AppError> {
    let mut full = vec!["-C".to_owned(), cwd.to_string_lossy().into_owned()];
    full.extend(args.iter().map(|v| (*v).into()));
    let refs = full.iter().map(String::as_str).collect::<Vec<_>>();
    let mut command = GitCommandInput::new(binary, &refs);
    command.cwd = Some(cwd);
    command.timeout = Duration::from_secs(3);
    command.read_only = true;
    let result = run_git_command(command).await?;
    Ok((result.exit_code == Some(0) && !result.too_large)
        .then(|| String::from_utf8_lossy(&result.stdout).trim().into()))
}
