use crate::db::DbPool;
use crate::error::AppError;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const GEMINI_SETTINGS_KEY: &str = "gemini.binaryPath";
pub const GIT_SETTINGS_KEY: &str = "git.binaryPath";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiSettings {
    pub binary_path: Option<String>,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSettings {
    pub binary_path: Option<String>,
    pub updated_at: String,
}
#[derive(Clone)]
pub struct SettingsRepository {
    db: DbPool,
}
impl SettingsRepository {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }
    pub fn get(&self, key: &str) -> Result<Option<(Value, String)>, AppError> {
        let connection = self.db.connection()?;
        connection
            .query_row(
                "SELECT value_json,updated_at FROM settings WHERE key=?",
                [key],
                |row| {
                    Ok((
                        serde_json::from_str(&row.get::<_, String>(0)?).unwrap_or(Value::Null),
                        row.get(1)?,
                    ))
                },
            )
            .optional()
            .map_err(AppError::from)
    }
    pub fn set(&self, key: &str, value: Value, updated_at: &str) -> Result<(), AppError> {
        self.db.connection()?.execute("INSERT INTO settings(key,value_json,version,updated_at) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,version=version+1,updated_at=excluded.updated_at", rusqlite::params![key, serde_json::to_string(&value)?, updated_at])?;
        Ok(())
    }
    pub fn gemini(&self) -> Result<Option<GeminiSettings>, AppError> {
        self.get(GEMINI_SETTINGS_KEY).map(|value| {
            value.map(|(value, updated_at)| GeminiSettings {
                binary_path: value.as_str().map(str::to_owned),
                updated_at,
            })
        })
    }
    pub fn git(&self) -> Result<Option<GitSettings>, AppError> {
        self.get(GIT_SETTINGS_KEY).map(|value| {
            value.map(|(value, updated_at)| GitSettings {
                binary_path: value.as_str().map(str::to_owned),
                updated_at,
            })
        })
    }
    pub fn set_gemini(
        &self,
        path: Option<&str>,
        updated_at: &str,
    ) -> Result<GeminiSettings, AppError> {
        self.set(
            GEMINI_SETTINGS_KEY,
            path.map_or(Value::Null, |value| Value::String(value.into())),
            updated_at,
        )?;
        Ok(GeminiSettings {
            binary_path: path.map(str::to_owned),
            updated_at: updated_at.into(),
        })
    }
    pub fn set_git(&self, path: Option<&str>, updated_at: &str) -> Result<GitSettings, AppError> {
        self.set(
            GIT_SETTINGS_KEY,
            path.map_or(Value::Null, |value| Value::String(value.into())),
            updated_at,
        )?;
        Ok(GitSettings {
            binary_path: path.map(str::to_owned),
            updated_at: updated_at.into(),
        })
    }
}
