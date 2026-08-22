//! Bounded, non-interactive Git command execution.
//!
//! Git is treated as an optional helper process.  Every invocation inherits
//! the current environment but disables pagers and terminal prompts.  Output
//! is collected only up to an explicit byte limit; a command that exceeds the
//! limit is killed and never exposed as a partial result.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::Notify;

pub const GIT_STATUS_OUTPUT_LIMIT: usize = 10 * 1024 * 1024;
pub const GIT_DIFF_OUTPUT_LIMIT: usize = 5 * 1024 * 1024;
pub const GIT_STDERR_LIMIT: usize = 256 * 1024;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GitCommandResult {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    pub aborted: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone)]
pub struct GitCommandInput<'a> {
    pub binary_path: &'a Path,
    pub args: &'a [&'a str],
    pub cwd: Option<&'a Path>,
    pub timeout: Duration,
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
    pub stdin: Option<Vec<u8>>,
    /// A caller can cancel an invocation without depending on a particular
    /// async cancellation-token crate.  Set this flag before polling.
    pub aborted: Option<Arc<std::sync::atomic::AtomicBool>>,
    pub read_only: bool,
}

impl<'a> GitCommandInput<'a> {
    pub fn new(binary_path: &'a Path, args: &'a [&'a str]) -> Self {
        Self {
            binary_path,
            args,
            cwd: None,
            timeout: Duration::from_secs(10),
            max_stdout_bytes: GIT_STATUS_OUTPUT_LIMIT,
            max_stderr_bytes: GIT_STDERR_LIMIT,
            stdin: None,
            aborted: None,
            read_only: false,
        }
    }
}

/// Execute one Git process with bounded stdout/stderr and a hard timeout.
pub async fn run_git_command(input: GitCommandInput<'_>) -> std::io::Result<GitCommandResult> {
    let mut command = Command::new(input.binary_path);
    command.args(input.args);
    if let Some(cwd) = input.cwd {
        command.current_dir(cwd);
    }
    command
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0");
    if input.read_only {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    command.stdin(if input.stdin.is_some() {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    });
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let mut child = command.spawn()?;
    if let (Some(mut stdin), Some(bytes)) = (child.stdin.take(), input.stdin) {
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(&bytes).await;
            let _ = stdin.shutdown().await;
        });
    }

    let stdout = child.stdout.take().expect("stdout pipe configured");
    let stderr = child.stderr.take().expect("stderr pipe configured");
    let overflow = Arc::new(Notify::new());
    let stdout_overflow = Arc::clone(&overflow);
    let stderr_overflow = Arc::clone(&overflow);
    let stdout_task = tokio::spawn(read_bounded(
        stdout,
        input.max_stdout_bytes,
        stdout_overflow,
    ));
    let stderr_task = tokio::spawn(read_bounded(
        stderr,
        input.max_stderr_bytes,
        stderr_overflow,
    ));

    let mut timed_out = false;
    let mut aborted = input
        .aborted
        .as_ref()
        .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed));
    let status = if aborted {
        let _ = child.kill().await;
        None
    } else {
        let abort_flag = input.aborted.clone();
        let abort_poll = async move {
            loop {
                if abort_flag
                    .as_ref()
                    .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
                {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        };
        tokio::pin!(abort_poll);
        let mut status = None;
        let deadline = tokio::time::Instant::now() + input.timeout;
        loop {
            if let Some(result) = child.try_wait()? {
                status = Some(result);
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                timed_out = true;
                let _ = child.kill().await;
                break;
            }
            tokio::select! {
                _ = overflow.notified() => { let _ = child.kill().await; break; },
                _ = &mut abort_poll => { aborted = true; let _ = child.kill().await; break; },
                _ = tokio::time::sleep(Duration::from_millis(20)) => {},
            }
        }
        status
    };

    // The process is killed in all non-normal branches.  Waiting after kill
    // closes pipes and avoids leaving a child around on Unix and Windows.
    let status = match status {
        Some(status) => Some(status),
        None => child.wait().await.ok(),
    };
    let stdout = stdout_task.await.unwrap_or_else(|_| ReadBounded::default());
    let stderr = stderr_task.await.unwrap_or_else(|_| ReadBounded::default());
    let too_large = stdout.too_large || stderr.too_large;
    Ok(GitCommandResult {
        exit_code: status.as_ref().and_then(std::process::ExitStatus::code),
        signal: status.as_ref().and_then(signal_number),
        stdout: if too_large { Vec::new() } else { stdout.bytes },
        stderr: if too_large { Vec::new() } else { stderr.bytes },
        timed_out,
        aborted,
        too_large,
    })
}

#[derive(Default)]
struct ReadBounded {
    bytes: Vec<u8>,
    too_large: bool,
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
    overflow: Arc<Notify>,
) -> ReadBounded {
    let mut output = ReadBounded::default();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(count) => {
                if output.bytes.len().saturating_add(count) > limit {
                    output.bytes.clear();
                    output.too_large = true;
                    overflow.notify_one();
                    break;
                }
                output.bytes.extend_from_slice(&buffer[..count]);
            }
            Err(_) => break,
        }
    }
    output
}

#[cfg(unix)]
fn signal_number(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn signal_number(_: &std::process::ExitStatus) -> Option<i32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn fails_closed_when_stdout_exceeds_limit() {
        let binary = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
        let args: &[&str] = if cfg!(windows) {
            &["/C", "echo x"]
        } else {
            &["-c", "printf xxxxxxxxxxxxxxxxxxxx"]
        };
        let mut input = GitCommandInput::new(Path::new(binary), args);
        input.max_stdout_bytes = 4;
        let result = run_git_command(input).await.unwrap();
        assert!(result.too_large);
        assert!(result.stdout.is_empty());
    }

    #[test]
    fn builder_has_safe_defaults() {
        let path = PathBuf::from("git");
        let input = GitCommandInput::new(&path, &[]);
        assert!(!input.read_only);
        assert_eq!(input.max_stderr_bytes, GIT_STDERR_LIMIT);
    }
}
