pub mod api;
pub mod binding;
pub mod commands;
pub mod contracts;
pub mod discussion;
pub mod merge_request;
pub mod remote_url;
pub mod repository;
pub mod review_context;
pub mod service;
pub mod vault;

pub use api::{
    encode_component, normalize_api_base_url, GitLabApiClient, GitLabTransport,
    ReqwestGitLabTransport,
};
pub use binding::{compute_repository_key, BindingRoot, RepositoryBindingResolver};
pub use commands::{
    gitlab_connect_merge_request_url, gitlab_disable_binding, gitlab_enable_binding,
    gitlab_get_review_state, gitlab_list_connections, gitlab_list_merge_requests,
    gitlab_list_repository_candidates, gitlab_prepare_review_context, gitlab_remove_connection,
    gitlab_replace_token, gitlab_reply_to_discussion, gitlab_resolve_discussion,
    gitlab_save_connection, gitlab_select_merge_request, gitlab_subscribe_review_state,
    gitlab_test_connection, gitlab_unsubscribe_review_state, GitLabCommandState,
};
pub use contracts::*;
pub use discussion::{map_gitlab_discussions, normalize_avatar_url};
pub use merge_request::{
    map_raw_merge_request, normalize_merge_request_state, parse_merge_request_url,
    sort_merge_requests, MergeRequestUrl,
};
pub use remote_url::{parse_gitlab_remote_url, sanitize_remote_url, ParsedGitLabRemote};
pub use repository::GitLabRepository;
pub use review_context::{
    ReviewContextBuilder, ReviewContextScope, ReviewContextSnapshotStore, ReviewPromptPart,
};
pub use service::{spawn_review_poller, GitLabReviewPollerHandle, GitLabService};
pub use vault::{
    AesGcmStorage, GitLabTokenVault, HybridSecretStorage, KeyringStorage, SecretStorage,
};
