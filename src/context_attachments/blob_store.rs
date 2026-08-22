use super::contracts::MAX_CONTEXT_FILE_BYTES;
use crate::{attachments::sha256_hex, error::AppError};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const SNIFF_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug)]
pub struct StoredBlob {
    pub sha256: String,
    pub size: u64,
    pub storage_dir: PathBuf,
    pub file_name: String,
    pub sniff_bytes: Vec<u8>,
}

#[derive(Clone)]
pub struct ContextBlobStore {
    pub root_directory: PathBuf,
    pub blobs_directory: PathBuf,
    pub derived_directory: PathBuf,
    pub link_previews_directory: PathBuf,
}
impl ContextBlobStore {
    pub fn new(user_data_directory: impl AsRef<Path>) -> Result<Self, AppError> {
        let root = user_data_directory.as_ref();
        if !root.is_absolute() {
            return Err(AppError::Validation("userData must be absolute".to_owned()));
        }
        let root_directory = root.join("context-attachments");
        Ok(Self {
            blobs_directory: root_directory.join("blobs"),
            derived_directory: root_directory.join("derived"),
            link_previews_directory: root_directory.join("link-previews"),
            root_directory,
        })
    }
    pub fn initialize(&self) -> Result<(), AppError> {
        for dir in [
            &self.blobs_directory,
            &self.derived_directory,
            &self.link_previews_directory,
        ] {
            fs::create_dir_all(dir)?;
            set_private(dir)?;
        }
        Ok(())
    }
    pub fn cleanup(&self, referenced_hashes: &HashSet<String>) -> Result<(), AppError> {
        self.initialize()?;
        for prefix in fs::read_dir(&self.blobs_directory)? {
            let prefix = prefix?;
            let prefix_name = prefix.file_name().to_string_lossy().into_owned();
            if !prefix.file_type()?.is_dir()
                || prefix_name.len() != 2
                || !prefix_name.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                continue;
            }
            for entry in fs::read_dir(prefix.path())? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type()?.is_file()
                    && name.len() == 64
                    && name.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && !referenced_hashes.contains(&name)
                {
                    fs::remove_file(entry.path())?;
                }
            }
        }
        for entry in fs::read_dir(&self.derived_directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type()?.is_dir()
                && name.len() == 64
                && name.bytes().all(|byte| byte.is_ascii_hexdigit())
                && !referenced_hashes.contains(&name)
            {
                fs::remove_dir_all(entry.path())?;
            }
        }
        Ok(())
    }
    pub fn ingest(&self, file_path: impl AsRef<Path>) -> Result<StoredBlob, AppError> {
        self.initialize()?;
        let source_path = file_path.as_ref();
        if !source_path.is_absolute() {
            return Err(AppError::Validation(
                "Dateipfade müssen absolut sein.".to_owned(),
            ));
        }
        let metadata = fs::symlink_metadata(source_path)?;
        if !metadata.file_type().is_file() {
            return Err(AppError::Validation(
                "Nur reguläre Dateien können angehängt werden.".to_owned(),
            ));
        }
        if metadata.len() == 0 || metadata.len() > MAX_CONTEXT_FILE_BYTES {
            return Err(AppError::Validation(format!(
                "Dateien müssen zwischen 1 Byte und {} MiB groß sein.",
                MAX_CONTEXT_FILE_BYTES / 1024 / 1024
            )));
        }
        let mut source = File::open(source_path)?;
        let temporary = self
            .blobs_directory
            .join(format!(".incoming-{}", Uuid::new_v4()));
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let mut hash_input = Vec::with_capacity(metadata.len() as usize);
        let mut sniff = Vec::with_capacity(SNIFF_BYTES);
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            if hash_input.len() + (read) > MAX_CONTEXT_FILE_BYTES as usize {
                let _ = fs::remove_file(&temporary);
                return Err(AppError::Validation("Datei ist zu groß.".to_owned()));
            }
            target.write_all(&buffer[..read])?;
            hash_input.extend_from_slice(&buffer[..read]);
            if sniff.len() < SNIFF_BYTES {
                let n = (SNIFF_BYTES - sniff.len()).min(read);
                sniff.extend_from_slice(&buffer[..n]);
            }
        }
        target.sync_all()?;
        drop(target);
        let sha256 = sha256_hex(&hash_input);
        let storage_dir = self.blobs_directory.join(&sha256[..2]);
        fs::create_dir_all(&storage_dir)?;
        set_private(&storage_dir)?;
        let destination = storage_dir.join(&sha256);
        if destination.exists() {
            fs::remove_file(&temporary)?;
        } else {
            fs::rename(&temporary, &destination)?;
        }
        Ok(StoredBlob {
            sha256,
            size: metadata.len(),
            storage_dir,
            file_name: destination
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            sniff_bytes: sniff,
        })
    }
    pub fn blob_path(&self, sha256: &str) -> Result<PathBuf, AppError> {
        assert_hash(sha256)?;
        self.inside(
            &self.blobs_directory,
            self.blobs_directory.join(&sha256[..2]).join(sha256),
        )
    }
    pub fn derived_text_path(&self, sha256: &str) -> Result<PathBuf, AppError> {
        assert_hash(sha256)?;
        self.inside(
            &self.derived_directory,
            self.derived_directory.join(sha256).join("text.txt"),
        )
    }
    pub fn write_derived_text(&self, sha256: &str, text: &str) -> Result<PathBuf, AppError> {
        let destination = self.derived_text_path(sha256)?;
        fs::create_dir_all(destination.parent().unwrap())?;
        let temp = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&temp, &destination).or_else(|error| {
            let _ = fs::remove_file(&temp);
            if destination.exists() {
                Ok(())
            } else {
                Err(error)
            }
        })?;
        Ok(destination)
    }
    pub fn write_link_preview_image(
        &self,
        attachment_id: &str,
        bytes: &[u8],
        extension: &str,
    ) -> Result<PathBuf, AppError> {
        if !valid_uuid(attachment_id)
            || !matches!(extension, "png" | "jpg" | "jpeg" | "webp" | "gif")
        {
            return Err(AppError::Validation(
                "Ungültiger Vorschaubildpfad".to_owned(),
            ));
        }
        if bytes.is_empty() || bytes.len() > 2 * 1024 * 1024 {
            return Err(AppError::Validation("Vorschaubild ist zu groß".to_owned()));
        }
        let directory = self.link_previews_directory.join(attachment_id);
        fs::create_dir_all(&directory)?;
        let destination = directory.join(format!("image.{extension}"));
        let temp = destination.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&temp, &destination)?;
        Ok(destination)
    }
    pub fn remove_unreferenced(&self, sha256: &str) -> Result<(), AppError> {
        let _ = fs::remove_file(self.blob_path(sha256)?);
        let _ = fs::remove_dir_all(self.derived_directory.join(sha256));
        Ok(())
    }
    pub fn remove_link_preview(&self, id: &str) -> Result<(), AppError> {
        if !valid_uuid(id) {
            return Err(AppError::Validation("Ungültige Anhang-ID".to_owned()));
        }
        let _ = fs::remove_dir_all(self.link_previews_directory.join(id));
        Ok(())
    }
    pub fn assert_readable_file(
        &self,
        candidate: impl AsRef<Path>,
        root: impl AsRef<Path>,
    ) -> Result<PathBuf, AppError> {
        let root = root.as_ref();
        let candidate = candidate.as_ref();
        if !candidate.is_absolute() {
            return Err(AppError::Validation("Pfad muss absolut sein".to_owned()));
        }
        let relative = candidate.strip_prefix(root).map_err(|_| {
            AppError::Validation(
                "Der gespeicherte Anhangspfad liegt außerhalb des geschützten Speichers."
                    .to_owned(),
            )
        })?;
        if relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(AppError::Validation("Ungültiger Anhangspfad".to_owned()));
        }
        let metadata = fs::symlink_metadata(candidate)?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
            return Err(AppError::Validation(
                "Symbolische Links sind im geschützten Anhangsspeicher nicht erlaubt.".to_owned(),
            ));
        }
        let canonical_root = fs::canonicalize(root)?;
        let canonical = fs::canonicalize(candidate)?;
        if !canonical.starts_with(canonical_root) {
            return Err(AppError::Validation(
                "Der gespeicherte Anhangspfad liegt außerhalb des geschützten Speichers."
                    .to_owned(),
            ));
        }
        Ok(canonical)
    }
    fn inside(&self, root: &Path, candidate: PathBuf) -> Result<PathBuf, AppError> {
        if !candidate.starts_with(root) {
            return Err(AppError::Validation(
                "Der gespeicherte Anhangspfad liegt außerhalb des geschützten Speichers."
                    .to_owned(),
            ));
        }
        Ok(candidate)
    }
}
fn set_private(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn valid_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}
fn assert_hash(value: &str) -> Result<(), AppError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        Err(AppError::Validation(
            "Expected a lowercase SHA-256 value".to_owned(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal_hash() {
        let s = ContextBlobStore::new(std::env::temp_dir()).unwrap();
        assert!(s.blob_path("../bad").is_err());
    }

    #[test]
    fn cleanup_removes_unreferenced_blob_and_derived_files() {
        let root = std::env::temp_dir().join(format!("geminui-blob-cleanup-{}", Uuid::new_v4()));
        let store = ContextBlobStore::new(&root).unwrap();
        store.initialize().unwrap();
        let hash = "a".repeat(64);
        let blob = store.blob_path(&hash).unwrap();
        fs::create_dir_all(blob.parent().unwrap()).unwrap();
        fs::write(&blob, b"orphan").unwrap();
        let derived = store.derived_text_path(&hash).unwrap();
        fs::create_dir_all(derived.parent().unwrap()).unwrap();
        fs::write(&derived, b"orphan").unwrap();
        store.cleanup(&HashSet::new()).unwrap();
        assert!(!blob.exists());
        assert!(!derived.parent().unwrap().exists());
        let _ = fs::remove_dir_all(root);
    }
}
