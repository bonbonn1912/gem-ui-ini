pub mod blob_store;
pub mod commands;
pub mod contracts;
pub mod extraction;
pub mod mime;
pub mod prompt;
pub mod repository;
pub mod service;
pub mod subscriptions;

pub use blob_store::ContextBlobStore;
pub use contracts::*;
pub use prompt::{ContextAttachmentSnapshot, PromptPart};
pub use repository::{ContextAttachmentRepository, StoredContextAttachment};
pub use service::ContextAttachmentService;
pub use subscriptions::{
    ContextAttachmentPush, ContextAttachmentSubscriptionHub, UnsubscribeContextAttachmentsInput,
};

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidResult {
    pub ok: bool,
}
