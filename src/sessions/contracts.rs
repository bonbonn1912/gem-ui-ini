//! Renderer-facing contracts for persistent Gemini sessions.
//!
//! These types intentionally use the same camelCase wire names as the former
//! Electron contracts.  Repository code uses the exact same values, which
//! prevents a lossy DTO conversion between SQLite and Tauri commands.

use serde::{Deserialize, Serialize};

use crate::projects::{ProjectRoot, ProjectRootKind};

pub const MAX_SESSION_OPTIONS: usize = 50;
pub const MAX_SESSION_TITLE_CHARS: usize = 200;
pub const MAX_PROVIDER_SESSION_ID_CHARS: usize = 500;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Starting,
    Running,
    AwaitingPermission,
    Cancelling,
    RootsChanged,
    Error,
    Disconnected,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::AwaitingPermission => "awaiting_permission",
            Self::Cancelling => "cancelling",
            Self::RootsChanged => "roots_changed",
            Self::Error => "error",
            Self::Disconnected => "disconnected",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "idle" => Self::Idle,
            "starting" => Self::Starting,
            "running" => Self::Running,
            "awaiting_permission" => Self::AwaitingPermission,
            "cancelling" => Self::Cancelling,
            "roots_changed" => Self::RootsChanged,
            "error" => Self::Error,
            "disconnected" => Self::Disconnected,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionOption {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppSession {
    pub id: String,
    pub provider: String,
    pub provider_session_id: Option<String>,
    pub project_id: String,
    pub last_root_revision: u64,
    pub last_root_fingerprint: String,
    pub title: String,
    pub status: SessionStatus,
    pub model: Option<String>,
    pub mode: Option<String>,
    #[serde(default)]
    pub available_models: Vec<SessionOption>,
    #[serde(default)]
    pub available_modes: Vec<SessionOption>,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl AppSession {
    pub fn validate(&self) -> Result<(), String> {
        validate_id(&self.id, "session id")?;
        validate_id(&self.project_id, "project id")?;
        if self.provider != "gemini-cli" {
            return Err("provider must be gemini-cli".to_owned());
        }
        if self.title.trim().is_empty() || self.title.chars().count() > MAX_SESSION_TITLE_CHARS {
            return Err("title must contain 1 to 200 characters".to_owned());
        }
        if self.last_root_revision == 0 {
            return Err("lastRootRevision must be at least 1".to_owned());
        }
        if self.last_root_fingerprint.len() != 64
            || !self
                .last_root_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self
                .last_root_fingerprint
                .bytes()
                .any(|byte| byte.is_ascii_uppercase())
        {
            return Err("lastRootFingerprint must be a lowercase SHA-256 fingerprint".to_owned());
        }
        if self.available_models.len() > MAX_SESSION_OPTIONS
            || self.available_modes.len() > MAX_SESSION_OPTIONS
        {
            return Err("a session may cache at most 50 models and modes".to_owned());
        }
        for option in self
            .available_models
            .iter()
            .chain(self.available_modes.iter())
        {
            if option.id.trim().is_empty() || option.id.chars().count() > 200 {
                return Err("session option id is invalid".to_owned());
            }
            if option.name.trim().is_empty() || option.name.chars().count() > 200 {
                return Err("session option name is invalid".to_owned());
            }
            if option
                .description
                .as_ref()
                .is_some_and(|value| value.chars().count() > 500)
            {
                return Err("session option description is invalid".to_owned());
            }
        }
        if self.provider_session_id.as_ref().is_some_and(|value| {
            value.trim().is_empty() || value.chars().count() > MAX_PROVIDER_SESSION_ID_CHARS
        }) {
            return Err("providerSessionId is invalid".to_owned());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionUpdate {
    pub provider_session_id: Option<Option<String>>,
    pub last_root_revision: Option<u64>,
    pub last_root_fingerprint: Option<String>,
    pub title: Option<String>,
    pub status: Option<SessionStatus>,
    pub model: Option<Option<String>>,
    pub mode: Option<Option<String>>,
    pub available_models: Option<Vec<SessionOption>>,
    pub available_modes: Option<Vec<SessionOption>>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRootAuditSnapshot {
    pub session_id: String,
    pub root_revision: u64,
    pub root_fingerprint: String,
    pub captured_at: String,
    pub roots: Vec<SessionRootEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRootEntry {
    pub kind: String,
    pub path: String,
    pub real_path: String,
    pub label: String,
    pub sort_order: usize,
}

impl SessionRootAuditSnapshot {
    pub fn from_roots(
        session_id: impl Into<String>,
        root_revision: u64,
        root_fingerprint: impl Into<String>,
        captured_at: impl Into<String>,
        roots: &[ProjectRoot],
    ) -> Self {
        Self {
            session_id: session_id.into(),
            root_revision,
            root_fingerprint: root_fingerprint.into(),
            captured_at: captured_at.into(),
            roots: roots
                .iter()
                .map(|root| SessionRootEntry {
                    kind: match &root.kind {
                        ProjectRootKind::Primary => "primary".to_owned(),
                        ProjectRootKind::Additional => "additional".to_owned(),
                    },
                    path: root.path.clone(),
                    real_path: root.real_path.clone(),
                    label: root.label.clone(),
                    sort_order: root.sort_order,
                })
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSessionInput {
    pub client_request_id: String,
    pub project_id: String,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListSessionsInput {
    pub project_id: String,
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSessionInput {
    pub client_request_id: String,
    pub session_id: String,
    pub title: Option<String>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub model: Option<Option<String>>,
    pub mode: Option<Option<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteSessionInput {
    pub client_request_id: String,
    pub session_id: String,
    #[serde(default)]
    pub delete_provider_history: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchSessionsInput {
    pub project_id: String,
    pub query: String,
    #[serde(default)]
    pub search_content: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendPromptInput {
    pub client_request_id: String,
    pub session_id: String,
    pub expected_root_revision: u64,
    pub text: String,
    pub attachment_ids: Vec<String>,
    #[serde(default)]
    pub context_attachment_ids: Vec<String>,
    #[serde(default)]
    pub project_files: Vec<serde_json::Value>,
    #[serde(default)]
    pub external_context_refs: Vec<serde_json::Value>,
    pub history_mode: Option<PromptHistoryMode>,
    #[serde(skip)]
    pub(crate) attachment_payloads: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelTurnInput {
    pub client_request_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionResponse {
    pub client_request_id: String,
    pub session_id: String,
    pub request_id: String,
    pub option_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSessionModeInput {
    pub client_request_id: String,
    pub session_id: String,
    pub mode_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSessionModelInput {
    pub client_request_id: String,
    pub session_id: String,
    pub model_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptHistoryMode {
    Compressed,
    Fresh,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetReconnectStateInput {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscribeSessionEventsInput {
    pub session_id: String,
    pub after_seq: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsubscribeSessionEventsInput {
    pub subscription_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendPromptResult {
    pub turn_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSubscriptionResult {
    pub subscription_id: String,
    pub replay: Vec<super::event_repository::StreamEnvelope>,
    pub usage_snapshot: Option<super::usage::UsageSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidResult {
    pub ok: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSearchResultItem {
    pub session_id: String,
    pub title_matches: bool,
    pub matched_snippet: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSearchResult {
    pub project_id: String,
    pub query: String,
    pub results: Vec<SessionSearchResultItem>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconnectState {
    pub session_id: String,
    pub reconnected: bool,
    pub has_history: bool,
}

fn validate_id(value: &str, name: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > 200 {
        Err(format!("{name} must not be empty"))
    } else {
        Ok(())
    }
}
