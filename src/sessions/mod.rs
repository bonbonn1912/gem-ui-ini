//! Persistent sessions, timeline replay and usage aggregation.

pub mod capabilities;
pub mod commands;
pub mod contracts;
pub mod event_pipeline;
pub mod event_repository;
pub mod service;
pub mod session_repository;
pub mod timeline;
pub mod usage;

pub use capabilities::SessionCapabilities;
pub use commands::{generate_session_title, ProcessConfigFactory, SessionCommandService};
pub use contracts::{
    AppSession, CancelTurnInput, CreateSessionInput, DeleteSessionInput, EventSubscriptionResult,
    GetReconnectStateInput, ListSessionsInput, PermissionResponse, PromptHistoryMode,
    ReconnectState, SearchSessionsInput, SendPromptInput, SendPromptResult, SessionOption,
    SessionRootAuditSnapshot, SessionRootEntry, SessionSearchResult, SessionSearchResultItem,
    SessionStatus, SessionUpdate, SetSessionModeInput, SetSessionModelInput,
    SubscribeSessionEventsInput, UnsubscribeSessionEventsInput, UpdateSessionInput, VoidResult,
};
pub use event_pipeline::SessionEventPipeline;
pub use event_repository::{
    AgentEvent, AppendEventInput, ContentSearchResult, EventRepository, StreamEnvelope,
};
pub use service::SessionService;
pub use session_repository::SessionRepository;
pub use timeline::{persist_batch, TimelineAccumulator};
pub use usage::{
    ContextUsage, CostUsage, LastTurnUsage, RecordContextInput, RecordTokensInput, SessionUsage,
    SessionUsageCoverage, UsageRepository, UsageService, UsageSnapshot,
};
