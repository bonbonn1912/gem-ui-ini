use serde::ser::Serializer;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Upstream(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("internal state lock was poisoned")]
    StatePoisoned,
    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "validation",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::Upstream(_) => "upstream",
            Self::Io(_) => "io",
            Self::Database(_) => "database",
            Self::Serialization(_) => "serialization",
            Self::StatePoisoned | Self::Internal(_) => "internal",
        }
    }
}

#[derive(Serialize)]
struct PublicError<'a> {
    code: &'static str,
    message: &'a str,
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let message = match self {
            Self::Validation(_) | Self::NotFound(_) | Self::Conflict(_) | Self::Upstream(_) => {
                self.to_string()
            }
            Self::Io(err) => format!("I/O-Fehler: {err}"),
            Self::Database(err) => format!("Datenbankfehler: {err}"),
            Self::Serialization(err) => format!("Serialisierungsfehler: {err}"),
            Self::StatePoisoned => "Interner Sperrzustand ist beschädigt (StatePoisoned)".to_owned(),
            Self::Internal(err) => format!("Interner Fehler: {err}"),
        };
        PublicError {
            code: self.code(),
            message: &message,
        }
        .serialize(serializer)
    }
}
