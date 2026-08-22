use crate::error::AppError;
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectRootErrorCode {
    RootPathNotAbsolute,
    RootNotFound,
    RootNotAccessible,
    RootNotDirectory,
    RootReauthorizationMismatch,
    DuplicateRoot,
    OverlappingRoot,
    RootChangedOnDisk,
    TooManyAdditionalRoots,
}

impl ProjectRootErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RootPathNotAbsolute => "root_path_not_absolute",
            Self::RootNotFound => "root_not_found",
            Self::RootNotAccessible => "root_not_accessible",
            Self::RootNotDirectory => "root_not_directory",
            Self::RootReauthorizationMismatch => "root_reauthorization_mismatch",
            Self::DuplicateRoot => "duplicate_root",
            Self::OverlappingRoot => "overlapping_root",
            Self::RootChangedOnDisk => "root_changed_on_disk",
            Self::TooManyAdditionalRoots => "too_many_additional_roots",
        }
    }
}

#[derive(Debug)]
pub struct ProjectRootValidationError {
    pub code: ProjectRootErrorCode,
    pub message: String,
    pub root_path: Option<String>,
    pub source: Option<std::io::Error>,
}

impl ProjectRootValidationError {
    pub fn new(
        code: ProjectRootErrorCode,
        message: impl Into<String>,
        root_path: Option<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            root_path,
            source: None,
        }
    }

    pub fn with_source(
        code: ProjectRootErrorCode,
        message: impl Into<String>,
        root_path: Option<String>,
        source: std::io::Error,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            root_path,
            source: Some(source),
        }
    }
}

impl fmt::Display for ProjectRootValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProjectRootValidationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|error| error as &dyn std::error::Error)
    }
}

impl From<ProjectRootValidationError> for AppError {
    fn from(error: ProjectRootValidationError) -> Self {
        AppError::Validation(format!("{}: {}", error.code.as_str(), error.message))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectBusyError {
    pub project_id: String,
}

impl ProjectBusyError {
    pub fn new(project_id: impl Into<String>) -> Self {
        Self {
            project_id: project_id.into(),
        }
    }
}

impl fmt::Display for ProjectBusyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Project {} has an active turn and its roots cannot be changed",
            self.project_id
        )
    }
}

impl std::error::Error for ProjectBusyError {}

impl From<ProjectBusyError> for AppError {
    fn from(error: ProjectBusyError) -> Self {
        AppError::Conflict(error.to_string())
    }
}
