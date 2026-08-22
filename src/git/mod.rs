//! Project-scoped Git runner, discovery, status snapshots, and diff parsers.
//!
//! The service is kept independent from Tauri command wiring so the app state
//! can choose its binary path and status subscription hub at startup.

pub mod commands;
pub mod diff;
pub mod discovery;
pub mod runner;
pub mod service;
pub mod status;

pub use commands::{
    git_get_file_diff, git_get_project_status, git_list_project_repositories,
    git_subscribe_project_status, git_unsubscribe_project_status, GitCommandState,
    UnsubscribeGitProjectStatusInput,
};
pub use discovery::{
    discover_project_repositories, DiscoveredRepositoryContext, ReadyRepositoryContext,
    RepositoryState,
};
pub use runner::{
    run_git_command, GitCommandInput, GitCommandResult, GIT_DIFF_OUTPUT_LIMIT,
    GIT_STATUS_OUTPUT_LIMIT, GIT_STDERR_LIMIT,
};
pub use service::{
    now_iso, rfc3339_from_system_time, spawn_status_poller, GetGitFileDiffInput,
    GetGitProjectStatusInput, GitArea, GitDiffHunk, GitDiffLine, GitFileChange, GitFileDiff,
    GitFileDiffState, GitProjectStatus, GitRepositoryList, GitRepositoryState,
    GitRepositorySummary, GitService, GitStatusPollerHandle, GitStatusSubscriptionResult,
};

pub use diff::{
    parse_unified_diff, DiffLine, DiffLineKind, DiffLineLimitError, ParsedUnifiedDiff,
    UnifiedDiffError,
};
pub use status::{
    parse_porcelain_v2, ParsedGitBranch, ParsedGitStatus, ParsedGitStatusEntry, PorcelainV2Error,
};
