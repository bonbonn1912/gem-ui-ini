use super::{
    blob_store::ContextBlobStore,
    contracts::*,
    extraction::extract_file,
    mime::sniff_mime,
    prompt::{build_context_parts, ContextAttachmentSnapshot, PromptContextSource, PromptPart},
    repository::{ContextAttachmentRepository, FileInsert, LinkInsert, StoredContextAttachment},
};
use crate::links::normalize_url;
use crate::{
    db::DbPool,
    error::AppError,
    idempotency::{idempotent, ClientRequestRepo},
    links::LinkMetadataFetcher,
};
use rusqlite::OptionalExtension;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

#[derive(Clone)]
pub struct ContextAttachmentService {
    pub blobs: ContextBlobStore,
    pub repository: ContextAttachmentRepository,
    db: DbPool,
    pub client_requests: ClientRequestRepo,
}
impl ContextAttachmentService {
    pub fn new(user_data: impl AsRef<Path>, db: DbPool) -> Result<Self, AppError> {
        let client_requests = ClientRequestRepo::new(db.clone());
        Ok(Self {
            blobs: ContextBlobStore::new(user_data)?,
            repository: ContextAttachmentRepository::new(db.clone()),
            db,
            client_requests,
        })
    }
    pub fn initialize(&self) -> Result<(), AppError> {
        self.blobs.initialize()?;
        let referenced = self.repository.referenced_hashes()?;
        self.blobs.cleanup(&referenced)
    }
    pub fn list(
        &self,
        input: ListContextAttachmentsInput,
    ) -> Result<ContextAttachmentList, AppError> {
        self.assert_target(&input.project_id, input.session_id.as_deref(), None)?;
        self.repository
            .list(&input.project_id, input.session_id.as_deref())
    }
    pub async fn add_files_request(
        &self,
        input: AddContextFilesInput,
    ) -> Result<ContextAttachmentList, AppError> {
        let request = input.client_request_id.clone();
        idempotent(
            &self.client_requests,
            &request,
            "context-attachments.add-files",
            || async { self.add_files(input.clone()) },
        )
        .await
    }
    pub async fn add_link_request(
        &self,
        input: AddContextLinkInput,
    ) -> Result<ContextAttachmentList, AppError> {
        let request = input.client_request_id.clone();
        idempotent(
            &self.client_requests,
            &request,
            "context-attachments.add-link",
            || async { self.add_link(input.clone()) },
        )
        .await
    }
    pub async fn ingest_files_request(
        &self,
        input: AddContextFilesInput,
    ) -> Result<Vec<StoredContextAttachment>, AppError> {
        let request = input.client_request_id.clone();
        let ids: Vec<String> = idempotent(
            &self.client_requests,
            &request,
            "context-attachments.ingest-files",
            || async {
                Ok(self
                    .ingest_files(input.clone())?
                    .into_iter()
                    .map(|value| value.public.id)
                    .collect::<Vec<_>>())
            },
        )
        .await?;
        ids.iter()
            .map(|id| {
                self.repository
                    .get_internal(id, input.session_id.as_deref())
            })
            .collect()
    }
    pub async fn ingest_link_request(
        &self,
        input: AddContextLinkInput,
    ) -> Result<StoredContextAttachment, AppError> {
        let request = input.client_request_id.clone();
        let id: String = idempotent(
            &self.client_requests,
            &request,
            "context-attachments.ingest-link",
            || async { Ok(self.ingest_link(input.clone())?.public.id) },
        )
        .await?;
        self.repository
            .get_internal(&id, input.session_id.as_deref())
    }
    pub async fn update_request(
        &self,
        input: UpdateContextAttachmentInput,
    ) -> Result<ContextAttachmentList, AppError> {
        let request = input.client_request_id.clone();
        idempotent(
            &self.client_requests,
            &request,
            "context-attachments.update",
            || async { self.update(input.clone()) },
        )
        .await
    }
    pub async fn set_inclusion_request(
        &self,
        input: SetContextInclusionInput,
    ) -> Result<ContextAttachmentList, AppError> {
        let request = input.client_request_id.clone();
        idempotent(
            &self.client_requests,
            &request,
            "context-attachments.set-inclusion",
            || async { self.set_inclusion(input.clone()) },
        )
        .await
    }
    pub async fn remove_request(
        &self,
        input: RemoveContextAttachmentInput,
    ) -> Result<ContextAttachmentList, AppError> {
        let request = input.client_request_id.clone();
        idempotent(
            &self.client_requests,
            &request,
            "context-attachments.remove",
            || async { self.remove(input.clone()) },
        )
        .await
    }
    pub async fn refresh_link_preview_request(
        &self,
        input: RefreshLinkPreviewInput,
        fetcher: Arc<dyn LinkMetadataFetcher>,
    ) -> Result<ContextAttachmentList, AppError> {
        let request = input.client_request_id.clone();
        let service = self.clone();
        let attachment_id = input.attachment_id.clone();
        idempotent(
            &self.client_requests,
            &request,
            "context-attachments.refresh-link-preview",
            || async move {
                tokio::task::spawn_blocking(move || {
                    service.refresh_link_preview(&attachment_id, fetcher.as_ref())
                })
                .await
                .map_err(|error| {
                    AppError::Internal(format!("Link-Vorschau wurde unterbrochen: {error}"))
                })?
            },
        )
        .await
    }
    pub fn refresh_link_preview(
        &self,
        attachment_id: &str,
        fetcher: &dyn LinkMetadataFetcher,
    ) -> Result<ContextAttachmentList, AppError> {
        let old = self.repository.get_internal(attachment_id, None)?;
        let link = old
            .public
            .link
            .clone()
            .ok_or_else(|| AppError::Validation("Dieser Anhang ist kein Link.".to_owned()))?;
        let fetched_at = now_iso();
        let metadata = match fetcher.fetch(&link.url) {
            Ok(metadata) => metadata,
            Err(error) => {
                let state = if matches!(error, AppError::Validation(_)) {
                    LinkPreviewState::Blocked
                } else {
                    LinkPreviewState::Failed
                };
                if old.preview_image_file.is_some() {
                    self.blobs.remove_link_preview(attachment_id)?;
                }
                self.repository.update_link_preview(
                    attachment_id,
                    state,
                    None,
                    None,
                    None,
                    None,
                    Some(&error.to_string()),
                    Some(&fetched_at),
                )?;
                return self
                    .repository
                    .list(&old.public.project_id, old.public.session_id.as_deref());
            }
        };
        let state = if metadata.unauthorized {
            LinkPreviewState::Unauthorized
        } else {
            LinkPreviewState::Ready
        };
        let image_file = match metadata.image {
            Some(image) => Some(
                self.blobs
                    .write_link_preview_image(attachment_id, &image.bytes, &image.extension)?
                    .to_string_lossy()
                    .into_owned(),
            ),
            None => None,
        };
        if image_file.is_none() && old.preview_image_file.is_some() {
            self.blobs.remove_link_preview(attachment_id)?;
        }
        self.repository.update_link_preview(
            attachment_id,
            state,
            metadata.title.as_deref(),
            metadata.description.as_deref(),
            metadata.site_name.as_deref(),
            image_file.as_deref(),
            None,
            Some(&fetched_at),
        )?;
        self.repository
            .list(&old.public.project_id, old.public.session_id.as_deref())
    }
    pub fn ingest_files(
        &self,
        input: AddContextFilesInput,
    ) -> Result<Vec<StoredContextAttachment>, AppError> {
        validate_scope(input.scope, input.session_id.as_deref()).map_err(AppError::Validation)?;
        self.assert_target(
            &input.project_id,
            input.session_id.as_deref(),
            Some(input.scope),
        )?;
        if input.paths.len() > 20 {
            return Err(AppError::Validation(
                "höchstens 20 Dateien pro Vorgang".to_owned(),
            ));
        }
        let mut created = Vec::<(String, String)>::new();
        let operation = (|| {
            let mut out = Vec::new();
            for path in input.paths.clone() {
                if path.is_empty() || path.chars().count() > 32_768 {
                    return Err(AppError::Validation(
                        "Dateipfade müssen zwischen 1 und 32.768 Zeichen enthalten.".to_owned(),
                    ));
                }
                let blob = self.blobs.ingest(&path)?;
                if let Some(existing) = self.repository.find_duplicate(
                    &input.project_id,
                    input.session_id.as_deref(),
                    &blob.sha256,
                )? {
                    out.push(existing);
                    continue;
                }
                let display = safe_name(
                    Path::new(&path)
                        .file_name()
                        .and_then(|v| v.to_str())
                        .unwrap_or("Anhang"),
                );
                let mime = sniff_mime(&blob.sniff_bytes, &display);
                let value = self.repository.insert_file(FileInsert {
                    id: Uuid::new_v4().to_string(),
                    project_id: input.project_id.clone(),
                    scope: input.scope,
                    session_id: input.session_id.clone(),
                    title: display.clone(),
                    origin: input.origin,
                    display_name: display,
                    mime_type: mime,
                    size: blob.size,
                    sha256: blob.sha256,
                    storage_dir: blob.storage_dir.to_string_lossy().into_owned(),
                    file_name: blob.file_name,
                    default_include: input
                        .default_include
                        .unwrap_or(input.scope == ContextAttachmentScope::Session),
                    created_at: now_iso(),
                })?;
                let file = self
                    .blobs
                    .blob_path(value.public.file.as_ref().unwrap().sha256.as_str())?;
                let file_hash = value.public.file.as_ref().unwrap().sha256.clone();
                created.push((value.public.id.clone(), file_hash.clone()));
                let extracted = extract_file(&file, &value.public.file.as_ref().unwrap().mime_type);
                if matches!(
                    extracted.state,
                    ExtractionState::Ready | ExtractionState::Empty
                ) {
                    self.blobs.write_derived_text(&file_hash, &extracted.text)?;
                }
                self.repository.update_extraction(
                    &value.public.id,
                    extracted.state,
                    extracted.extracted_chars,
                    extracted.page_count,
                    extracted.error.as_deref(),
                )?;
                out.push(
                    self.repository
                        .get_internal(&value.public.id, input.session_id.as_deref())?,
                );
            }
            Ok::<_, AppError>(out)
        })();
        match operation {
            Ok(out) => Ok(out),
            Err(error) => {
                self.rollback_created_files(&created);
                Err(error)
            }
        }
    }

    fn rollback_created_files(&self, created: &[(String, String)]) {
        for (id, sha256) in created {
            let _ = self.repository.remove(id);
            if self.repository.count_file_references(sha256).unwrap_or(1) == 0 {
                let _ = self.blobs.remove_unreferenced(sha256);
            }
        }
    }
    pub fn add_files(
        &self,
        input: AddContextFilesInput,
    ) -> Result<ContextAttachmentList, AppError> {
        self.ingest_files(input.clone())?;
        self.repository
            .list(&input.project_id, input.session_id.as_deref())
    }
    pub fn ingest_link(
        &self,
        input: AddContextLinkInput,
    ) -> Result<StoredContextAttachment, AppError> {
        validate_scope(input.scope, input.session_id.as_deref()).map_err(AppError::Validation)?;
        self.assert_target(
            &input.project_id,
            input.session_id.as_deref(),
            Some(input.scope),
        )?;
        let normalized = normalize_url(&input.url)?;
        if let Some(existing) = self.repository.find_duplicate(
            &input.project_id,
            input.session_id.as_deref(),
            &normalized.url,
        )? {
            return Ok(existing);
        }
        let title = match input.title {
            Some(title) => {
                if title.trim().is_empty() || title.chars().count() > 200 {
                    return Err(AppError::Validation(
                        "title must contain 1 to 200 characters".to_owned(),
                    ));
                }
                safe_name(&title)
            }
            None => title_from_url(&normalized.url, &normalized.host),
        };
        self.repository.insert_link(LinkInsert {
            id: Uuid::new_v4().to_string(),
            project_id: input.project_id,
            scope: input.scope,
            session_id: input.session_id,
            title,
            origin: input.origin,
            url: normalized.url.clone(),
            normalized_url: normalized.url,
            host: normalized.host,
            default_include: input
                .default_include
                .unwrap_or(input.scope == ContextAttachmentScope::Session),
            created_at: now_iso(),
        })
    }
    pub fn add_link(&self, input: AddContextLinkInput) -> Result<ContextAttachmentList, AppError> {
        let project = input.project_id.clone();
        let session = input.session_id.clone();
        self.ingest_link(input)?;
        self.repository.list(&project, session.as_deref())
    }
    pub fn update(
        &self,
        input: UpdateContextAttachmentInput,
    ) -> Result<ContextAttachmentList, AppError> {
        if let Some(title) = input.title.as_deref() {
            if title.trim().is_empty() || title.chars().count() > 200 {
                return Err(AppError::Validation(
                    "title must contain 1 to 200 characters".to_owned(),
                ));
            }
        }
        let title = input.title.as_deref().map(str::trim);
        if let Some(Some(note)) = input.note.as_ref() {
            if note.chars().count() > 2_000 {
                return Err(AppError::Validation(
                    "note darf höchstens 2.000 Zeichen enthalten.".to_owned(),
                ));
            }
        }
        let old = self.repository.get_internal(&input.attachment_id, None)?;
        let scope = input.scope.unwrap_or(old.public.scope);
        let session_owned = input
            .session_id
            .clone()
            .unwrap_or(old.public.session_id.clone());
        let session = session_owned.as_deref();
        self.assert_target(&old.public.project_id, session, Some(scope))?;
        self.repository.update(
            &old.public.id,
            title,
            input.note.as_ref().map(|v| v.as_ref().map(String::as_str)),
            input.scope,
            input.session_id.as_ref().map(|v| v.as_deref()),
            input.sort_order,
            &now_iso(),
        )?;
        self.repository.list(&old.public.project_id, session)
    }
    pub fn set_inclusion(
        &self,
        input: SetContextInclusionInput,
    ) -> Result<ContextAttachmentList, AppError> {
        let project = self.session_project(&input.session_id)?;
        if input.attachment_ids.len() > 100 {
            return Err(AppError::Validation(
                "höchstens 100 Anhänge können gleichzeitig geändert werden.".to_owned(),
            ));
        }
        let visible = self.repository.list(&project, Some(&input.session_id))?;
        let mut ids = input.attachment_ids;
        if ids.is_empty() && !input.included {
            ids = visible
                .project_attachments
                .iter()
                .chain(visible.session_attachments.iter())
                .map(|a| a.id.clone())
                .collect();
        }
        let allowed: std::collections::HashSet<_> = visible
            .project_attachments
            .iter()
            .chain(visible.session_attachments.iter())
            .map(|a| a.id.as_str())
            .collect();
        if ids.iter().any(|id| !allowed.contains(id.as_str())) {
            return Err(AppError::Validation(
                "Mindestens ein Anhang gehört nicht zu dieser Session.".to_owned(),
            ));
        }
        self.repository
            .set_inclusion(&input.session_id, &ids, input.included, &now_iso())?;
        self.repository.list(&project, Some(&input.session_id))
    }
    pub fn remove(
        &self,
        input: RemoveContextAttachmentInput,
    ) -> Result<ContextAttachmentList, AppError> {
        let old = self
            .repository
            .remove(&input.attachment_id)?
            .ok_or_else(|| AppError::NotFound("Context attachment was not found".to_owned()))?;
        let result = self
            .repository
            .list(&old.public.project_id, old.public.session_id.as_deref())?;
        if let Some(file) = old.public.file {
            if self.repository.count_file_references(&file.sha256)? == 0 {
                self.blobs.remove_unreferenced(&file.sha256)?;
            }
        }
        if old.public.link.is_some() {
            self.blobs.remove_link_preview(&old.public.id)?;
        }
        Ok(result)
    }
    pub fn get_bytes(&self, input: ContextAttachmentBytesInput) -> Result<Vec<u8>, AppError> {
        let old = self.repository.get_internal(&input.attachment_id, None)?;
        match input.variant.as_str() {
            "link_image" => {
                let path = old.preview_image_file.ok_or_else(|| {
                    AppError::NotFound("Für diesen Link gibt es kein Vorschaubild.".to_owned())
                })?;
                let safe = self
                    .blobs
                    .assert_readable_file(path, &self.blobs.link_previews_directory)?;
                Ok(fs::read(safe)?)
            }
            "text_excerpt" => {
                let file = old.public.file.ok_or_else(|| {
                    AppError::Validation("Dieser Anhang enthält keine Datei.".to_owned())
                })?;
                if !matches!(
                    file.extraction_state,
                    ExtractionState::Ready | ExtractionState::Empty
                ) {
                    return Err(AppError::Conflict(
                        "Für diesen Anhang ist noch kein Text verfügbar.".to_owned(),
                    ));
                }
                let path = self.blobs.derived_text_path(&file.sha256)?;
                let safe = self
                    .blobs
                    .assert_readable_file(path, &self.blobs.derived_directory)?;
                Ok(fs::read(safe)?)
            }
            "original" => {
                let file = old.public.file.ok_or_else(|| {
                    AppError::Validation("Dieser Anhang enthält keine Datei.".to_owned())
                })?;
                if !file.renderable {
                    return Err(AppError::Validation(
                        "Originalbytes werden nur für geprüfte Bildformate bereitgestellt."
                            .to_owned(),
                    ));
                }
                let path = self.blobs.blob_path(&file.sha256)?;
                let safe = self
                    .blobs
                    .assert_readable_file(path, &self.blobs.blobs_directory)?;
                Ok(fs::read(safe)?)
            }
            "thumbnail" => {
                let file = old.public.file.ok_or_else(|| {
                    AppError::Validation("Dieser Anhang enthält keine Datei.".to_owned())
                })?;
                if !file.renderable {
                    return Err(AppError::Validation(
                        "Vorschaubilder sind nur für geprüfte Bildformate verfügbar.".to_owned(),
                    ));
                }
                let path = self.blobs.blob_path(&file.sha256)?;
                let safe = self
                    .blobs
                    .assert_readable_file(path, &self.blobs.blobs_directory)?;
                let bytes = fs::read(safe)?;
                let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
                    .with_guessed_format()
                    .map_err(|_| {
                        AppError::Validation("Bildformat konnte nicht erkannt werden.".to_owned())
                    })?;
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(16_384);
                limits.max_image_height = Some(16_384);
                limits.max_alloc = Some(64 * 1024 * 1024);
                reader.limits(limits);
                let source = reader.decode().map_err(|_| {
                    AppError::Validation("Bild konnte nicht dekodiert werden.".to_owned())
                })?;
                let thumbnail = source.thumbnail(512, 512);
                let mut output = std::io::Cursor::new(Vec::new());
                thumbnail
                    .write_to(&mut output, image::ImageFormat::Png)
                    .map_err(|_| {
                        AppError::Internal("Vorschaubild konnte nicht erzeugt werden.".to_owned())
                    })?;
                Ok(output.into_inner())
            }
            _ => Err(AppError::Validation(
                "Unbekannte Attachment-Variante".to_owned(),
            )),
        }
    }
    pub fn original_path(&self, attachment_id: &str) -> Result<PathBuf, AppError> {
        let attachment = self.repository.get_internal(attachment_id, None)?;
        let file = attachment
            .public
            .file
            .ok_or_else(|| AppError::Validation("Dieser Anhang enthält keine Datei.".to_owned()))?;
        let path = self.blobs.blob_path(&file.sha256)?;
        self.blobs
            .assert_readable_file(path, &self.blobs.blobs_directory)
    }
    pub fn build_prompt_context(
        &self,
        project_id: &str,
        session_id: &str,
        ids: &[String],
        images_supported: bool,
    ) -> Result<(Vec<PromptPart>, Vec<ContextAttachmentSnapshot>), AppError> {
        if ids.len() > MAX_CONTEXT_ATTACHMENTS_PER_PROMPT {
            return Err(AppError::Validation(format!("Pro Prompt sind höchstens {MAX_CONTEXT_ATTACHMENTS_PER_PROMPT} Kontextanhänge möglich.")));
        }
        let list = self.repository.list(project_id, Some(session_id))?;
        let visible: std::collections::HashSet<_> = list
            .project_attachments
            .iter()
            .chain(list.session_attachments.iter())
            .map(|a| a.id.as_str())
            .collect();
        let mut unique = Vec::new();
        for id in ids {
            if !visible.contains(id.as_str()) {
                return Err(AppError::Validation("Mindestens ein Kontextanhang gehört nicht zu diesem Projekt oder dieser Session.".to_owned()));
            }
            if !unique.contains(id) {
                unique.push(id.clone());
            }
        }
        let mut sources = Vec::new();
        for id in unique {
            let stored = self.repository.get_internal(&id, Some(session_id))?;
            let mut text = None;
            let mut image = None;
            if let Some(file) = &stored.public.file {
                if file.renderable {
                    let path = self.blobs.blob_path(&file.sha256)?;
                    image = Some(crate::attachments::base64_for_internal(&fs::read(
                        self.blobs
                            .assert_readable_file(path, &self.blobs.blobs_directory)?,
                    )?));
                } else if matches!(
                    file.extraction_state,
                    ExtractionState::Ready | ExtractionState::Empty
                ) {
                    let path = self.blobs.derived_text_path(&file.sha256)?;
                    text = Some(
                        String::from_utf8(fs::read(
                            self.blobs
                                .assert_readable_file(path, &self.blobs.derived_directory)?,
                        )?)
                        .map_err(|_| {
                            AppError::Validation("Extrahierter Text ist nicht UTF-8".to_owned())
                        })?,
                    );
                }
            }
            sources.push(PromptContextSource {
                attachment: stored.public,
                text,
                image_data: image,
                resource_link: None,
            });
        }
        build_context_parts(&sources, images_supported).map_err(AppError::Validation)
    }
    fn assert_target(
        &self,
        project: &str,
        session: Option<&str>,
        scope: Option<ContextAttachmentScope>,
    ) -> Result<(), AppError> {
        let exists: i64 = self.db.connection()?.query_row(
            "SELECT COUNT(*) FROM projects WHERE id=?1",
            [project],
            |r| r.get(0),
        )?;
        if exists != 1 {
            return Err(AppError::NotFound(format!(
                "Project {project} was not found"
            )));
        }
        if let Some(session) = session {
            let owner: Option<String> = self
                .db
                .connection()?
                .query_row(
                    "SELECT project_id FROM sessions WHERE id=?1",
                    [session],
                    |r| r.get(0),
                )
                .optional()?;
            if owner.as_deref() != Some(project) {
                return Err(AppError::Validation(
                    "Die Session gehört nicht zu diesem Projekt.".to_owned(),
                ));
            }
        }
        if let Some(scope) = scope {
            validate_scope(scope, session).map_err(AppError::Validation)?;
        }
        Ok(())
    }
    fn session_project(&self, session: &str) -> Result<String, AppError> {
        self.db
            .connection()?
            .query_row(
                "SELECT project_id FROM sessions WHERE id=?1",
                [session],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("Session was not found".to_owned()))
    }
}
fn safe_name(v: &str) -> String {
    let s: String = v.chars().filter(|c| !c.is_control()).collect();
    let s = s.trim();
    if s.is_empty() {
        "Anhang".to_owned()
    } else {
        s.chars().take(200).collect()
    }
}
fn title_from_url(url: &str, host: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.rsplit('/')
        .next()
        .filter(|v| !v.is_empty())
        .map(|value| safe_name(&decode_percent_component(value)))
        .unwrap_or_else(|| host.to_owned())
}
fn decode_percent_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}
fn now_iso() -> String {
    rfc3339_now()
}
fn rfc3339_now() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = seconds / 86_400;
    let mut year = 1970u64;
    let mut remaining = days;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let length = if leap { 366 } else { 365 };
        if remaining < length {
            break;
        }
        remaining -= length;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u64;
    for length in lengths {
        if remaining < length {
            break;
        }
        remaining -= length;
        month += 1;
    }
    let day = remaining + 1;
    let hour = (seconds % 86_400) / 3_600;
    let minute = (seconds % 3_600) / 60;
    let second = seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}
