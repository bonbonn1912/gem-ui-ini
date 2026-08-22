//! The native ACP transport used by the session layer.
//!
//! ACP is deliberately kept behind these small modules.  The wire protocol is
//! NDJSON JSON-RPC, so the rest of the application does not need to depend on
//! an SDK whose wire types may change between Gemini CLI releases.

pub mod batch;
pub mod events;
pub mod permission;
pub mod process;
pub mod rpc;
pub mod session_manager;
pub mod usage;

pub use batch::{BatchAccumulator, EventBatch, EventBatcher};
pub use events::{normalize_notification, normalize_permission_request, AcpEvent, DeltaKind};
pub use permission::{
    PermissionBroker, PermissionError, PermissionOption, PermissionOutcome, PermissionRequest,
    PermissionResolution,
};
pub use process::{AcpProcess, AcpProcessConfig, CancelResult, ProcessError, ProcessExit};
pub use rpc::{
    AcpRpcClient, RpcError, RpcInbound, RpcNotification, RpcRequest, RpcResponse, RpcResponseError,
};
pub use session_manager::{
    AcpProcessFactory, AcpProcessHandle, ProcessFactory, ProcessFuture, ProcessHandle,
    SessionError, SessionManager, SessionSnapshot, SessionStatus,
};
pub use usage::{
    add_token_counters, parse_prompt_usage, parse_usage_update, ModelTokenUsage, TokenCounters,
    TokenUsageSource, TotalKind, UsageContextObservation, UsageCost, UsageScope,
    UsageTokenObservation,
};
