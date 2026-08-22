//! Token vault: OS keyring stores only a 256-bit master key; token values are
//! encrypted independently with AES-256-GCM and a fresh nonce per value.

use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const MAGIC_AES_GCM: u8 = 0x02;
/// Kept for rejecting old plaintext-marker values. New keyring values use the
/// same authenticated AES format as file-fallback values.
pub const MAGIC_KEYRING: u8 = 0x03;

pub trait SecretStorage: Send + Sync {
    fn available(&self) -> bool;
    fn encrypt(&self, plaintext: &str) -> Result<Vec<u8>, String>;
    fn decrypt(&self, ciphertext: &[u8]) -> Result<String, String>;
}

#[derive(Clone)]
pub struct KeyringStorage {
    service: String,
    account: String,
}
impl KeyringStorage {
    pub fn new(service: impl Into<String>, account: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            account: account.into(),
        }
    }
    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, &self.account).map_err(|e| e.to_string())
    }
    fn master_key(&self) -> Result<[u8; 32], String> {
        let entry = self.entry()?;
        if let Ok(value) = entry.get_password() {
            return decode_key(&value);
        }
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        entry
            .set_password(&hex_encode(&key))
            .map_err(|e| e.to_string())?;
        Ok(key)
    }
}
impl SecretStorage for KeyringStorage {
    fn available(&self) -> bool {
        self.entry().is_ok()
    }
    fn encrypt(&self, plaintext: &str) -> Result<Vec<u8>, String> {
        encrypt_with_key(&self.master_key()?, plaintext)
    }
    fn decrypt(&self, ciphertext: &[u8]) -> Result<String, String> {
        decrypt_with_key(&self.master_key()?, ciphertext)
    }
}

pub struct AesGcmStorage {
    key: [u8; 32],
}
impl AesGcmStorage {
    pub fn from_key(key: [u8; 32]) -> Self {
        Self { key }
    }
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        match std::fs::read(path) {
            Ok(value) if value.len() == 32 => {
                let mut key = [0; 32];
                key.copy_from_slice(&value);
                return Ok(Self { key });
            }
            Ok(_) => return Err("Der lokale AES-Schlüssel ist beschädigt.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut key = [0; 32];
        OsRng.fill_bytes(&mut key);
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        match options.open(path) {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(&key).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let value = std::fs::read(path).map_err(|read_error| read_error.to_string())?;
                if value.len() != 32 {
                    return Err("Der lokale AES-Schlüssel ist beschädigt.".into());
                }
                key.copy_from_slice(&value);
            }
            Err(error) => return Err(error.to_string()),
        }
        Ok(Self { key })
    }
}
impl SecretStorage for AesGcmStorage {
    fn available(&self) -> bool {
        true
    }
    fn encrypt(&self, plaintext: &str) -> Result<Vec<u8>, String> {
        encrypt_with_key(&self.key, plaintext)
    }
    fn decrypt(&self, ciphertext: &[u8]) -> Result<String, String> {
        decrypt_with_key(&self.key, ciphertext)
    }
}

pub struct HybridSecretStorage {
    keyring: Option<KeyringStorage>,
    aes: AesGcmStorage,
}
impl HybridSecretStorage {
    pub fn new(
        key_path: impl Into<PathBuf>,
        keyring: Option<KeyringStorage>,
    ) -> Result<Self, String> {
        Ok(Self {
            keyring,
            aes: AesGcmStorage::from_path(key_path.into())?,
        })
    }
}
impl SecretStorage for HybridSecretStorage {
    fn available(&self) -> bool {
        true
    }
    fn encrypt(&self, plaintext: &str) -> Result<Vec<u8>, String> {
        if let Some(keyring) = &self.keyring {
            if keyring.available() {
                if let Ok(value) = keyring.encrypt(plaintext) {
                    return Ok(value);
                }
            }
        }
        self.aes.encrypt(plaintext)
    }
    fn decrypt(&self, ciphertext: &[u8]) -> Result<String, String> {
        if ciphertext.first() == Some(&MAGIC_KEYRING) {
            return Err("Nicht unterstütztes unsicheres Legacy-Keyring-Chiffrat.".into());
        }
        if let Some(keyring) = &self.keyring {
            if keyring.available() {
                if let Ok(value) = keyring.decrypt(ciphertext) {
                    return Ok(value);
                }
            }
        }
        self.aes.decrypt(ciphertext)
    }
}

pub struct GitLabTokenVault {
    storage: Arc<dyn SecretStorage>,
}
impl GitLabTokenVault {
    pub fn new(storage: Arc<dyn SecretStorage>) -> Self {
        Self { storage }
    }
    pub fn is_encryption_available(&self) -> bool {
        self.storage.available()
    }
    pub fn encrypt_token(&self, token: &str) -> Result<Vec<u8>, String> {
        let token = token.trim();
        if token.is_empty() {
            return Err("Ein leerer Token kann nicht gespeichert werden.".into());
        }
        self.storage.encrypt(token)
    }
    pub fn decrypt_token(&self, ciphertext: &[u8]) -> Result<String, String> {
        if ciphertext.is_empty() {
            return Err("Ungültiger Token-Ciphertext.".into());
        }
        self.storage.decrypt(ciphertext)
    }
    pub fn with_decrypted_token<T>(
        &self,
        ciphertext: &[u8],
        callback: impl FnOnce(&str) -> Result<T, String>,
    ) -> Result<T, String> {
        let token = self.decrypt_token(ciphertext)?;
        callback(&token)
    }
}

fn encrypt_with_key(key: &[u8; 32], plaintext: &str) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|_| "Token konnte nicht verschlüsselt werden.".to_owned())?;
    let mut output = vec![MAGIC_AES_GCM];
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    Ok(output)
}
fn decrypt_with_key(key: &[u8; 32], ciphertext: &[u8]) -> Result<String, String> {
    if ciphertext.len() < 1 + 12 + 16 || ciphertext[0] != MAGIC_AES_GCM {
        return Err("Ungültiges AES-GCM-Chiffrat.".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&ciphertext[1..13]), &ciphertext[13..])
        .map_err(|_| "Token konnte nicht entschlüsselt werden.".to_owned())?;
    String::from_utf8(plaintext).map_err(|_| "Token ist kein gültiger UTF-8-Text.".into())
}
fn hex_encode(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn decode_key(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 {
        return Err("Ungültiger Keyring-Master-Key.".into());
    }
    let mut key = [0u8; 32];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        key[index] = (hex_digit(chunk[0])? << 4) | hex_digit(chunk[1])?;
    }
    Ok(key)
}
fn hex_digit(value: u8) -> Result<u8, String> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err("Ungültiger Keyring-Master-Key.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::{AesGcmStorage, GitLabTokenVault, SecretStorage, MAGIC_KEYRING};

    #[test]
    fn aes_gcm_uses_fresh_nonce_and_round_trips_tokens() {
        let storage = AesGcmStorage::from_key([7u8; 32]);
        let first = storage.encrypt("glpat-first").expect("encrypt");
        let second = storage.encrypt("glpat-first").expect("encrypt");
        assert_ne!(
            first, second,
            "a token must not have a deterministic ciphertext"
        );
        assert_eq!(storage.decrypt(&first).expect("decrypt"), "glpat-first");
        assert_eq!(storage.decrypt(&second).expect("decrypt"), "glpat-first");
    }

    #[test]
    fn legacy_plaintext_marker_is_rejected_by_the_vault() {
        let storage = AesGcmStorage::from_key([9u8; 32]);
        let vault = GitLabTokenVault::new(std::sync::Arc::new(storage));
        assert!(vault
            .decrypt_token(&[MAGIC_KEYRING, b'p', b'l', b'a', b'i', b'n'])
            .is_err());
    }
}
