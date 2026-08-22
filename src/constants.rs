//! Shared limits. Keep these values in one place so the Rust backend and its
//! future commands cannot silently drift from the migration contract.

pub const MAX_ADDITIONAL_ROOTS: usize = 5;
pub const MAX_ROOTS: usize = MAX_ADDITIONAL_ROOTS + 1;
pub const MAX_ACTIVE_SESSIONS: usize = 3;
pub const MAX_GIT_REPOSITORIES: usize = 6;
pub const MAX_REPOSITORIES: usize = MAX_GIT_REPOSITORIES;
pub const MAX_GIT_CHANGES: usize = 10_000;
pub const MAX_GIT_DIFF_HUNKS: usize = 2_000;
pub const MAX_GIT_DIFF_LINES: usize = 50_000;
pub const MAX_PROJECT_FILE_SEARCH_RESULTS: usize = 10;
pub const MAX_PROJECT_FILE_RESULTS: usize = MAX_PROJECT_FILE_SEARCH_RESULTS;
pub const MAX_PROJECT_FILE_REFERENCES_PER_PROMPT: usize = 10;
pub const MAX_PROJECT_FILE_BYTES: usize = 1024 * 1024;
pub const MAX_PROJECT_FILE_CHARS: usize = 60_000;
pub const MAX_PROJECT_FILE_TOTAL_CHARS: usize = 160_000;
pub const MAX_GEMINI_SKILLS: usize = 500;
pub const MAX_SKILLS: usize = MAX_GEMINI_SKILLS;
pub const MAX_MCP_SERVERS: usize = 200;
pub const MAX_CONTEXT_ATTACHMENTS_PER_SCOPE: usize = 50;
pub const MAX_CONTEXT_ATTACHMENTS_PER_PROMPT: usize = 20;
pub const MAX_ATTACHMENTS_PER_PROMPT: usize = MAX_CONTEXT_ATTACHMENTS_PER_PROMPT;
pub const MAX_CONTEXT_CHARS_PER_ATTACHMENT: usize = 60_000;
pub const MAX_CONTEXT_CHARS_TOTAL: usize = 240_000;
pub const MAX_PROMPT_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_PROMPT_ATTACHMENTS: usize = 4;
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_CONTEXT_FILE_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_CONTEXT_ATTACHMENT_BYTES: usize = MAX_CONTEXT_FILE_BYTES;
pub const MAX_ATTACHMENT_CHARS: usize = MAX_CONTEXT_CHARS_PER_ATTACHMENT;
pub const MAX_TOTAL_ATTACHMENT_CHARS: usize = MAX_CONTEXT_CHARS_TOTAL;
pub const MAX_TODOS_PER_PROJECT: usize = 200;
pub const MAX_TODO_ATTACHMENTS: usize = 20;
pub const MAX_TODO_DESCRIPTION_CHARS: usize = 20_000;
pub const MAX_EVENT_BATCH_CHARS: usize = 100_000;
pub const EVENT_BUFFER_WINDOW_MS: u64 = 32;
pub const MAX_GIT_STATUS_ENTRIES: usize = 10_000;
pub const MAX_DIFF_LINES: usize = 50_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_match_the_migration_plan() {
        assert_eq!(MAX_ROOTS, 6);
        assert_eq!(MAX_ACTIVE_SESSIONS, 3);
        assert_eq!(EVENT_BUFFER_WINDOW_MS, 32);
        assert_eq!(MAX_EVENT_BATCH_CHARS, 100_000);
        assert_eq!(MAX_CONTEXT_ATTACHMENT_BYTES, 50 * 1024 * 1024);
        assert_eq!(MAX_TOTAL_ATTACHMENT_CHARS, 240_000);
    }
}
