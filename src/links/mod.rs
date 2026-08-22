pub mod commands;
pub mod fetcher;
pub mod html;
pub mod policy;
pub mod preview;

use crate::{context_attachments::repository::ContextAttachmentRepository, error::AppError};
#[cfg(feature = "reqwest-client")]
pub use fetcher::ReqwestLinkMetadataFetcher;
pub use fetcher::{
    DisabledLinkMetadataFetcher, LinkMetadata, LinkMetadataFetcher, LinkMetadataFetcherService,
};
pub use policy::{assert_public_url, is_public_address, normalize_url, NormalizedUrl};
pub use preview::{PreviewBounds, PreviewHost, PreviewTarget, PreviewViewState};

/// Resolves and validates the URL stored for a link attachment.  Returning a
/// normalized URL/host prevents callers from accidentally opening a stale or
/// credential-bearing value read from the database.
pub fn resolve_attachment_target(
    repository: &ContextAttachmentRepository,
    attachment_id: &str,
) -> Result<(String, String), AppError> {
    let value = repository.get_internal(attachment_id, None)?;
    let link = value
        .public
        .link
        .ok_or_else(|| AppError::Validation("Dieser Anhang ist kein Link.".to_owned()))?;
    let normalized = assert_public_url(&link.url)?;
    Ok((normalized.url, normalized.host))
}
