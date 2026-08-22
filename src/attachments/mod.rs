use crate::{
    db::DbPool,
    error::AppError,
    idempotency::{idempotent, ClientRequestRepo},
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;
pub mod commands;

pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_PROMPT_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_PROMPT_ATTACHMENTS: usize = 4;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageMimeType {
    Png,
    Jpeg,
    Webp,
    Gif,
}
impl ImageMimeType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Gif => "image/gif",
        }
    }
    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
            Self::Gif => "gif",
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentStatus {
    Staged,
    Sent,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attachment {
    pub id: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub display_name: String,
    pub mime_type: String,
    pub size: u64,
    pub sha256: String,
    pub status: AttachmentStatus,
    pub created_at: String,
}
#[derive(Clone, Debug)]
pub struct StoredAttachment {
    pub public: Attachment,
    pub storage_path: PathBuf,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PickImagesInput {
    pub client_request_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageDroppedPathInput {
    pub client_request_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub paths: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipboardImageInput {
    pub client_request_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub display_name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentPreviewInput {
    pub attachment_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoveAttachmentInput {
    pub client_request_id: String,
    pub attachment_id: String,
}

#[derive(Clone)]
pub struct AttachmentRepository {
    db: DbPool,
}
impl AttachmentRepository {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }
    pub fn database(&self) -> DbPool {
        self.db.clone()
    }
    pub fn find(&self, id: &str) -> Result<Option<StoredAttachment>, AppError> {
        let c = self.db.connection()?;
        c.query_row("SELECT id,session_id,turn_id,display_name,mime_type,size,sha256,storage_path,status,created_at FROM attachments WHERE id=?1",[id],|r|{let status:String=r.get(8)?;Ok(StoredAttachment{public:Attachment{id:r.get(0)?,session_id:r.get(1)?,turn_id:r.get(2)?,display_name:r.get(3)?,mime_type:r.get(4)?,size:r.get::<_,i64>(5)? as u64,sha256:r.get(6)?,status:if status=="sent"{AttachmentStatus::Sent}else{AttachmentStatus::Staged},created_at:r.get(9)?},storage_path:PathBuf::from(r.get::<_,String>(7)?)} )}).optional().map_err(AppError::from)
    }
    pub fn insert(&self, v: &StoredAttachment) -> Result<(), AppError> {
        self.db.connection()?.execute("INSERT INTO attachments(id,session_id,turn_id,display_name,mime_type,size,sha256,storage_path,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'staged',?9)",rusqlite::params![v.public.id,v.public.session_id,v.public.turn_id,v.public.display_name,v.public.mime_type,v.public.size as i64,v.public.sha256,v.storage_path.to_string_lossy(),v.public.created_at])?;
        Ok(())
    }
    pub fn remove(&self, id: &str) -> Result<Option<StoredAttachment>, AppError> {
        let old = self.find(id)?;
        if old.is_some() {
            self.db
                .connection()?
                .execute("DELETE FROM attachments WHERE id=?1", [id])?;
        }
        Ok(old)
    }
    pub fn mark_sent(
        &self,
        id: &str,
        session: &str,
        turn: &str,
    ) -> Result<StoredAttachment, AppError> {
        let changed=self.db.connection()?.execute("UPDATE attachments SET session_id=?1,turn_id=?2,status='sent' WHERE id=?3 AND status='staged'",rusqlite::params![session,turn,id])?;
        if changed != 1 {
            return Err(AppError::Conflict(
                "Attachment is missing or is no longer staged".to_owned(),
            ));
        }
        self.find(id)?
            .ok_or_else(|| AppError::NotFound("Attachment was deleted".to_owned()))
    }
}

#[derive(Clone)]
pub struct AttachmentService {
    directory: PathBuf,
    repository: AttachmentRepository,
    client_requests: ClientRequestRepo,
}
impl AttachmentService {
    pub fn new(
        app_data: impl AsRef<Path>,
        repository: AttachmentRepository,
    ) -> Result<Self, AppError> {
        let root = app_data.as_ref();
        if !root.is_absolute() {
            return Err(AppError::Validation(
                "appDataDirectory must be absolute".to_owned(),
            ));
        }
        let directory = root.join("attachments");
        fs::create_dir_all(&directory)?;
        Ok(Self {
            directory,
            client_requests: ClientRequestRepo::new(repository.database()),
            repository,
        })
    }
    pub fn repository(&self) -> &AttachmentRepository {
        &self.repository
    }
    pub async fn stage_dropped_paths(
        &self,
        input: StageDroppedPathInput,
    ) -> Result<Vec<Attachment>, AppError> {
        let paths = input.paths.clone();
        let session = input.session_id.clone();
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "attachments.stage-dropped",
            || async {
                if paths.is_empty() || paths.len() > MAX_PROMPT_ATTACHMENTS {
                    return Err(AppError::Validation(
                        "Es müssen 1 bis 4 Bildpfade angegeben werden.".to_owned(),
                    ));
                }
                if paths
                    .iter()
                    .any(|path| path.is_empty() || path.chars().count() > 32_768)
                {
                    return Err(AppError::Validation(
                        "Dateipfade müssen zwischen 1 und 32.768 Zeichen enthalten.".to_owned(),
                    ));
                }
                self.stage_many(
                    paths.iter().map(String::as_str).collect::<Vec<_>>(),
                    session,
                )
            },
        )
        .await
    }
    pub async fn stage_picked_paths(
        &self,
        input: PickImagesInput,
        paths: Vec<PathBuf>,
    ) -> Result<Vec<Attachment>, AppError> {
        let session = input.session_id.clone();
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "attachments.pick",
            || async {
                if paths.len() > MAX_PROMPT_ATTACHMENTS {
                    return Err(AppError::Validation(
                        "Es können höchstens 4 Bilder ausgewählt werden.".to_owned(),
                    ));
                }
                if paths.iter().any(|path| {
                    !path.is_absolute() || path.as_os_str().to_string_lossy().len() > 32_768
                }) {
                    return Err(AppError::Validation(
                        "Dateipfade müssen absolut sein und höchstens 32.768 Bytes enthalten."
                            .to_owned(),
                    ));
                }
                self.stage_many(
                    paths.iter().map(PathBuf::as_path).collect::<Vec<_>>(),
                    session,
                )
            },
        )
        .await
    }
    pub async fn stage_clipboard_image(
        &self,
        input: ClipboardImageInput,
    ) -> Result<Attachment, AppError> {
        let bytes = input.bytes.clone();
        let display_name = input.display_name.clone();
        let mime_type = input.mime_type.clone();
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "attachments.stage-clipboard",
            || async {
                self.stage_bytes(
                    &bytes,
                    Some(&display_name),
                    Some(&mime_type),
                    input.session_id.clone(),
                )
            },
        )
        .await
    }
    pub async fn remove_request(
        &self,
        input: RemoveAttachmentInput,
    ) -> Result<AttachmentVoidResult, AppError> {
        let attachment_id = input.attachment_id.clone();
        idempotent(
            &self.client_requests,
            &input.client_request_id,
            "attachments.remove",
            || async {
                self.remove(&attachment_id)?;
                Ok(AttachmentVoidResult { ok: true })
            },
        )
        .await
    }
    pub fn stage_file(
        &self,
        path: impl AsRef<Path>,
        session: Option<String>,
    ) -> Result<Attachment, AppError> {
        let p = path.as_ref();
        if !p.is_absolute() {
            return Err(AppError::Validation(
                "Bildpfade müssen absolut sein.".to_owned(),
            ));
        }
        if p.as_os_str().to_string_lossy().len() > 32_768 {
            return Err(AppError::Validation("Der Bildpfad ist zu lang.".to_owned()));
        }
        let m = fs::symlink_metadata(p)?;
        if !m.file_type().is_file() {
            return Err(AppError::Validation(
                "Der Anhang ist keine reguläre Datei.".to_owned(),
            ));
        }
        if m.len() == 0 || m.len() > MAX_IMAGE_BYTES as u64 {
            return Err(AppError::Validation("Bildgröße ist unzulässig.".to_owned()));
        }
        let mut f = fs::File::open(p)?;
        let mut bytes = Vec::with_capacity(m.len() as usize);
        f.read_to_end(&mut bytes)?;
        self.stage_bytes(
            &bytes,
            p.file_name().and_then(|v| v.to_str()),
            None,
            session,
        )
    }
    fn stage_many<P: AsRef<Path>>(
        &self,
        paths: Vec<P>,
        session: Option<String>,
    ) -> Result<Vec<Attachment>, AppError> {
        let mut staged = Vec::with_capacity(paths.len());
        for path in paths {
            match self.stage_file(path, session.clone()) {
                Ok(value) => staged.push(value),
                Err(error) => {
                    for value in &staged {
                        let _ = self.remove(&value.id);
                    }
                    return Err(error);
                }
            }
        }
        Ok(staged)
    }
    pub fn stage_bytes(
        &self,
        bytes: &[u8],
        display: Option<&str>,
        declared: Option<&str>,
        session: Option<String>,
    ) -> Result<Attachment, AppError> {
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err(AppError::Validation("Bildgröße ist unzulässig.".to_owned()));
        }
        let mime = detect_image_mime(bytes).ok_or_else(|| {
            AppError::Validation(
                "Nur PNG-, JPEG-, WebP- und GIF-Bilder werden unterstützt.".to_owned(),
            )
        })?;
        if let Some(declared) = declared {
            if declared != "application/octet-stream" && declared != mime.as_str() {
                return Err(AppError::Validation(
                    "Der angegebene Dateityp stimmt nicht mit dem Bildinhalt überein.".to_owned(),
                ));
            }
        }
        let id = Uuid::new_v4().to_string();
        let path = self.directory.join(format!("{id}.{}", mime.extension()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            let _ = fs::remove_file(&path);
            return Err(error.into());
        }
        let value = Attachment {
            id: id.clone(),
            session_id: session,
            turn_id: None,
            display_name: safe_name(display.unwrap_or("Bild")),
            mime_type: mime.as_str().to_owned(),
            size: bytes.len() as u64,
            sha256: sha256_hex(bytes),
            status: AttachmentStatus::Staged,
            created_at: now_iso(),
        };
        let stored = StoredAttachment {
            public: value.clone(),
            storage_path: path.clone(),
        };
        if let Err(error) = self.repository.insert(&stored) {
            let _ = fs::remove_file(path);
            return Err(error);
        }
        Ok(value)
    }
    pub fn preview_bytes(&self, id: &str) -> Result<Vec<u8>, AppError> {
        let value = self
            .repository
            .find(id)?
            .ok_or_else(|| AppError::NotFound("Der Anhang wurde nicht gefunden.".to_owned()))?;
        let bytes = read_bounded(&value.storage_path, MAX_IMAGE_BYTES)?;
        if bytes.len() as u64 != value.public.size
            || detect_image_mime(&bytes).map(|m| m.as_str())
                != Some(value.public.mime_type.as_str())
        {
            return Err(AppError::Validation(
                "Der gespeicherte Anhang ist ungültig.".to_owned(),
            ));
        }
        Ok(bytes)
    }
    pub fn prompt_images(&self, ids: &[String]) -> Result<Vec<PromptImage>, AppError> {
        let ids = unique(ids);
        if ids.is_empty() || ids.len() > MAX_PROMPT_ATTACHMENTS {
            return Err(AppError::Validation(format!(
                "Pro Nachricht sind maximal {MAX_PROMPT_ATTACHMENTS} Bilder erlaubt."
            )));
        }
        let mut total = 0;
        let mut out = Vec::new();
        for id in ids {
            let value = self
                .repository
                .find(&id)?
                .ok_or_else(|| AppError::NotFound("Der Anhang wurde nicht gefunden.".to_owned()))?;
            let bytes = read_bounded(&value.storage_path, MAX_IMAGE_BYTES)?;
            if bytes.len() as u64 != value.public.size
                || detect_image_mime(&bytes).map(|m| m.as_str())
                    != Some(value.public.mime_type.as_str())
            {
                return Err(AppError::Validation(
                    "Der gespeicherte Anhang ist ungültig.".to_owned(),
                ));
            }
            total += bytes.len();
            if total > MAX_PROMPT_ATTACHMENT_BYTES {
                return Err(AppError::Validation(
                    "Alle Bilder zusammen sind zu groß.".to_owned(),
                ));
            }
            out.push(PromptImage {
                id,
                mime_type: value.public.mime_type,
                data: base64_for_internal(&bytes),
            });
        }
        Ok(out)
    }
    pub fn remove(&self, id: &str) -> Result<(), AppError> {
        if let Some(value) = self.repository.remove(id)? {
            let _ = fs::remove_file(value.storage_path);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptImage {
    pub id: String,
    pub mime_type: String,
    pub data: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentVoidResult {
    pub ok: bool,
}
pub fn detect_image_mime(bytes: &[u8]) -> Option<ImageMimeType> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageMimeType::Png)
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(ImageMimeType::Jpeg)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageMimeType::Webp)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageMimeType::Gif)
    } else {
        None
    }
}
fn safe_name(value: &str) -> String {
    let value: String = value.chars().filter(|c| !c.is_control()).collect();
    let value = value.trim();
    if value.is_empty() {
        "Bild".to_owned()
    } else {
        value.chars().take(200).collect()
    }
}
fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, AppError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() > limit as u64 {
        return Err(AppError::Validation(
            "Der gespeicherte Anhang ist ungültig.".to_owned(),
        ));
    }
    let mut file = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}
fn unique(values: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    for value in values {
        if !result.contains(value) {
            result.push(value.clone());
        }
    }
    result
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

pub fn sha256_hex(data: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(data);
    digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(crate) fn base64_for_internal(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | (chunk.get(2).copied().unwrap_or(0) as u32);
        out.push(TABLE[(value >> 18) as usize & 63] as char);
        out.push(TABLE[(value >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(value >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[value as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{base64_for_internal, detect_image_mime, ImageMimeType};

    #[test]
    fn image_magic_detection_does_not_trust_extensions() {
        assert_eq!(
            detect_image_mime(b"\x89PNG\r\n\x1a\n"),
            Some(ImageMimeType::Png)
        );
        assert_eq!(detect_image_mime(b"not-an-image"), None);
    }

    #[test]
    fn internal_base64_is_standard_padded_encoding() {
        assert_eq!(base64_for_internal(b"hello"), "aGVsbG8=");
    }
}
