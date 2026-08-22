//! Pure process-stream safety helpers.

pub mod binary_probe;
pub mod bounded_text_buffer;
pub mod git_binary_probe;
pub mod ndjson_guard;

pub use bounded_text_buffer::{environment_secrets, redact_diagnostic_text, BoundedTextBuffer};
pub use ndjson_guard::{NdjsonLineGuard, NdjsonLineGuardError};
