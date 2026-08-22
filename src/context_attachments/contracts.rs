use serde::{Deserialize, Serialize};

pub const MAX_CONTEXT_FILE_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_CONTEXT_ATTACHMENTS_PER_SCOPE: usize = 50;
pub const MAX_CONTEXT_ATTACHMENTS_PER_PROMPT: usize = 20;
pub const MAX_CONTEXT_CHARS_PER_ATTACHMENT: usize = 60_000;
pub const MAX_CONTEXT_CHARS_TOTAL: usize = 240_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextAttachmentScope {
    Project,
    Session,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextAttachmentKind {
    File,
    Link,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextAttachmentOrigin {
    Manual,
    Chat,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtractionState {
    Pending,
    Running,
    Ready,
    Empty,
    Unsupported,
    TooLarge,
    Failed,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkPreviewState {
    Pending,
    Ready,
    Unauthorized,
    Blocked,
    Failed,
    Disabled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextAttachmentFile {
    pub display_name: String,
    pub mime_type: String,
    pub size: u64,
    pub sha256: String,
    pub extraction_state: ExtractionState,
    pub extracted_chars: Option<usize>,
    pub page_count: Option<usize>,
    pub extraction_error: Option<String>,
    pub renderable: bool,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextAttachmentLink {
    pub url: String,
    pub host: String,
    pub preview_state: LinkPreviewState,
    pub preview_title: Option<String>,
    pub preview_description: Option<String>,
    pub preview_site_name: Option<String>,
    pub has_preview_image: bool,
    pub preview_error: Option<String>,
    pub fetched_at: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextAttachment {
    pub id: String,
    pub project_id: String,
    pub scope: ContextAttachmentScope,
    pub session_id: Option<String>,
    pub kind: ContextAttachmentKind,
    pub origin: ContextAttachmentOrigin,
    pub title: String,
    pub note: Option<String>,
    pub sort_order: usize,
    pub included_in_context: bool,
    pub estimated_tokens: Option<usize>,
    pub file: Option<ContextAttachmentFile>,
    pub link: Option<ContextAttachmentLink>,
    pub created_at: String,
    pub updated_at: String,
}
impl ContextAttachment {
    pub fn validate(&self) -> Result<(), String> {
        if self.title.trim().is_empty() || self.title.chars().count() > 200 {
            return Err("title must contain 1 to 200 characters".to_owned());
        }
        if (self.kind == ContextAttachmentKind::File) != self.file.is_some()
            || (self.kind == ContextAttachmentKind::Link) != self.link.is_some()
        {
            return Err("kind must match the populated payload".to_owned());
        }
        if (self.scope == ContextAttachmentScope::Project) != self.session_id.is_none() {
            return Err("scope must match sessionId".to_owned());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextAttachmentList {
    pub project_id: String,
    pub session_id: Option<String>,
    pub project_attachments: Vec<ContextAttachment>,
    pub session_attachments: Vec<ContextAttachment>,
    pub included_count: usize,
    pub estimated_total_tokens: usize,
    pub over_budget: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListContextAttachmentsInput {
    pub project_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddContextFilesInput {
    pub client_request_id: String,
    pub project_id: String,
    pub scope: ContextAttachmentScope,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default = "default_manual")]
    pub origin: ContextAttachmentOrigin,
    #[serde(default)]
    pub default_include: Option<bool>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddContextLinkInput {
    pub client_request_id: String,
    pub project_id: String,
    pub scope: ContextAttachmentScope,
    #[serde(default)]
    pub session_id: Option<String>,
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default = "default_manual")]
    pub origin: ContextAttachmentOrigin,
    #[serde(default)]
    pub default_include: Option<bool>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateContextAttachmentInput {
    pub client_request_id: String,
    pub attachment_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub note: Option<Option<String>>,
    #[serde(default)]
    pub scope: Option<ContextAttachmentScope>,
    #[serde(default)]
    pub session_id: Option<Option<String>>,
    #[serde(default)]
    pub sort_order: Option<usize>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetContextInclusionInput {
    pub client_request_id: String,
    pub session_id: String,
    pub attachment_ids: Vec<String>,
    pub included: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveContextAttachmentInput {
    pub client_request_id: String,
    pub attachment_id: String,
}
pub type RefreshLinkPreviewInput = RemoveContextAttachmentInput;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenContextAttachmentInput {
    pub attachment_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextAttachmentBytesInput {
    pub attachment_id: String,
    pub variant: String,
}

fn default_manual() -> ContextAttachmentOrigin {
    ContextAttachmentOrigin::Manual
}
pub fn validate_scope(
    scope: ContextAttachmentScope,
    session_id: Option<&str>,
) -> Result<(), String> {
    if (scope == ContextAttachmentScope::Project) != session_id.is_none() {
        Err("Die Anhangsebene passt nicht zur Session-ID.".to_owned())
    } else {
        Ok(())
    }
}
