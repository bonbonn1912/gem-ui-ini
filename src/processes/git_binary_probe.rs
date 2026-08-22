//! Configurable Git discovery and a bounded, read-only version probe.

use super::binary_probe::{resolve_executable_for, Environment, ProbePlatform, ResolveError};
use super::{redact_diagnostic_text, BoundedTextBuffer};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_STDOUT_BYTES: usize = 64 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitProbeSuccess {
    pub binary_path: PathBuf,
    pub version: String,
    pub raw_version: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitProbeResult {
    Ok(GitProbeSuccess),
    Err {
        code: GitProbeErrorCode,
        message: String,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitProbeErrorCode {
    BinaryNotFound,
    BinaryProbeFailed,
}

pub fn parse_git_version(value: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let marker = "git version ";
    let start = lower.find(marker).map(|index| index + marker.len())?;
    let bytes = value.as_bytes();
    let mut end = start;
    while end < bytes.len()
        && (bytes[end].is_ascii_digit() || bytes[end] == b'.' || bytes[end] == b'-')
    {
        end += 1;
    }
    (end > start && bytes[start].is_ascii_digit()).then(|| value[start..end].to_owned())
}

pub fn git_candidates(environment: &Environment, platform: ProbePlatform) -> Vec<PathBuf> {
    let executable = if platform == ProbePlatform::Windows {
        "git.exe"
    } else {
        "git"
    };
    let mut candidates = super::binary_probe::path_entries_for_tests(environment, platform);
    let from_path = candidates
        .drain(..)
        .map(|directory| directory.join(executable));
    let mut result: Vec<PathBuf> = from_path.collect();
    match platform {
        ProbePlatform::Macos => result.extend(
            [
                "/usr/bin/git",
                "/opt/homebrew/bin/git",
                "/usr/local/bin/git",
            ]
            .into_iter()
            .map(PathBuf::from),
        ),
        ProbePlatform::Windows => {
            if let Some(value) = environment.get("ProgramFiles") {
                result.extend([
                    PathBuf::from(value).join("Git/cmd/git.exe"),
                    PathBuf::from(value).join("Git/bin/git.exe"),
                ]);
            }
            if let Some(value) = environment.get("ProgramFiles(x86)") {
                result.push(PathBuf::from(value).join("Git/cmd/git.exe"));
            }
            if let Some(value) = environment.get("LOCALAPPDATA") {
                result.extend([
                    PathBuf::from(value).join("Programs/Git/cmd/git.exe"),
                    PathBuf::from(value).join("GitHubDesktop/app/git/cmd/git.exe"),
                ]);
            }
        }
        _ => result.extend(
            ["/usr/bin/git", "/usr/local/bin/git"]
                .into_iter()
                .map(PathBuf::from),
        ),
    }
    result
}

pub fn resolve_git_binary(
    candidate: Option<&str>,
    environment: &Environment,
    platform: ProbePlatform,
) -> Result<PathBuf, ResolveError> {
    if let Some(candidate) = candidate.filter(|value| !value.trim().is_empty()) {
        let path = if candidate.contains('/')
            || candidate.contains('\\')
            || Path::new(candidate).is_absolute()
        {
            PathBuf::from(candidate)
        } else {
            resolve_executable_for(candidate, environment, platform)?
        };
        if platform == ProbePlatform::Windows
            && path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| !value.eq_ignore_ascii_case("exe"))
                .unwrap_or(true)
        {
            return Err(ResolveError::NotExecutable(path));
        }
        return verify_git_file(&path, platform);
    }
    for path in git_candidates(environment, platform) {
        if let Ok(path) = verify_git_file(&path, platform) {
            return Ok(path);
        }
    }
    Err(ResolveError::NotFound("git".into()))
}

pub async fn probe_git_binary(
    candidate: Option<&str>,
    environment: &Environment,
    timeout_duration: Option<Duration>,
) -> GitProbeResult {
    let binary_path = match resolve_git_binary(candidate, environment, ProbePlatform::current()) {
        Ok(path) => path,
        Err(_) => {
            return GitProbeResult::Err {
                code: GitProbeErrorCode::BinaryNotFound,
                message: "Git wurde nicht gefunden.".into(),
            }
        }
    };
    let timeout_duration = timeout_duration.unwrap_or(DEFAULT_TIMEOUT);
    let mut command = Command::new(&binary_path);
    command
        .args(["--version"])
        .envs(environment)
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(std::env::temp_dir());
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return failed(),
    };
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let stdout_task = tokio::spawn(read_bounded(stdout, MAX_STDOUT_BYTES));
    let stderr_task = tokio::spawn(read_bounded(stderr, MAX_STDERR_BYTES));
    let status = match timeout(timeout_duration, child.wait()).await {
        Ok(Ok(status)) => status,
        _ => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return failed();
        }
    };
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    let secrets = environment
        .iter()
        .filter_map(|(key, value)| {
            let key = key.to_ascii_uppercase();
            (value.len() >= 6
                && ["TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY"]
                    .iter()
                    .any(|part| key.contains(part)))
            .then(|| value.clone())
        })
        .collect::<Vec<_>>();
    let raw_version = redact_diagnostic_text(
        format!(
            "{}\n{}",
            String::from_utf8_lossy(&stdout),
            String::from_utf8_lossy(&stderr)
        )
        .trim(),
        &secrets,
    );
    let version = match parse_git_version(&raw_version) {
        Some(version) if status.code() == Some(0) => version,
        _ => return failed(),
    };
    GitProbeResult::Ok(GitProbeSuccess {
        binary_path,
        version,
        raw_version,
    })
}

fn failed() -> GitProbeResult {
    GitProbeResult::Err {
        code: GitProbeErrorCode::BinaryProbeFailed,
        message: "Die gefundene Git-Installation konnte nicht geprüft werden.".into(),
    }
}
fn verify_git_file(path: &Path, platform: ProbePlatform) -> Result<PathBuf, ResolveError> {
    super::binary_probe::verify_file_for_git(path, platform)
}
async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(mut reader: R, limit: usize) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut buffer = BoundedTextBuffer::new(limit).unwrap_or_default();
    let mut chunk = [0_u8; 4096];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(size) => buffer.append(&chunk[..size]),
        }
    }
    buffer.as_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_git_versions() {
        assert_eq!(
            parse_git_version("git version 2.50.1 (Apple Git-155)"),
            Some("2.50.1".into())
        );
    }
    #[test]
    fn windows_candidates_include_standard_installations() {
        let env = Environment::from([(
            String::from("ProgramFiles"),
            String::from("C:/Program Files"),
        )]);
        let paths = git_candidates(&env, ProbePlatform::Windows);
        assert!(paths.iter().any(|path| path.ends_with("Git/cmd/git.exe")));
    }
}
