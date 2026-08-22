//! Ownership and lifecycle for the ACP processes used by sessions.
//! Restored from the isolated sessions build snapshot.
//!
//! The manager intentionally owns transports, not persisted session records.
//! Persistence, prompts and event delivery can be layered on top of this
//! module without making the process limit or shutdown semantics implicit.

use super::permission::{PermissionBroker, PermissionError};
use super::process::{AcpProcess, AcpProcessConfig, CancelResult, ProcessError};
use super::rpc::{AcpRpcClient, RpcInbound, RpcRequest, RpcResponseError};
use crate::constants::MAX_ACTIVE_SESSIONS;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

/// The boxed future used by process adapters.  Keeping this trait free of
/// `async_trait` makes fake handles small and keeps this module dependency
/// free of a proc-macro just for tests.
pub type ProcessFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A process owned by one active session.
///
/// Implementations must perform semantic ACP cancellation before returning
/// `CancelResult::FallbackRequired`; `terminate` is the final, controlled
/// process fallback.  A fake implementation can therefore model both paths
/// without starting a real Gemini executable.
pub trait ProcessHandle: Send + Sync {
    fn permissions(&self) -> PermissionBroker;

    /// Performs ACP's mandatory initialize handshake.  The default is only
    /// for lifecycle-only test adapters; the production adapter delegates to
    /// [`AcpProcess::initialize`].
    fn initialize<'a>(&'a self) -> ProcessFuture<'a, Result<Value, ProcessError>> {
        Box::pin(async { Ok(Value::Null) })
    }

    fn stderr_snippet<'a>(&'a self) -> ProcessFuture<'a, String> {
        Box::pin(async { String::new() })
    }

    /// Subscribes to provider notifications and server requests.  The
    /// production adapter consumes the single ACP inbound stream once and
    /// fans it out, so permission routing and event delivery never race over
    /// the same receiver.
    fn subscribe_incoming(&self) -> Option<broadcast::Receiver<RpcInbound>> {
        None
    }

    /// Sends an ACP request through the process-owned JSON-RPC transport.
    /// Fakes that only exercise lifecycle semantics may use the default,
    /// unsupported implementation.
    fn request<'a>(
        &'a self,
        _method: &'a str,
        _params: Value,
    ) -> ProcessFuture<'a, Result<Value, ProcessError>> {
        Box::pin(async {
            Err(ProcessError::Io(
                "ACP request transport is not available".to_owned(),
            ))
        })
    }

    fn notify<'a>(
        &'a self,
        _method: &'a str,
        _params: Value,
    ) -> ProcessFuture<'a, Result<(), ProcessError>> {
        Box::pin(async {
            Err(ProcessError::Io(
                "ACP notification transport is not available".to_owned(),
            ))
        })
    }

    fn cancel_with_fallback<'a>(
        &'a self,
        session_id: &'a str,
        grace_period: Duration,
    ) -> ProcessFuture<'a, Result<CancelResult, ProcessError>>;

    fn terminate<'a>(&'a self) -> ProcessFuture<'a, Result<(), ProcessError>>;
}

/// Factory used by [`SessionManager`] to create a process for a session.
/// Production uses [`AcpProcessFactory`], while unit tests can inject a
/// deterministic fake factory.
pub trait ProcessFactory: Send + Sync {
    fn spawn<'a>(
        &'a self,
        session_id: &'a str,
        config: AcpProcessConfig,
    ) -> ProcessFuture<'a, Result<Arc<dyn ProcessHandle>, ProcessError>>;
}

/// The production adapter around [`AcpProcess`].
pub struct AcpProcessHandle {
    // AcpProcess's RPC client and cancellation state are internally shared;
    // no mutex may surround an entire request future or cancellation would
    // block behind a long-running prompt.
    process: Arc<AcpProcess>,
    permissions: PermissionBroker,
    incoming: broadcast::Sender<RpcInbound>,
}

impl AcpProcessHandle {
    pub fn new(mut process: AcpProcess) -> Self {
        let permissions = process.permissions.clone();
        let rpc = process.rpc().clone();
        let (incoming, _) = broadcast::channel(128);
        if let Some(mut receiver) = process.take_incoming() {
            let fanout = incoming.clone();
            let broker = permissions.clone();
            tokio::spawn(async move {
                while let Some(message) = receiver.recv().await {
                    let _ = fanout.send(message.clone());
                    if let RpcInbound::Request(request) = message {
                        if request.method == "session/request_permission" {
                            let rpc = rpc.clone();
                            let broker = broker.clone();
                            tokio::spawn(async move {
                                route_permission_request(&rpc, &broker, request).await;
                            });
                        }
                    }
                }
            });
        }
        Self {
            process: Arc::new(process),
            permissions,
            incoming,
        }
    }
}

impl ProcessHandle for AcpProcessHandle {
    fn permissions(&self) -> PermissionBroker {
        self.permissions.clone()
    }

    fn initialize<'a>(&'a self) -> ProcessFuture<'a, Result<Value, ProcessError>> {
        Box::pin(async move { self.process.initialize().await })
    }

    fn stderr_snippet<'a>(&'a self) -> ProcessFuture<'a, String> {
        Box::pin(async move { self.process.stderr_snippet().await })
    }

    fn subscribe_incoming(&self) -> Option<broadcast::Receiver<RpcInbound>> {
        Some(self.incoming.subscribe())
    }

    fn cancel_with_fallback<'a>(
        &'a self,
        session_id: &'a str,
        grace_period: Duration,
    ) -> ProcessFuture<'a, Result<CancelResult, ProcessError>> {
        let process = Arc::clone(&self.process);
        Box::pin(async move { process.cancel_with_fallback(session_id, grace_period).await })
    }

    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> ProcessFuture<'a, Result<Value, ProcessError>> {
        let process = Arc::clone(&self.process);
        Box::pin(async move { process.request(method, params).await })
    }

    fn notify<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> ProcessFuture<'a, Result<(), ProcessError>> {
        let process = Arc::clone(&self.process);
        Box::pin(async move { process.notify(method, params).await })
    }

    fn terminate<'a>(&'a self) -> ProcessFuture<'a, Result<(), ProcessError>> {
        let process = Arc::clone(&self.process);
        Box::pin(async move { process.terminate().await })
    }
}

async fn route_permission_request(
    rpc: &AcpRpcClient,
    broker: &PermissionBroker,
    request: RpcRequest,
) {
    let permission_id = match request.id.as_str() {
        Some(id) if !id.trim().is_empty() => id.to_owned(),
        None if request.id.is_number() => request.id.to_string(),
        _ => {
            let _ = rpc
                .respond(
                    request.id,
                    Err(RpcResponseError {
                        code: -32600,
                        message: "permission request id must be a string or number".to_owned(),
                        data: None,
                    }),
                )
                .await;
            return;
        }
    };
    let params = request.params;
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let tool_call = params.get("toolCall").cloned().unwrap_or_else(|| {
        serde_json::json!({
            "toolCallId": params.get("toolCallId").and_then(Value::as_str),
            "title": params.get("title").and_then(Value::as_str)
        })
    });
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|option| {
                    let option_id = option
                        .get("optionId")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| "permission optionId is missing".to_owned())?;
                    let name = option
                        .get("name")
                        .or_else(|| option.get("label"))
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| "permission option name is missing".to_owned())?;
                    Ok(super::permission::PermissionOption {
                        option_id: option_id.to_owned(),
                        name: name.to_owned(),
                        kind: option
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    })
                })
                .collect::<Result<Vec<_>, String>>()
        });
    let result = match (session_id, options) {
        (Some(session_id), Some(Ok(options))) if !options.is_empty() => broker
            .request_with_id(permission_id, session_id.to_owned(), tool_call, options)
            .map(|(_, waiter)| waiter),
        (_, Some(Err(_message))) => Err(PermissionError::NotPending),
        _ => Err(PermissionError::NotPending),
    };
    match result {
        Ok(waiter) => match waiter.await {
            Ok(resolution) => {
                let result = match resolution.outcome {
                    super::permission::PermissionOutcome::Selected { option_id } => {
                        serde_json::json!({
                            "outcome": { "outcome": "selected", "optionId": option_id }
                        })
                    }
                    super::permission::PermissionOutcome::Cancelled => {
                        serde_json::json!({ "outcome": { "outcome": "cancelled" } })
                    }
                };
                let _ = rpc.respond(request.id, Ok(result)).await;
            }
            Err(_) => {
                let _ = rpc
                    .respond(
                        request.id,
                        Err(RpcResponseError {
                            code: -32000,
                            message: "permission broker closed".to_owned(),
                            data: None,
                        }),
                    )
                    .await;
            }
        },
        Err(_) => {
            let _ = rpc
                .respond(
                    request.id,
                    Err(RpcResponseError {
                        code: -32602,
                        message: "invalid ACP permission request".to_owned(),
                        data: None,
                    }),
                )
                .await;
        }
    }
}

/// Default process factory used by application wiring.
#[derive(Debug, Default, Clone, Copy)]
pub struct AcpProcessFactory;

impl ProcessFactory for AcpProcessFactory {
    fn spawn<'a>(
        &'a self,
        _session_id: &'a str,
        config: AcpProcessConfig,
    ) -> ProcessFuture<'a, Result<Arc<dyn ProcessHandle>, ProcessError>> {
        Box::pin(async move {
            let process = AcpProcess::spawn(config).await?;
            Ok(Arc::new(AcpProcessHandle::new(process)) as Arc<dyn ProcessHandle>)
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// The process factory is starting the ACP child.
    Starting,
    /// The process is ready for a turn.
    Idle,
    /// A prompt/turn is currently being handled by the process.
    Running,
    /// The provider is waiting for a renderer permission decision.
    AwaitingPermission,
    /// Semantic cancellation has been requested.
    Cancelling,
    /// Close has begun and no new work may start.
    Closing,
}

/// A lock-free-to-consume description of one manager-owned session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub id: String,
    pub status: SessionStatus,
    pub pending_permissions: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("session id must not be empty")]
    EmptyId,
    #[error("session {0} already owns an ACP process")]
    AlreadyActive(String),
    #[error("the maximum of {MAX_ACTIVE_SESSIONS} active ACP sessions is reached")]
    Capacity,
    #[error("session {0} is not active")]
    NotFound(String),
    #[error("session manager is disposed")]
    Disposed,
    #[error("session {0} is closing")]
    Closing(String),
    #[error("invalid lifecycle transition for session {session_id}: {from:?} -> {to:?}")]
    InvalidTransition {
        session_id: String,
        from: SessionStatus,
        to: SessionStatus,
    },
    #[error("ACP process failed: {0}")]
    Process(#[from] ProcessError),
    #[error("permission request failed: {0}")]
    Permission(#[from] PermissionError),
}

struct ManagedSession {
    status: SessionStatus,
    process: Option<Arc<dyn ProcessHandle>>,
    initialize_response: Option<Value>,
    opened_sequence: u64,
}

struct ManagerState {
    disposed: bool,
    sessions: HashMap<String, ManagedSession>,
    next_sequence: u64,
}

/// Owns at most [`MAX_ACTIVE_SESSIONS`] ACP processes.
pub struct SessionManager {
    factory: Arc<dyn ProcessFactory>,
    state: Mutex<ManagerState>,
    cancel_grace_period: Duration,
    initialize_timeout: Duration,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub const DEFAULT_CANCEL_GRACE_PERIOD: Duration = Duration::from_secs(1);

    pub fn new() -> Self {
        Self::with_factory(Arc::new(AcpProcessFactory))
    }

    pub fn with_factory(factory: Arc<dyn ProcessFactory>) -> Self {
        Self {
            factory,
            state: Mutex::new(ManagerState {
                disposed: false,
                sessions: HashMap::new(),
                next_sequence: 0,
            }),
            cancel_grace_period: Self::DEFAULT_CANCEL_GRACE_PERIOD,
            initialize_timeout: Duration::from_secs(2),
        }
    }

    pub fn with_cancel_grace_period(mut self, grace_period: Duration) -> Self {
        self.cancel_grace_period = grace_period;
        self
    }

    pub fn with_initialize_timeout(mut self, initialize_timeout: Duration) -> Self {
        self.initialize_timeout = initialize_timeout;
        self
    }

    /// Opens a caller-owned, unique session ID.
    pub async fn open(
        &self,
        session_id: impl Into<String>,
        config: AcpProcessConfig,
    ) -> Result<SessionSnapshot, SessionError> {
        let session_id = session_id.into();
        if session_id.trim().is_empty() {
            return Err(SessionError::EmptyId);
        }

        {
            let mut state = self.state.lock().await;
            if state.disposed {
                return Err(SessionError::Disposed);
            }
            if state.sessions.contains_key(&session_id) {
                return Err(SessionError::AlreadyActive(session_id));
            }
            if state.sessions.len() >= MAX_ACTIVE_SESSIONS {
                return Err(SessionError::Capacity);
            }
            state.next_sequence = state.next_sequence.saturating_add(1);
            let opened_sequence = state.next_sequence;
            state.sessions.insert(
                session_id.clone(),
                ManagedSession {
                    status: SessionStatus::Starting,
                    process: None,
                    initialize_response: None,
                    opened_sequence,
                },
            );
        }

        // Do not hold the manager mutex while a process starts.  This also
        // allows an unrelated session to close while a slow child initializes.
        let process = match self.factory.spawn(&session_id, config).await {
            Ok(process) => process,
            Err(error) => {
                self.state.lock().await.sessions.remove(&session_id);
                return Err(SessionError::Process(error));
            }
        };

        // ACP requires initialize before session/new, session/load, or a
        // prompt.  Perform it while the session is still Starting; a failed
        // handshake must never leave a half-live process in the manager.
        let initialize = match timeout(self.initialize_timeout, process.initialize()).await {
            Ok(result) => result,
            Err(_) => Err(ProcessError::Io("ACP initialize timed out".to_owned())),
        };
        let initialize_response = match initialize {
            Ok(response) => response,
            Err(mut error) => {
                let stderr = process.stderr_snippet().await;
                if !stderr.trim().is_empty() {
                    error = ProcessError::Io(stderr);
                }
                process.permissions().close();
                let _ = process.terminate().await;
                self.state.lock().await.sessions.remove(&session_id);
                return Err(SessionError::Process(error));
            }
        };

        let should_close = {
            let mut state = self.state.lock().await;
            match state.sessions.get_mut(&session_id) {
                Some(session) if session.status == SessionStatus::Starting => {
                    session.process = Some(Arc::clone(&process));
                    // The handshake response is needed by the session layer
                    // for capability gating and picker cache persistence.
                    // It is cloned before the temporary result is dropped.
                    session.initialize_response = Some(initialize_response.clone());
                    session.status = SessionStatus::Idle;
                    false
                }
                Some(session) => {
                    session.process = Some(Arc::clone(&process));
                    session.initialize_response = Some(initialize_response.clone());
                    true
                }
                None => true,
            }
        };
        if should_close {
            let permissions = process.permissions();
            permissions.close();
            let termination = process.terminate().await;
            self.state.lock().await.sessions.remove(&session_id);
            termination?;
            return Err(SessionError::Closing(session_id));
        }
        self.snapshot(&session_id)
            .await
            .ok_or(SessionError::NotFound(session_id))
    }

    /// Opens a session after evicting one idle process when the hard capacity
    /// is reached.  Running, cancelling and permission-waiting sessions are
    /// never stopped implicitly.  This is the native equivalent of the former
    /// controller's `makeRoomForSession` rule.
    pub async fn open_with_eviction(
        &self,
        session_id: impl Into<String>,
        config: AcpProcessConfig,
    ) -> Result<SessionSnapshot, SessionError> {
        let session_id = session_id.into();
        if self.active_count().await >= MAX_ACTIVE_SESSIONS {
            let victim = {
                let state = self.state.lock().await;
                state
                    .sessions
                    .iter()
                    .filter_map(|(id, session)| {
                        (id != &session_id
                            && session.status == SessionStatus::Idle
                            && session
                                .process
                                .as_ref()
                                .map_or(true, |process| process.permissions().pending_count() == 0))
                        .then_some((id.clone(), session.opened_sequence))
                    })
                    .min_by_key(|(_, opened_sequence)| *opened_sequence)
                    .map(|(id, _)| id)
            };
            let Some(victim) = victim else {
                return Err(SessionError::Capacity);
            };
            self.close(&victim).await?;
        }
        self.open(session_id, config).await
    }

    /// Opens a session with a fresh UUID and returns the generated ID in its
    /// snapshot.  Persistence can store that ID after this succeeds.
    pub async fn create(&self, config: AcpProcessConfig) -> Result<SessionSnapshot, SessionError> {
        self.open(Uuid::new_v4().to_string(), config).await
    }

    pub async fn snapshot(&self, session_id: &str) -> Option<SessionSnapshot> {
        let state = self.state.lock().await;
        state
            .sessions
            .get(session_id)
            .map(|session| SessionSnapshot {
                id: session_id.to_owned(),
                status: visible_status(session),
                pending_permissions: session
                    .process
                    .as_ref()
                    .map(|process| process.permissions().pending_count())
                    .unwrap_or(0),
            })
    }

    pub async fn snapshots(&self) -> Vec<SessionSnapshot> {
        let state = self.state.lock().await;
        let mut snapshots: Vec<SessionSnapshot> = state
            .sessions
            .iter()
            .map(|(id, session)| SessionSnapshot {
                id: id.clone(),
                status: visible_status(session),
                pending_permissions: session
                    .process
                    .as_ref()
                    .map(|process| process.permissions().pending_count())
                    .unwrap_or(0),
            })
            .collect();
        snapshots.sort_by(|left, right| left.id.cmp(&right.id));
        snapshots
    }

    pub async fn active_count(&self) -> usize {
        self.state.lock().await.sessions.len()
    }

    pub async fn initialize_response(&self, session_id: &str) -> Option<Value> {
        self.state
            .lock()
            .await
            .sessions
            .get(session_id)
            .and_then(|session| session.initialize_response.clone())
    }

    pub async fn permissions(&self, session_id: &str) -> Result<PermissionBroker, SessionError> {
        let state = self.state.lock().await;
        state
            .sessions
            .get(session_id)
            .and_then(|session| session.process.as_ref())
            .map(|process| process.permissions())
            .ok_or_else(|| SessionError::NotFound(session_id.to_owned()))
    }

    /// Returns a fan-out subscription to the process's ordered inbound ACP
    /// stream.  The production handle owns the mpsc receiver and routes
    /// permission requests before publishing them; consumers can therefore
    /// persist normalized notifications without stealing responses from the
    /// JSON-RPC correlator.
    pub async fn subscribe_incoming(
        &self,
        session_id: &str,
    ) -> Result<Option<broadcast::Receiver<RpcInbound>>, SessionError> {
        let state = self.state.lock().await;
        state
            .sessions
            .get(session_id)
            .and_then(|session| session.process.as_ref())
            .map(|process| process.subscribe_incoming())
            .ok_or_else(|| SessionError::NotFound(session_id.to_owned()))
    }

    pub async fn resolve_permission(
        &self,
        session_id: &str,
        permission_id: &str,
        option_id: &str,
    ) -> Result<(), SessionError> {
        self.permissions(session_id)
            .await?
            .resolve(permission_id, option_id)?;
        Ok(())
    }

    /// Sends `session/prompt` and exposes the raw, provider-neutral response.
    /// Usage parsing belongs to `acp::usage`; this method deliberately does
    /// not discard `_meta.quota` before the parser sees it.
    pub async fn prompt(&self, session_id: &str, prompt: Value) -> Result<Value, SessionError> {
        let process = self.process(session_id).await?;
        self.set_status(session_id, SessionStatus::Running).await?;
        let result = process
            .request(
                "session/prompt",
                serde_json::json!({ "sessionId": session_id, "prompt": prompt }),
            )
            .await;
        match result {
            Ok(value) => {
                self.finish_turn_if_present(session_id).await;
                Ok(value)
            }
            Err(error) => {
                self.finish_turn_if_present(session_id).await;
                Err(SessionError::Process(error))
            }
        }
    }

    /// Performs ACP `session/new` on an already spawned process.  Keeping
    /// process spawn and provider-session creation separate allows the caller
    /// to persist the app session before the provider assigns its ID.
    pub async fn session_new(&self, session_id: &str, cwd: &str) -> Result<Value, SessionError> {
        self.request_provider_session(
            session_id,
            "session/new",
            serde_json::json!({ "cwd": cwd, "mcpServers": [] }),
        )
        .await
    }

    /// Performs ACP `session/load` for provider history recovery.
    pub async fn session_load(
        &self,
        session_id: &str,
        provider_session_id: &str,
        cwd: &str,
    ) -> Result<Value, SessionError> {
        self.request_provider_session(
            session_id,
            "session/load",
            serde_json::json!({ "cwd": cwd, "mcpServers": [], "sessionId": provider_session_id }),
        )
        .await
    }

    async fn request_provider_session(
        &self,
        session_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, SessionError> {
        let process = self.process(session_id).await?;
        process
            .request(method, params)
            .await
            .map_err(SessionError::Process)
    }

    pub async fn set_mode(&self, session_id: &str, mode_id: &str) -> Result<Value, SessionError> {
        self.request_session_option(
            session_id,
            "session/set_mode",
            serde_json::json!({ "modeId": mode_id }),
        )
        .await
    }

    pub async fn set_model(&self, session_id: &str, model_id: &str) -> Result<Value, SessionError> {
        self.request_session_option(
            session_id,
            "session/set_model",
            serde_json::json!({ "modelId": model_id }),
        )
        .await
    }

    pub async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<Value, SessionError> {
        self.request_session_option(
            session_id,
            "session/set_config_option",
            serde_json::json!({ "configId": config_id, "value": value }),
        )
        .await
    }

    async fn request_session_option(
        &self,
        session_id: &str,
        method: &str,
        option: Value,
    ) -> Result<Value, SessionError> {
        let process = self.process(session_id).await?;
        let mut params = option;
        if let Some(object) = params.as_object_mut() {
            object.insert("sessionId".to_owned(), Value::String(session_id.to_owned()));
        }
        process
            .request(method, params)
            .await
            .map_err(SessionError::Process)
    }

    async fn process(&self, session_id: &str) -> Result<Arc<dyn ProcessHandle>, SessionError> {
        let state = self.state.lock().await;
        state
            .sessions
            .get(session_id)
            .and_then(|session| session.process.as_ref())
            .map(Arc::clone)
            .ok_or_else(|| SessionError::NotFound(session_id.to_owned()))
    }

    /// Marks a ready session as running.  Prompt orchestration owns the actual
    /// ACP request; this method only makes its lifecycle visible in snapshots.
    pub async fn begin_turn(&self, session_id: &str) -> Result<(), SessionError> {
        self.set_status(session_id, SessionStatus::Running).await
    }

    pub async fn finish_turn(&self, session_id: &str) -> Result<(), SessionError> {
        self.set_status(session_id, SessionStatus::Idle).await
    }

    pub async fn set_status(
        &self,
        session_id: &str,
        status: SessionStatus,
    ) -> Result<(), SessionError> {
        let mut state = self.state.lock().await;
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| SessionError::NotFound(session_id.to_owned()))?;
        if session.status == SessionStatus::Closing {
            return Err(SessionError::Closing(session_id.to_owned()));
        }
        let valid = matches!(
            (session.status, status),
            (SessionStatus::Idle, SessionStatus::Running)
                | (SessionStatus::Idle, SessionStatus::AwaitingPermission)
                | (SessionStatus::Running, SessionStatus::Idle)
                | (SessionStatus::Running, SessionStatus::AwaitingPermission)
                | (SessionStatus::AwaitingPermission, SessionStatus::Idle)
                | (SessionStatus::AwaitingPermission, SessionStatus::Running)
                | (SessionStatus::Cancelling, SessionStatus::Idle)
        );
        if !valid {
            return Err(SessionError::InvalidTransition {
                session_id: session_id.to_owned(),
                from: session.status,
                to: status,
            });
        }
        session.status = status;
        Ok(())
    }

    /// Requests semantic ACP cancellation.  The underlying process performs
    /// the terminate fallback if the provider does not exit during grace.
    pub async fn cancel(&self, session_id: &str) -> Result<CancelResult, SessionError> {
        let process = {
            let mut state = self.state.lock().await;
            let session = state
                .sessions
                .get_mut(session_id)
                .ok_or_else(|| SessionError::NotFound(session_id.to_owned()))?;
            if session.status == SessionStatus::Closing {
                return Err(SessionError::Closing(session_id.to_owned()));
            }
            session.status = SessionStatus::Cancelling;
            session
                .process
                .as_ref()
                .map(Arc::clone)
                .ok_or_else(|| SessionError::Closing(session_id.to_owned()))?
        };

        // Cancel permission oneshots before waiting for the provider's
        // cancelled prompt response.  This unblocks the ACP server request
        // immediately and prevents a stale renderer decision racing a new
        // turn after cancellation.
        let _ = process.permissions().cancel_session(session_id);

        let result = process
            .cancel_with_fallback(session_id, self.cancel_grace_period)
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                let _ = process.terminate().await;
                self.restore_idle_if_present(session_id).await;
                return Err(SessionError::Process(error));
            }
        };
        self.restore_idle_if_present(session_id).await;
        Ok(result)
    }

    async fn restore_idle_if_present(&self, session_id: &str) {
        let mut state = self.state.lock().await;
        if let Some(session) = state.sessions.get_mut(session_id) {
            if session.status == SessionStatus::Cancelling {
                session.status = SessionStatus::Idle;
            }
        }
    }

    async fn finish_turn_if_present(&self, session_id: &str) {
        let mut state = self.state.lock().await;
        if let Some(session) = state.sessions.get_mut(session_id) {
            if matches!(
                session.status,
                SessionStatus::Running
                    | SessionStatus::Cancelling
                    | SessionStatus::AwaitingPermission
            ) {
                session.status = SessionStatus::Idle;
            }
        }
    }

    /// Closes a session idempotently.  Closing the broker before awaiting
    /// process termination guarantees every permission waiter is resolved.
    pub async fn close(&self, session_id: &str) -> Result<(), SessionError> {
        let process = {
            let mut state = self.state.lock().await;
            let session = match state.sessions.get_mut(session_id) {
                Some(session) => session,
                None => return Ok(()),
            };
            session.status = SessionStatus::Closing;
            session.process.as_ref().map(Arc::clone)
        };
        if let Some(process) = process {
            process.permissions().close();
            let termination = process.terminate().await;
            self.state.lock().await.sessions.remove(session_id);
            termination?;
        }
        Ok(())
    }

    /// Stops all processes in a deterministic snapshot order and prevents new
    /// sessions from opening.  Each process is terminated outside the mutex.
    pub async fn dispose(&self) -> Result<(), SessionError> {
        let processes = {
            let mut state = self.state.lock().await;
            state.disposed = true;
            state
                .sessions
                .values_mut()
                .map(|session| {
                    session.status = SessionStatus::Closing;
                    session.process.as_ref().map(Arc::clone)
                })
                .collect::<Vec<_>>()
        };
        let mut first_error = None;
        for process in processes.into_iter().flatten() {
            process.permissions().close();
            if let Err(error) = process.terminate().await {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        self.state.lock().await.sessions.clear();
        first_error.map_or(Ok(()), |error| Err(SessionError::Process(error)))
    }
}

fn visible_status(session: &ManagedSession) -> SessionStatus {
    let pending = session
        .process
        .as_ref()
        .map(|process| process.permissions().pending_count())
        .unwrap_or(0);
    if pending > 0 && matches!(session.status, SessionStatus::Idle | SessionStatus::Running) {
        SessionStatus::AwaitingPermission
    } else {
        session.status
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeProcess {
        permissions: PermissionBroker,
        cancels: AtomicUsize,
        terminates: AtomicUsize,
        requests: AtomicUsize,
        fallback: bool,
    }

    impl FakeProcess {
        fn new(fallback: bool) -> Self {
            Self {
                permissions: PermissionBroker::default(),
                cancels: AtomicUsize::new(0),
                terminates: AtomicUsize::new(0),
                requests: AtomicUsize::new(0),
                fallback,
            }
        }
    }

    impl ProcessHandle for FakeProcess {
        fn permissions(&self) -> PermissionBroker {
            self.permissions.clone()
        }

        fn request<'a>(
            &'a self,
            _method: &'a str,
            _params: Value,
        ) -> ProcessFuture<'a, Result<Value, ProcessError>> {
            Box::pin(async move {
                self.requests.fetch_add(1, Ordering::Relaxed);
                Ok(serde_json::json!({ "stopReason": "end_turn" }))
            })
        }

        fn cancel_with_fallback<'a>(
            &'a self,
            _session_id: &'a str,
            _grace_period: Duration,
        ) -> ProcessFuture<'a, Result<CancelResult, ProcessError>> {
            Box::pin(async move {
                self.cancels.fetch_add(1, Ordering::Relaxed);
                if self.fallback {
                    self.terminate().await?;
                    Ok(CancelResult::FallbackRequired)
                } else {
                    Ok(CancelResult::Semantic)
                }
            })
        }

        fn terminate<'a>(&'a self) -> ProcessFuture<'a, Result<(), ProcessError>> {
            Box::pin(async move {
                self.terminates.fetch_add(1, Ordering::Relaxed);
                Ok(())
            })
        }
    }

    struct FakeFactory {
        process: Arc<FakeProcess>,
    }

    impl ProcessFactory for FakeFactory {
        fn spawn<'a>(
            &'a self,
            _session_id: &'a str,
            _config: AcpProcessConfig,
        ) -> ProcessFuture<'a, Result<Arc<dyn ProcessHandle>, ProcessError>> {
            let process = Arc::clone(&self.process);
            Box::pin(async move { Ok(process as Arc<dyn ProcessHandle>) })
        }
    }

    fn config() -> AcpProcessConfig {
        AcpProcessConfig::new("unused-in-fake", "/tmp")
    }

    #[tokio::test]
    async fn enforces_unique_ids_and_three_active_processes() {
        let manager = SessionManager::with_factory(Arc::new(FakeFactory {
            process: Arc::new(FakeProcess::new(false)),
        }));
        for id in ["a", "b", "c"] {
            manager.open(id, config()).await.unwrap();
        }
        assert_eq!(manager.active_count().await, MAX_ACTIVE_SESSIONS);
        assert!(matches!(
            manager.open("d", config()).await,
            Err(SessionError::Capacity)
        ));
        assert!(matches!(
            manager.open("a", config()).await,
            Err(SessionError::AlreadyActive(_))
        ));
    }

    #[tokio::test]
    async fn open_with_eviction_drops_oldest_idle_but_never_running_sessions() {
        let manager = SessionManager::with_factory(Arc::new(FakeFactory {
            process: Arc::new(FakeProcess::new(false)),
        }));
        manager.open("a", config()).await.unwrap();
        manager.open("b", config()).await.unwrap();
        manager.open("c", config()).await.unwrap();
        manager.begin_turn("b").await.unwrap();
        manager.begin_turn("c").await.unwrap();

        manager.open_with_eviction("d", config()).await.unwrap();
        assert!(manager.snapshot("a").await.is_none());
        assert!(manager.snapshot("b").await.is_some());
        assert!(manager.snapshot("c").await.is_some());
        assert!(manager.snapshot("d").await.is_some());

        manager.begin_turn("d").await.unwrap();
        assert!(matches!(
            manager.open_with_eviction("e", config()).await,
            Err(SessionError::Capacity)
        ));
    }

    #[tokio::test]
    async fn pending_permission_is_visible_and_not_an_eviction_victim() {
        let manager = SessionManager::with_factory(Arc::new(FakeFactory {
            process: Arc::new(FakeProcess::new(false)),
        }));
        manager.open("a", config()).await.unwrap();
        manager.open("b", config()).await.unwrap();
        manager.open("c", config()).await.unwrap();
        manager.begin_turn("b").await.unwrap();
        manager.begin_turn("c").await.unwrap();
        let broker = manager.permissions("a").await.unwrap();
        let (_, waiter) = broker
            .request_with_id("permission", "a", Value::Null, vec![])
            .unwrap();
        assert_eq!(
            manager.snapshot("a").await.unwrap().status,
            SessionStatus::AwaitingPermission
        );
        assert!(matches!(
            manager.open_with_eviction("d", config()).await,
            Err(SessionError::Capacity)
        ));
        broker.close();
        let _ = waiter.await;
    }

    #[tokio::test]
    async fn cancel_uses_semantic_path_and_fallback_path() {
        let process = Arc::new(FakeProcess::new(true));
        let manager = SessionManager::with_factory(Arc::new(FakeFactory {
            process: Arc::clone(&process),
        }));
        manager.open("s", config()).await.unwrap();
        assert_eq!(
            manager.cancel("s").await.unwrap(),
            CancelResult::FallbackRequired
        );
        assert_eq!(process.cancels.load(Ordering::Relaxed), 1);
        assert_eq!(process.terminates.load(Ordering::Relaxed), 1);
        assert_eq!(
            manager.snapshot("s").await.unwrap().status,
            SessionStatus::Idle
        );
    }

    #[tokio::test]
    async fn close_resolves_permission_waiters_before_termination() {
        let process = Arc::new(FakeProcess::new(false));
        let manager = SessionManager::with_factory(Arc::new(FakeFactory {
            process: Arc::clone(&process),
        }));
        manager.open("s", config()).await.unwrap();
        let broker = manager.permissions("s").await.unwrap();
        let (request, waiter) = broker
            .request("s", serde_json::json!({"toolCallId":"tool"}), vec![])
            .unwrap();
        manager.close("s").await.unwrap();
        assert_eq!(
            waiter.await.unwrap().outcome,
            super::super::permission::PermissionOutcome::Cancelled
        );
        assert_eq!(request.session_id, "s");
        assert_eq!(manager.active_count().await, 0);
    }

    #[tokio::test]
    async fn snapshots_follow_ordered_lifecycle() {
        let manager = SessionManager::with_factory(Arc::new(FakeFactory {
            process: Arc::new(FakeProcess::new(false)),
        }));
        let snapshot = manager.open("s", config()).await.unwrap();
        assert_eq!(snapshot.status, SessionStatus::Idle);
        manager.begin_turn("s").await.unwrap();
        assert_eq!(
            manager.snapshot("s").await.unwrap().status,
            SessionStatus::Running
        );
        manager.finish_turn("s").await.unwrap();
        assert_eq!(
            manager.snapshot("s").await.unwrap().status,
            SessionStatus::Idle
        );
    }

    #[tokio::test]
    async fn prompt_finishes_turn_without_leaving_manager_in_running_state() {
        let process = Arc::new(FakeProcess::new(false));
        let manager = SessionManager::with_factory(Arc::new(FakeFactory {
            process: Arc::clone(&process),
        }));
        manager.open("s", config()).await.unwrap();
        let response = manager
            .prompt("s", serde_json::json!([{"type":"text","text":"hello"}]))
            .await
            .unwrap();
        assert_eq!(response["stopReason"], "end_turn");
        assert_eq!(process.requests.load(Ordering::Relaxed), 1);
        assert_eq!(
            manager.snapshot("s").await.unwrap().status,
            SessionStatus::Idle
        );
    }

    #[tokio::test]
    async fn generated_session_ids_are_nonempty_and_unique() {
        let manager = SessionManager::with_factory(Arc::new(FakeFactory {
            process: Arc::new(FakeProcess::new(false)),
        }));
        let first = manager.create(config()).await.unwrap();
        let second = manager.create(config()).await.unwrap();
        assert_ne!(first.id, second.id);
        assert!(!first.id.is_empty());
    }
}
