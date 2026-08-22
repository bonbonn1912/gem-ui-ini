//! Shell-free Gemini CLI discovery and capability probing.
//!
//! This module deliberately keeps discovery separate from process startup. A
//! selected npm shim is inspected, never executed: on Windows its declared
//! JavaScript entry point is passed to `node.exe` directly.

use super::{redact_diagnostic_text, BoundedTextBuffer};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_STDOUT_BYTES: usize = 1024 * 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;

pub type Environment = HashMap<String, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbePlatform {
    Macos,
    Linux,
    Windows,
    Other,
}

impl ProbePlatform {
    pub const fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            return Self::Macos;
        }
        #[cfg(target_os = "linux")]
        {
            return Self::Linux;
        }
        #[cfg(target_os = "windows")]
        {
            return Self::Windows;
        }
        #[allow(unreachable_code)]
        Self::Other
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiLaunchCommand {
    pub executable_path: PathBuf,
    pub executable_args: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiCliFeatures {
    pub acp: bool,
    pub include_directories: bool,
    pub resume: bool,
    pub list_sessions: bool,
    pub delete_session: bool,
    pub approval_mode: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiProbeSuccess {
    pub binary_path: PathBuf,
    pub executable_path: PathBuf,
    pub executable_args: Vec<PathBuf>,
    pub version: String,
    /// Combined version output, bounded and redacted before it leaves this module.
    pub raw_version: String,
    pub features: GeminiCliFeatures,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GeminiProbeResult {
    Ok(GeminiProbeSuccess),
    Err {
        candidate: String,
        code: GeminiProbeErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeminiProbeErrorCode {
    BinaryNotFound,
    BinaryNotExecutable,
    BinaryProbeFailed,
    AcpUnsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ResolveError {
    #[error("binary candidate is empty")]
    Empty,
    #[error("could not find {0} on PATH")]
    NotFound(String),
    #[error("binary candidate is not a regular file: {0}")]
    NotFile(PathBuf),
    #[error("binary candidate is not executable: {0}")]
    NotExecutable(PathBuf),
    #[error("could not inspect binary candidate {0}: {1}")]
    Io(PathBuf, String),
    #[error("invalid Gemini npm shim: {0}")]
    InvalidShim(String),
}

/// Resolve a configured candidate using the host platform and process environment.
pub fn resolve_executable(
    candidate: &str,
    environment: &Environment,
) -> Result<PathBuf, ResolveError> {
    resolve_executable_for(candidate, environment, ProbePlatform::current())
}

/// Platform-parametrized resolver used by tests and by platform-specific callers.
pub fn resolve_executable_for(
    candidate: &str,
    environment: &Environment,
    platform: ProbePlatform,
) -> Result<PathBuf, ResolveError> {
    let candidate = candidate.trim();
    if candidate.is_empty() {
        return Err(ResolveError::Empty);
    }
    if has_path_separator(candidate) || is_absolute_for(candidate, platform) {
        return verify_executable(&absolute_path(candidate), platform);
    }

    let mut directories = path_entries(environment, platform);
    directories.extend(default_executable_directories(environment, platform));
    let extensions = if platform == ProbePlatform::Windows {
        environment
            .get("PATHEXT")
            .map(|value| value.split(';').collect::<Vec<_>>())
            .filter(|values| !values.is_empty())
            .unwrap_or_else(|| vec![".EXE", ".CMD", ".BAT", ".COM"])
    } else {
        vec![""]
    };
    for directory in dedup_paths(directories) {
        for extension in &extensions {
            let suffix = if platform == ProbePlatform::Windows
                && !candidate
                    .to_ascii_lowercase()
                    .ends_with(&extension.to_ascii_lowercase())
            {
                *extension
            } else {
                ""
            };
            let path = directory.join(format!("{candidate}{suffix}"));
            if let Ok(found) = verify_executable(&path, platform) {
                return Ok(found);
            }
        }
    }
    Err(ResolveError::NotFound(candidate.to_owned()))
}

/// Resolve a Windows npm Gemini shim without invoking cmd.exe or a shell.
pub fn resolve_gemini_launch(
    binary_path: &Path,
    environment: &Environment,
    platform: ProbePlatform,
) -> Result<GeminiLaunchCommand, ResolveError> {
    let binary_path = canonical_file(binary_path, platform)?;
    let extension = binary_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if platform != ProbePlatform::Windows || !matches_ignore_ascii_case(extension, &["cmd", "bat"])
    {
        if matches_ignore_ascii_case(extension, &["js", "mjs", "cjs"]) {
            return Ok(GeminiLaunchCommand {
                executable_path: resolve_executable_for("node", environment, platform)?,
                executable_args: vec![binary_path],
            });
        }
        return Ok(GeminiLaunchCommand {
            executable_path: binary_path,
            executable_args: Vec::new(),
        });
    }

    let package_root = binary_path
        .parent()
        .ok_or_else(|| ResolveError::InvalidShim("shim has no parent directory".into()))?
        .join("node_modules/@google/gemini-cli");
    let package_root = std::fs::canonicalize(&package_root).map_err(|_| {
        ResolveError::InvalidShim(
            "the selected Windows shim has no adjacent @google/gemini-cli installation".into(),
        )
    })?;
    let manifest: NpmManifest = serde_json::from_str(
        &std::fs::read_to_string(package_root.join("package.json")).map_err(|error| {
            ResolveError::InvalidShim(format!("cannot read package.json: {error}"))
        })?,
    )
    .map_err(|error| ResolveError::InvalidShim(format!("invalid package.json: {error}")))?;
    if manifest.name.as_deref() != Some("@google/gemini-cli") {
        return Err(ResolveError::InvalidShim(
            "package name is not @google/gemini-cli".into(),
        ));
    }
    let bin_entry = match manifest.bin {
        Some(NpmBin::String(entry)) => Some(entry),
        Some(NpmBin::Map(entries)) => entries.get("gemini").cloned(),
        None => None,
    }
    .ok_or_else(|| ResolveError::InvalidShim("package has no Gemini bin entry".into()))?;
    let entry_path = std::fs::canonicalize(package_root.join(&bin_entry))
        .map_err(|_| ResolveError::InvalidShim("Gemini bin entry does not exist".into()))?;
    if !entry_path.starts_with(&package_root) || !entry_path.is_file() {
        return Err(ResolveError::InvalidShim(
            "Gemini bin entry points outside its package".into(),
        ));
    }
    Ok(GeminiLaunchCommand {
        executable_path: resolve_executable_for("node", environment, platform)?,
        executable_args: vec![entry_path],
    })
}

pub fn parse_gemini_version(value: &str) -> Option<String> {
    find_version(value, false)
}

pub fn detect_gemini_cli_features(help: &str) -> GeminiCliFeatures {
    let has_flag = |flag: &str| {
        help.split(|character: char| character.is_whitespace() || matches!(character, ','))
            .any(|token| token == flag || token.starts_with(&format!("{flag}=")))
    };
    GeminiCliFeatures {
        acp: has_flag("--acp") || has_flag("--experimental-acp"),
        include_directories: has_flag("--include-directories"),
        resume: has_flag("--resume"),
        list_sessions: has_flag("--list-sessions"),
        delete_session: has_flag("--delete-session"),
        approval_mode: has_flag("--approval-mode"),
    }
}

pub async fn probe_gemini_binary(
    candidate: Option<&str>,
    environment: &Environment,
    timeout_duration: Option<Duration>,
) -> GeminiProbeResult {
    let candidate = candidate
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("gemini");
    let binary_path = match resolve_executable(candidate, environment) {
        Ok(path) => path,
        Err(error) => {
            return GeminiProbeResult::Err {
                candidate: candidate.to_owned(),
                code: if matches!(error, ResolveError::NotExecutable(_)) {
                    GeminiProbeErrorCode::BinaryNotExecutable
                } else {
                    GeminiProbeErrorCode::BinaryNotFound
                },
                message: error.to_string(),
            }
        }
    };
    let launch = match resolve_gemini_launch(&binary_path, environment, ProbePlatform::current()) {
        Ok(launch) => launch,
        Err(error) => {
            return GeminiProbeResult::Err {
                candidate: candidate.to_owned(),
                code: GeminiProbeErrorCode::BinaryProbeFailed,
                message: error.to_string(),
            }
        }
    };
    let timeout_duration = timeout_duration.unwrap_or(DEFAULT_TIMEOUT);
    let version_output =
        match run_captured_command(&launch, &["--version"], environment, timeout_duration).await {
            Ok(output) if output.exit_code == Some(0) && !output.timed_out => output,
            Ok(output) => return failed_probe(candidate, output.timed_out),
            Err(_error) => return failed_probe(candidate, false),
        };
    let raw_version = redact_diagnostic_text(
        format!("{}\n{}", version_output.stdout, version_output.stderr).trim(),
        &environment_secrets(environment),
    );
    let version = match parse_gemini_version(&raw_version) {
        Some(version) => version,
        None => return failed_probe(candidate, false),
    };
    let help_output =
        match run_captured_command(&launch, &["--help"], environment, timeout_duration).await {
            Ok(output) if output.exit_code == Some(0) && !output.timed_out => output,
            Ok(output) => return failed_probe(candidate, output.timed_out),
            Err(_error) => return failed_probe(candidate, false),
        };
    let features =
        detect_gemini_cli_features(&format!("{}\n{}", help_output.stdout, help_output.stderr));
    if !features.acp {
        return GeminiProbeResult::Err {
            candidate: candidate.to_owned(),
            code: GeminiProbeErrorCode::AcpUnsupported,
            message: format!("Gemini CLI {version} does not advertise the required --acp flag"),
        };
    }
    GeminiProbeResult::Ok(GeminiProbeSuccess {
        binary_path,
        executable_path: launch.executable_path,
        executable_args: launch.executable_args,
        version,
        raw_version,
        features,
    })
}

#[derive(Debug)]
struct CapturedOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

async fn run_captured_command(
    launch: &GeminiLaunchCommand,
    args: &[&str],
    environment: &Environment,
    timeout_duration: Duration,
) -> Result<CapturedOutput, String> {
    let mut command = Command::new(&launch.executable_path);
    command
        .args(&launch.executable_args)
        .args(args)
        .current_dir(std::env::temp_dir());
    command.envs(environment);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take().ok_or("stdout was not piped")?;
    let stderr = child.stderr.take().ok_or("stderr was not piped")?;
    let stdout_task = tokio::spawn(read_bounded(stdout, MAX_STDOUT_BYTES));
    let stderr_task = tokio::spawn(read_bounded(stderr, MAX_STDERR_BYTES));
    let status = match timeout(timeout_duration, child.wait()).await {
        Ok(result) => result.map_err(|error| error.to_string())?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Ok(CapturedOutput {
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: true,
            });
        }
    };
    let stdout = stdout_task.await.map_err(|error| error.to_string())?;
    let stderr = stderr_task.await.map_err(|error| error.to_string())?;
    Ok(CapturedOutput {
        exit_code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: redact_diagnostic_text(
            &String::from_utf8_lossy(&stderr),
            &environment_secrets(environment),
        ),
        timed_out: false,
    })
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

fn failed_probe(candidate: &str, timed_out: bool) -> GeminiProbeResult {
    GeminiProbeResult::Err {
        candidate: candidate.to_owned(),
        code: GeminiProbeErrorCode::BinaryProbeFailed,
        message: if timed_out {
            "Gemini CLI probe timed out"
        } else {
            "Gemini CLI probe failed"
        }
        .into(),
    }
}

fn find_version(value: &str, git: bool) -> Option<String> {
    let bytes = value.as_bytes();
    for start in 0..bytes.len() {
        let prefix = if git { "git version " } else { "" };
        if git && !value[start..].to_ascii_lowercase().starts_with(prefix) {
            continue;
        }
        let offset = start + prefix.len();
        let mut end = offset;
        let mut dots = 0;
        let mut prerelease = false;
        while end < bytes.len() {
            let byte = bytes[end];
            if byte.is_ascii_digit() || byte == b'.' {
                if byte == b'.' {
                    dots += 1;
                }
                end += 1;
            } else if !git && !prerelease && byte == b'-' {
                prerelease = true;
                end += 1;
            } else if !git
                && prerelease
                && (byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
            {
                end += 1;
            } else {
                break;
            }
        }
        if end > offset && dots >= 2 && bytes[offset].is_ascii_digit() {
            return Some(value[offset..end].to_owned());
        }
    }
    None
}

fn environment_secrets(environment: &Environment) -> Vec<String> {
    environment
        .iter()
        .filter_map(|(key, value)| {
            let upper = key.to_ascii_uppercase();
            (value.len() >= 6
                && [
                    "API_KEY",
                    "API-KEY",
                    "TOKEN",
                    "SECRET",
                    "PASSWORD",
                    "CREDENTIAL",
                ]
                .iter()
                .any(|part| upper.contains(part)))
            .then(|| value.clone())
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct NpmManifest {
    name: Option<String>,
    bin: Option<NpmBin>,
}
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum NpmBin {
    String(String),
    Map(HashMap<String, String>),
}

fn path_entries(environment: &Environment, platform: ProbePlatform) -> Vec<PathBuf> {
    let value = environment
        .get("PATH")
        .or_else(|| environment.get("Path"))
        .or_else(|| environment.get("path"));
    value
        .map(|value| {
            value
                .split(if platform == ProbePlatform::Windows {
                    ';'
                } else {
                    ':'
                })
                .filter(|entry| !entry.is_empty())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn path_entries_for_tests(
    environment: &Environment,
    platform: ProbePlatform,
) -> Vec<PathBuf> {
    path_entries(environment, platform)
}

fn default_executable_directories(
    environment: &Environment,
    platform: ProbePlatform,
) -> Vec<PathBuf> {
    match platform {
        ProbePlatform::Macos => vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ],
        ProbePlatform::Linux => {
            let mut paths = vec![PathBuf::from("/usr/local/bin")];
            if let Some(home) = environment.get("HOME") {
                paths.push(PathBuf::from(home).join(".local/bin"));
            }
            paths
        }
        ProbePlatform::Windows => {
            let mut paths = Vec::new();
            if let Some(appdata) = environment.get("APPDATA") {
                paths.push(PathBuf::from(appdata).join("npm"));
            }
            if let Some(program_files) = environment.get("ProgramFiles") {
                paths.push(PathBuf::from(program_files).join("nodejs"));
            }
            if let Some(local) = environment.get("LOCALAPPDATA") {
                paths.push(PathBuf::from(local).join("Programs/nodejs"));
            }
            paths
        }
        ProbePlatform::Other => Vec::new(),
    }
}

fn dedup_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for path in paths {
        if !result.iter().any(|existing| existing == &path) {
            result.push(path);
        }
    }
    result
}

fn has_path_separator(value: &str) -> bool {
    value.contains('/') || value.contains('\\')
}
fn is_absolute_for(value: &str, platform: ProbePlatform) -> bool {
    platform == ProbePlatform::Windows
        && (value.starts_with("\\\\") || value.as_bytes().get(1) == Some(&b':'))
        || Path::new(value).is_absolute()
}
fn absolute_path(value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}
fn matches_ignore_ascii_case(value: &str, choices: &[&str]) -> bool {
    choices
        .iter()
        .any(|choice| value.eq_ignore_ascii_case(choice))
}

fn canonical_file(path: &Path, platform: ProbePlatform) -> Result<PathBuf, ResolveError> {
    verify_executable(path, platform)
}
fn verify_executable(path: &Path, platform: ProbePlatform) -> Result<PathBuf, ResolveError> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| ResolveError::Io(path.to_owned(), error.to_string()))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| ResolveError::Io(canonical.clone(), error.to_string()))?;
    if !metadata.is_file() {
        return Err(ResolveError::NotFile(canonical));
    }
    #[cfg(unix)]
    if platform != ProbePlatform::Windows {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(ResolveError::NotExecutable(canonical));
        }
    }
    Ok(canonical)
}

pub(crate) fn verify_file_for_git(
    path: &Path,
    platform: ProbePlatform,
) -> Result<PathBuf, ResolveError> {
    verify_executable(path, platform)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn env(path: &Path) -> Environment {
        HashMap::from([(String::from("PATH"), path.to_string_lossy().into_owned())])
    }

    #[test]
    fn parses_preview_version_and_flags() {
        assert_eq!(
            parse_gemini_version("Gemini CLI 0.57.0-preview.2"),
            Some("0.57.0-preview.2".into())
        );
        let features = detect_gemini_cli_features("--experimental-acp\n--resume <id>");
        assert!(features.acp && features.resume);
    }

    #[test]
    fn resolves_path_and_windows_extensions() {
        let root = std::env::temp_dir().join(format!("geminui-probe-{}", std::process::id()));
        let _ = fs::create_dir_all(&root);
        let file = root.join("gemini.CMD");
        fs::write(&file, "shim").unwrap();
        let result = resolve_executable_for("gemini", &env(&root), ProbePlatform::Windows);
        assert_eq!(result.unwrap(), fs::canonicalize(file).unwrap());
        let _ = fs::remove_file(root.join("gemini.CMD"));
        let _ = fs::remove_dir(root);
    }
}
