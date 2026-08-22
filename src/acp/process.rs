use super::permission::PermissionBroker;
use super::rpc::{AcpRpcClient, RpcError, RpcInbound};
use crate::constants::{MAX_ADDITIONAL_ROOTS, MAX_ROOTS};
use crate::processes::BoundedTextBuffer;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone)]
pub struct AcpProcessConfig {
    pub binary: PathBuf,
    pub args: Vec<String>,
    pub primary_root: PathBuf,
    pub additional_roots: Vec<PathBuf>,
    pub environment: Vec<(String, String)>,
    pub max_protocol_line_bytes: usize,
    pub max_stderr_bytes: usize,
}

impl AcpProcessConfig {
    pub fn new(binary: impl Into<PathBuf>, primary_root: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            args: Vec::new(),
            primary_root: primary_root.into(),
            additional_roots: Vec::new(),
            environment: Vec::new(),
            max_protocol_line_bytes: 32 * 1024 * 1024,
            max_stderr_bytes: 64 * 1024,
        }
    }

    pub fn command_args(&self) -> Result<Vec<String>, ProcessError> {
        validate_roots(&self.primary_root, &self.additional_roots)?;
        let mut args = self.args.clone();
        if !args.iter().any(|arg| arg == "--acp") {
            args.push("--acp".into());
        }
        if !args.iter().any(|arg| arg == "--skip-trust") {
            args.push("--skip-trust".into());
        }
        for root in &self.additional_roots {
            args.push("--include-directories".into());
            args.push(root.to_string_lossy().into_owned());
        }
        Ok(args)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProcessError {
    #[error("ACP binary path is empty")]
    EmptyBinary,
    #[error("ACP root must be an absolute path: {0}")]
    RelativeRoot(String),
    #[error("ACP supports at most {MAX_ADDITIONAL_ROOTS} additional roots")]
    TooManyRoots,
    #[error("ACP roots must be unique: {0}")]
    DuplicateRoot(String),
    #[error("ACP process I/O failed: {0}")]
    Io(String),
    #[error("ACP transport is closed")]
    Closed,
    #[error("ACP process was already stopped")]
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelResult {
    Semantic,
    FallbackRequired,
}

enum Control {
    Kill(oneshot::Sender<Result<(), ProcessError>>),
}

/// One Gemini/ACP child.  The process control task owns `Child`, which keeps
/// cancellation and `wait()` race-free while the JSON-RPC reader runs beside it.
pub struct AcpProcess {
    rpc: AcpRpcClient,
    incoming: Option<mpsc::Receiver<RpcInbound>>,
    control: mpsc::Sender<Control>,
    exit: watch::Receiver<Option<ProcessExit>>,
    stderr: Arc<Mutex<BoundedTextBuffer>>,
    /// A prompt ends when its JSON-RPC response arrives.  Cancellation waits
    /// on this turn signal, never on child-process exit (ACP cancellation
    /// intentionally keeps the process alive for the next prompt).
    turns: Arc<Mutex<std::collections::HashMap<String, watch::Sender<Option<String>>>>>,
    pub permissions: PermissionBroker,
}

impl AcpProcess {
    pub async fn spawn(config: AcpProcessConfig) -> Result<Self, ProcessError> {
        if config.binary.as_os_str().is_empty() {
            return Err(ProcessError::EmptyBinary);
        }
        let args = config.command_args()?;
        let mut command = Command::new(&config.binary);
        command
            .args(args)
            .current_dir(&config.primary_root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("GEMINI_CLI_NO_RELAUNCH", "true");
        for (key, value) in &config.environment {
            command.env(key, value);
        }
        let mut child = command
            .spawn()
            .map_err(|error| ProcessError::Io(error.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ProcessError::Io("ACP stdin was not piped".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ProcessError::Io("ACP stdout was not piped".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ProcessError::Io("ACP stderr was not piped".into()))?;
        let (rpc, incoming) =
            AcpRpcClient::with_max_line_bytes(stdout, stdin, config.max_protocol_line_bytes);
        let permissions = PermissionBroker::default();
        let (control, mut control_rx) = mpsc::channel(4);
        let (exit_tx, exit_rx) = watch::channel(None);
        let rpc_for_exit = rpc.clone();
        let permissions_for_exit = permissions.clone();
        tokio::spawn(async move {
            let exit = run_child_control(&mut child, &mut control_rx).await;
            permissions_for_exit.close();
            rpc_for_exit.close(RpcError::Closed).await;
            let _ = exit_tx.send(Some(exit));
        });
        let stderr_buffer = Arc::new(Mutex::new(
            BoundedTextBuffer::new(config.max_stderr_bytes.max(1)).unwrap_or_default(),
        ));
        let turns = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let stderr_copy = Arc::clone(&stderr_buffer);
        tokio::spawn(async move {
            let mut reader = stderr;
            let mut chunk = [0_u8; 4096];
            loop {
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(size) => stderr_copy.lock().await.append(&chunk[..size]),
                }
            }
        });
        Ok(Self {
            rpc,
            incoming: Some(incoming),
            control,
            exit: exit_rx,
            stderr: stderr_buffer,
            turns,
            permissions,
        })
    }

    pub fn take_incoming(&mut self) -> Option<mpsc::Receiver<RpcInbound>> {
        self.incoming.take()
    }
    pub fn rpc(&self) -> &AcpRpcClient {
        &self.rpc
    }

    /// Completes ACP's mandatory handshake before any provider session is
    /// created.  The response is returned so callers can persist negotiated
    /// capabilities if they need them; protocolVersion is validated whenever
    /// the agent includes it.
    pub async fn initialize(&self) -> Result<serde_json::Value, ProcessError> {
        let response = self
            .rpc
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {},
                    "clientInfo": {
                        "name": "geminui",
                        "title": "GeminUI",
                        "version": "0.1.0"
                    }
                }),
            )
            .await
            .map_err(map_rpc_error)?;
        let version = response.get("protocolVersion").ok_or_else(|| {
            ProcessError::Io("ACP initialize response omitted protocolVersion".to_owned())
        })?;
        let valid = version.as_u64() == Some(1)
            || version.as_i64() == Some(1)
            || version.as_str() == Some("1");
        if !valid {
            return Err(ProcessError::Io(format!(
                "ACP protocol version mismatch: expected 1, got {version}"
            )));
        }
        Ok(response)
    }

    /// Sends an ACP request without exposing the process-control internals.
    /// Prompt requests are tracked so semantic cancellation can await the
    /// turn response while leaving the child process alive.
    pub async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ProcessError> {
        let session_id = (method == "session/prompt")
            .then(|| params.get("sessionId").and_then(serde_json::Value::as_str))
            .flatten()
            .map(ToOwned::to_owned);
        let receiver = if let Some(session_id) = session_id.as_ref() {
            let (sender, receiver) = watch::channel(None);
            self.turns.lock().await.insert(session_id.clone(), sender);
            Some((session_id.clone(), receiver))
        } else {
            None
        };
        let result = self
            .rpc
            .request(method, params)
            .await
            .map_err(map_rpc_error);
        if let Some((session_id, _)) = receiver {
            if let Some(sender) = self.turns.lock().await.remove(&session_id) {
                let stop_reason = result
                    .as_ref()
                    .ok()
                    .and_then(|value| value.get("stopReason"))
                    .and_then(serde_json::Value::as_str)
                    .map(ToOwned::to_owned);
                let _ = sender.send(stop_reason);
            }
        }
        result
    }

    pub async fn notify(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), ProcessError> {
        self.rpc.notify(method, params).await.map_err(map_rpc_error)
    }
    pub async fn stderr_snippet(&self) -> String {
        self.stderr.lock().await.to_string()
    }

    /// Sends ACP's semantic cancellation notification.  The caller decides
    /// when to use `terminate` as the controlled process fallback.
    pub async fn cancel(&self, session_id: &str) -> Result<CancelResult, ProcessError> {
        self.rpc
            .notify("session/cancel", json!({ "sessionId": session_id }))
            .await
            .map(|_| CancelResult::Semantic)
            .map_err(|error| match error {
                RpcError::Closed => ProcessError::Closed,
                other => ProcessError::Io(other.to_string()),
            })
    }

    /// Requests ACP cancellation first, then kills the child only if it does
    /// not report an exit during the grace period.  This is the controlled
    /// fallback used when a provider accepts the notification but gets stuck.
    pub async fn cancel_with_fallback(
        &self,
        session_id: &str,
        grace_period: Duration,
    ) -> Result<CancelResult, ProcessError> {
        let turn_receiver = self
            .turns
            .lock()
            .await
            .get(session_id)
            .map(watch::Sender::subscribe);
        if let Err(error) = self.cancel(session_id).await {
            let _ = self.terminate().await;
            return if matches!(error, ProcessError::Closed) {
                Ok(CancelResult::FallbackRequired)
            } else {
                Err(error)
            };
        }
        if let Some(mut turn_receiver) = turn_receiver {
            let cancelled = async {
                loop {
                    if turn_receiver.borrow().as_deref() == Some("cancelled") {
                        return true;
                    }
                    if turn_receiver.changed().await.is_err() {
                        return false;
                    }
                }
            };
            if !timeout(grace_period, cancelled).await.unwrap_or(false) {
                self.terminate().await?;
                return Ok(CancelResult::FallbackRequired);
            }
        }
        Ok(CancelResult::Semantic)
    }

    pub async fn terminate(&self) -> Result<(), ProcessError> {
        let (sender, receiver) = oneshot::channel();
        self.control
            .send(Control::Kill(sender))
            .await
            .map_err(|_| ProcessError::Stopped)?;
        receiver.await.map_err(|_| ProcessError::Stopped)??;
        Ok(())
    }

    pub async fn wait(&mut self) -> Option<ProcessExit> {
        if self.exit.borrow().is_some() {
            return self.exit.borrow().clone();
        }
        let _ = self.exit.changed().await;
        self.exit.borrow().clone()
    }
}

fn map_rpc_error(error: RpcError) -> ProcessError {
    match error {
        RpcError::Closed => ProcessError::Closed,
        other => ProcessError::Io(other.to_string()),
    }
}

async fn run_child_control(
    child: &mut Child,
    control: &mut mpsc::Receiver<Control>,
) -> ProcessExit {
    tokio::select! {
        result = child.wait() => result.map(|status| ProcessExit { code: status.code(), signal: process_signal(&status) }).unwrap_or(ProcessExit { code: None, signal: None }),
        command = control.recv() => {
            if let Some(Control::Kill(sender)) = command {
                let result = child.kill().await.map_err(|error| ProcessError::Io(error.to_string()));
                let _ = sender.send(result);
                child.wait().await.map(|status| ProcessExit { code: status.code(), signal: process_signal(&status) }).unwrap_or(ProcessExit { code: None, signal: None })
            } else {
                // Dropping the process handle closes the control channel; do
                // not leave an orphaned Gemini child behind in that case.
                let _ = child.kill().await;
                child.wait().await.map(|status| ProcessExit { code: status.code(), signal: process_signal(&status) }).unwrap_or(ProcessExit { code: None, signal: None })
            }
        }
    }
}

#[cfg(unix)]
fn process_signal(status: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.signal()
}

#[cfg(not(unix))]
fn process_signal(_status: &std::process::ExitStatus) -> Option<i32> {
    None
}

fn validate_roots(primary: &Path, additional: &[PathBuf]) -> Result<(), ProcessError> {
    if !primary.is_absolute() {
        return Err(ProcessError::RelativeRoot(
            primary.to_string_lossy().into_owned(),
        ));
    }
    if additional.len() > MAX_ADDITIONAL_ROOTS || additional.len() + 1 > MAX_ROOTS {
        return Err(ProcessError::TooManyRoots);
    }
    let mut roots = vec![primary.to_string_lossy().into_owned()];
    for root in additional {
        if !root.is_absolute() {
            return Err(ProcessError::RelativeRoot(
                root.to_string_lossy().into_owned(),
            ));
        }
        let root_string = root.to_string_lossy().into_owned();
        if roots.iter().any(|existing| existing == &root_string) {
            return Err(ProcessError::DuplicateRoot(root_string));
        }
        roots.push(root_string);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_acp_args_and_rejects_relative_or_duplicate_roots() {
        let mut config = AcpProcessConfig::new("gemini", "/tmp/project");
        config.args.push("--model=test".into());
        config.additional_roots.push("/tmp/other".into());
        let args = config.command_args().unwrap();
        assert_eq!(
            args,
            vec![
                "--model=test",
                "--acp",
                "--skip-trust",
                "--include-directories",
                "/tmp/other"
            ]
        );
        config.additional_roots.push("/tmp/project".into());
        assert!(matches!(
            config.command_args(),
            Err(ProcessError::DuplicateRoot(_))
        ));
    }

    #[tokio::test]
    async fn semantic_cancel_waits_for_turn_stop_without_killing_process() {
        let (client_io, mut agent_io) = tokio::io::duplex(4096);
        let (reader, writer) = tokio::io::split(client_io);
        let (rpc, _incoming) = super::super::rpc::AcpRpcClient::new(reader, writer);
        let (control, control_receiver) = mpsc::channel(1);
        drop(control_receiver);
        let (_exit_sender, exit) = watch::channel(None);
        let (turn_sender, _turn_receiver) = watch::channel(None);
        let turns = Arc::new(Mutex::new(std::collections::HashMap::new()));
        turns
            .lock()
            .await
            .insert("session".to_owned(), turn_sender.clone());
        let process = AcpProcess {
            rpc,
            incoming: None,
            control,
            exit,
            stderr: Arc::new(Mutex::new(BoundedTextBuffer::new(64).unwrap())),
            turns,
            permissions: PermissionBroker::default(),
        };
        let observed = tokio::spawn(async move {
            let mut bytes = Vec::new();
            let mut chunk = [0_u8; 256];
            loop {
                let count = agent_io.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.contains(&b'\n') {
                    break;
                }
            }
            let message: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(message["method"], "session/cancel");
            turn_sender.send(Some("cancelled".to_owned())).unwrap();
        });
        let result = process
            .cancel_with_fallback("session", Duration::from_millis(100))
            .await
            .unwrap();
        observed.await.unwrap();
        assert_eq!(result, CancelResult::Semantic);
    }

    #[tokio::test]
    async fn fake_acp_agent_runs_initialize_new_prompt_and_notification_pipeline() {
        let root = std::env::temp_dir().join(format!("geminui-acp-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("agent.py");
        let _ = std::fs::write(
            &script,
            r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get("method")
    request_id=request.get("id")
    if method == "initialize":
        result={"protocolVersion":1,"agentCapabilities":{"loadSession":True,"promptCapabilities":{"image":True},"models":["pro"],"modes":["code"]}}
    elif method == "session/new":
        result={"sessionId":"provider-session","models":["pro"],"modes":["code"]}
    elif method == "session/prompt":
        sys.stdout.write(json.dumps({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"provider-session","update":{"sessionUpdate":"agent_message_chunk","messageId":"m","content":{"type":"text","text":"hello"}}}})+"\n")
        sys.stdout.flush()
        result={"stopReason":"end_turn"}
    else:
        result={}
    if request_id is not None:
        sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":request_id,"result":result})+"\n")
        sys.stdout.flush()
"#,
        );
        let python = std::env::var("PYTHON").unwrap_or_else(|_| "python3".to_owned());
        if std::process::Command::new(&python)
            .arg("--version")
            .status()
            .is_err()
        {
            let _ = std::fs::remove_dir_all(root);
            return;
        }
        let mut config = AcpProcessConfig::new(python, &root);
        config.args = vec![script.to_string_lossy().into_owned()];
        let mut process = AcpProcess::spawn(config).await.unwrap();
        let mut incoming = process.take_incoming().unwrap();
        let initialize = process.initialize().await.unwrap();
        assert_eq!(initialize["protocolVersion"], 1);
        let created = process
            .request("session/new", json!({"cwd":root,"mcpServers":[]}))
            .await
            .unwrap();
        assert_eq!(created["sessionId"], "provider-session");
        let prompt = process
            .request(
                "session/prompt",
                json!({"sessionId":"provider-session","prompt":[]}),
            )
            .await
            .unwrap();
        assert_eq!(prompt["stopReason"], "end_turn");
        let notification = timeout(Duration::from_secs(1), async {
            loop {
                if let Some(RpcInbound::Notification(notification)) = incoming.recv().await {
                    if notification.method == "session/update" {
                        break notification;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(notification.method, "session/update");
        process.terminate().await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
}
