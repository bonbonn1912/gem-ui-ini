use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitLabAccessMode {
    ReadOnly,
    ReadWrite,
    Unknown,
    ReauthenticationRequired,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabUserSummary {
    pub id: i64,
    pub username: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabConnectionSummary {
    pub id: String,
    pub instance_url: String,
    pub api_base_url: String,
    pub user: GitLabUserSummary,
    pub token_configured: bool,
    pub access: GitLabAccessMode,
    pub scopes: Vec<String>,
    pub allow_self_signed_tls: bool,
    pub expires_at: Option<String>,
    pub last_validated_at: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabRepositoryBinding {
    pub id: String,
    pub project_id: String,
    pub root_id: String,
    pub connection_id: String,
    pub repository_key: String,
    pub remote_name: String,
    pub remote_url: String,
    pub source_project_id: i64,
    pub source_project_path: String,
    pub enabled: bool,
    pub selected_target_project_id: Option<i64>,
    pub selected_target_project_path: Option<String>,
    pub selected_merge_request_iid: Option<i64>,
    pub last_synced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabRepositoryCandidateRemote {
    pub name: String,
    pub url: String,
    pub suggested_instance_url: Option<String>,
    pub suggested_project_path: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabRepositoryCandidate {
    pub candidate_id: String,
    pub root_ids: Vec<String>,
    pub display_name: String,
    pub branch: Option<String>,
    pub head_sha: Option<String>,
    pub remotes: Vec<GitLabRepositoryCandidateRemote>,
    pub binding: Option<GitLabRepositoryBinding>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabMergeRequestSummary {
    pub target_project_id: i64,
    pub target_project_path: String,
    pub iid: i64,
    pub title: String,
    pub web_url: String,
    pub state: String,
    pub draft: bool,
    pub source_branch: String,
    pub target_branch: String,
    pub source_project_id: i64,
    pub head_sha: String,
    pub base_sha: Option<String>,
    pub start_sha: Option<String>,
    pub author: GitLabUserSummary,
    pub unresolved_count: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitLabPositionType {
    Text,
    Image,
    File,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabLineRangeSide {
    pub line_code: Option<String>,
    #[serde(rename = "type")]
    pub line_type: Option<String>,
    pub old_line: Option<u64>,
    pub new_line: Option<u64>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabLineRange {
    pub start: GitLabLineRangeSide,
    pub end: GitLabLineRangeSide,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabDiffPosition {
    pub position_type: GitLabPositionType,
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub old_line: Option<u64>,
    pub new_line: Option<u64>,
    pub line_range: Option<GitLabLineRange>,
    pub outdated: bool,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitLabNoteType {
    #[serde(rename = "DiffNote")]
    DiffNote,
    #[serde(rename = "DiscussionNote")]
    DiscussionNote,
    #[serde(rename = "Note")]
    Note,
    #[serde(rename = "unknown")]
    Unknown,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabDiscussionNote {
    pub id: i64,
    #[serde(rename = "type")]
    pub note_type: GitLabNoteType,
    pub body: String,
    pub author: GitLabUserSummary,
    pub system: bool,
    pub resolvable: bool,
    pub resolved: bool,
    pub resolved_by: Option<GitLabUserSummary>,
    pub created_at: String,
    pub updated_at: String,
    pub position: Option<GitLabDiffPosition>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabDiscussion {
    pub id: String,
    pub individual_note: bool,
    pub notes: Vec<GitLabDiscussionNote>,
    pub resolvable: bool,
    pub resolved: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLabReviewState {
    pub project_id: String,
    pub binding_id: String,
    pub repository_display_name: String,
    pub connection: GitLabConnectionSummary,
    pub binding: GitLabRepositoryBinding,
    pub merge_request: Option<GitLabMergeRequestSummary>,
    pub discussions: Vec<GitLabDiscussion>,
    pub total_discussions_count: usize,
    pub unresolved_discussions_count: usize,
    pub last_refreshed_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveGitLabConnectionInput {
    pub client_request_id: String,
    pub instance_url: String,
    pub token: String,
    #[serde(default)]
    pub allow_self_signed_tls: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestGitLabConnectionInput {
    pub instance_url: String,
    pub token: String,
    #[serde(default)]
    pub allow_self_signed_tls: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaceGitLabTokenInput {
    pub client_request_id: String,
    pub connection_id: String,
    pub token: String,
    pub allow_self_signed_tls: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveGitLabConnectionInput {
    pub client_request_id: String,
    pub connection_id: String,
    #[serde(default)]
    pub force_disable_bindings: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListGitLabRepositoryCandidatesInput {
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnableGitLabBindingInput {
    pub client_request_id: String,
    pub project_id: String,
    pub expected_root_revision: u64,
    pub root_id: String,
    pub repository_key: String,
    pub connection_id: String,
    pub remote_name: String,
    pub remote_url: String,
    pub source_project_id: i64,
    pub source_project_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisableGitLabBindingInput {
    pub client_request_id: String,
    pub project_id: String,
    pub expected_root_revision: u64,
    pub binding_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListGitLabMergeRequestsInput {
    pub project_id: String,
    pub expected_root_revision: u64,
    pub binding_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectGitLabMergeRequestInput {
    pub client_request_id: String,
    pub project_id: String,
    pub expected_root_revision: u64,
    pub binding_id: String,
    pub target_project_id: i64,
    pub target_project_path: String,
    pub merge_request_iid: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectGitLabMergeRequestUrlInput {
    pub client_request_id: String,
    pub project_id: String,
    pub expected_root_revision: u64,
    pub binding_id: String,
    pub merge_request_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetGitLabReviewStateInput {
    pub project_id: String,
    pub expected_root_revision: u64,
    pub binding_id: String,
}

pub type SubscribeGitLabReviewStateInput = GetGitLabReviewStateInput;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsubscribeGitLabReviewStateInput {
    pub subscription_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveGitLabDiscussionInput {
    pub client_request_id: String,
    pub project_id: String,
    pub expected_root_revision: u64,
    pub binding_id: String,
    pub target_project_id: i64,
    pub merge_request_iid: i64,
    pub discussion_id: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplyToGitLabDiscussionInput {
    pub client_request_id: String,
    pub project_id: String,
    pub expected_root_revision: u64,
    pub binding_id: String,
    pub target_project_id: i64,
    pub merge_request_iid: i64,
    pub discussion_id: String,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareGitLabReviewContextInput {
    pub project_id: String,
    pub expected_root_revision: u64,
    pub binding_id: String,
    pub target_project_id: i64,
    pub merge_request_iid: i64,
    pub discussion_id: String,
    pub selected_note_id: Option<i64>,
    pub context_mode: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitLabReviewStateSubscriptionResult {
    pub subscription_id: String,
    pub initial: GitLabReviewState,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalContextRef {
    pub kind: String,
    pub id: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedExternalContext {
    #[serde(rename = "ref")]
    pub reference: ExternalContextRef,
    pub title: String,
    pub repository_label: String,
    pub merge_request_reference: String,
    pub file_path: Option<String>,
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
    pub context_mode: String,
    pub estimated_chars: usize,
    pub expires_at: String,
    pub warnings: Vec<String>,
}
