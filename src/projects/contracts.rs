//! Serde contracts for the projects vertical slice.
//!
//! The renderer-facing names intentionally stay in camelCase.  Keeping the
//! input contracts strict is important here: a misspelled root revision must
//! never silently turn into an unconditional root replacement.

use serde::{Deserialize, Serialize};
use std::ops::Deref;

pub const MAX_ADDITIONAL_ROOTS: usize = 5;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectApprovalModeState {
    GeminiDefault,
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRootKind {
    Primary,
    Additional,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectApprovalMode {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub unrestricted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRoot {
    pub id: String,
    pub project_id: String,
    pub kind: ProjectRootKind,
    pub path: String,
    pub real_path: String,
    pub label: String,
    pub sort_order: usize,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppProject {
    pub id: String,
    pub name: String,
    pub primary_root_id: String,
    pub root_revision: u64,
    pub root_fingerprint: String,
    pub approval_mode_id: Option<String>,
    pub approval_mode_state: ProjectApprovalModeState,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectWithRoots {
    #[serde(flatten)]
    pub project: AppProject,
    pub roots: Vec<ProjectRoot>,
}

impl Deref for ProjectWithRoots {
    type Target = AppProject;

    fn deref(&self) -> &Self::Target {
        &self.project
    }
}

impl ProjectWithRoots {
    pub fn validate(&self) -> Result<(), String> {
        self.project.validate()?;
        if self.roots.is_empty() || self.roots.len() > MAX_ADDITIONAL_ROOTS + 1 {
            return Err(format!(
                "a project must contain one to {} roots",
                MAX_ADDITIONAL_ROOTS + 1
            ));
        }
        let mut primary_count = 0;
        let mut real_paths = std::collections::HashSet::new();
        for root in &self.roots {
            root.validate()?;
            if root.project_id != self.project.id {
                return Err("every root must belong to its project".to_owned());
            }
            if root.kind == ProjectRootKind::Primary {
                primary_count += 1;
                if root.id != self.project.primary_root_id {
                    return Err("primaryRootId must reference the primary root".to_owned());
                }
            }
            if !real_paths.insert(root.real_path.clone()) {
                return Err("project root real paths must be unique".to_owned());
            }
        }
        if primary_count != 1 {
            return Err("a project must contain exactly one primary root".to_owned());
        }
        Ok(())
    }
}

impl AppProject {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() || self.name.chars().count() > 200 {
            return Err("name must contain 1 to 200 characters".to_owned());
        }
        if self.root_revision == 0 {
            return Err("rootRevision must be at least 1".to_owned());
        }
        if self.root_fingerprint.len() != 64
            || !self
                .root_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self
                .root_fingerprint
                .bytes()
                .any(|byte| byte.is_ascii_uppercase())
        {
            return Err("rootFingerprint must be a lowercase SHA-256 fingerprint".to_owned());
        }
        match (&self.approval_mode_id, &self.approval_mode_state) {
            (None, ProjectApprovalModeState::GeminiDefault) => {}
            (Some(id), _) if !id.trim().is_empty() && id.chars().count() <= 100 => {}
            _ => return Err("approval mode id and state are inconsistent".to_owned()),
        }
        Ok(())
    }
}

impl ProjectRoot {
    pub fn validate(&self) -> Result<(), String> {
        if self.path.is_empty() || self.real_path.is_empty() {
            return Err("root paths must not be empty".to_owned());
        }
        if self.label.trim().is_empty() || self.label.chars().count() > 200 {
            return Err("root label must contain 1 to 200 characters".to_owned());
        }
        match self.kind {
            ProjectRootKind::Primary if self.sort_order != 0 => {
                Err("the primary root must have sortOrder 0".to_owned())
            }
            ProjectRootKind::Additional
                if self.sort_order == 0 || self.sort_order > MAX_ADDITIONAL_ROOTS =>
            {
                Err("additional root sortOrder is out of range".to_owned())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRootCandidate {
    pub path: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PickProjectFoldersInput {
    #[serde(default = "default_true")]
    pub allow_multiple: bool,
}

const fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateProjectInput {
    pub client_request_id: String,
    pub name: String,
    pub primary_root_path: String,
    #[serde(default)]
    pub additional_root_paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameProjectInput {
    pub client_request_id: String,
    pub project_id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveProjectInput {
    pub client_request_id: String,
    pub project_id: String,
    pub archived: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetProjectRootsInput {
    pub client_request_id: String,
    pub project_id: String,
    pub expected_root_revision: u64,
    pub additional_root_paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteProjectInput {
    pub client_request_id: String,
    pub project_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetProjectInput {
    pub project_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReauthorizeProjectRootInput {
    pub project_id: String,
    pub root_id: String,
}

/// Internal value created only after the native folder picker returned a
/// local path.  Keeping it separate from the IPC contract prevents the
/// renderer from supplying an arbitrary path for reauthorization.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReauthorizeProjectRootSelectionInput {
    pub project_id: String,
    pub root_id: String,
    pub selected_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProjectRootReauthorizationResult {
    #[serde(rename = "authorized")]
    Authorized { root: ProjectRoot },
    #[serde(rename = "cancelled")]
    Cancelled,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListProjectsInput {
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetProjectApprovalPolicyInput {
    pub project_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetProjectApprovalPolicyInput {
    pub client_request_id: String,
    pub project_id: String,
    pub mode_id: Option<String>,
    #[serde(default)]
    pub confirm_unrestricted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectApprovalPolicy {
    pub project_id: String,
    pub mode_id: Option<String>,
    pub state: ProjectApprovalModeState,
    pub current_mode_id: Option<String>,
    pub available_modes: Vec<ProjectApprovalMode>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAccess {
    pub project_id: String,
    pub root_revision: u64,
    pub root_fingerprint: String,
    pub primary_root: ProjectRoot,
    pub additional_roots: Vec<ProjectRoot>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalModeSnapshot {
    pub current_mode_id: Option<String>,
    pub available_modes: Vec<ProjectApprovalMode>,
}

impl CreateProjectInput {
    pub fn validate(&self) -> Result<(), String> {
        validate_client_request(&self.client_request_id)?;
        validate_name(&self.name)?;
        validate_root_count(self.additional_root_paths.len())
    }
}

impl RenameProjectInput {
    pub fn validate(&self) -> Result<(), String> {
        validate_client_request(&self.client_request_id)?;
        validate_name(&self.name)
    }
}

impl ArchiveProjectInput {
    pub fn validate(&self) -> Result<(), String> {
        validate_client_request(&self.client_request_id)
    }
}

impl SetProjectRootsInput {
    pub fn validate(&self) -> Result<(), String> {
        validate_client_request(&self.client_request_id)?;
        if self.expected_root_revision == 0 {
            return Err("expectedRootRevision must be at least 1".to_owned());
        }
        validate_root_count(self.additional_root_paths.len())
    }
}

impl DeleteProjectInput {
    pub fn validate(&self) -> Result<(), String> {
        validate_client_request(&self.client_request_id)
    }
}

impl SetProjectApprovalPolicyInput {
    pub fn validate(&self) -> Result<(), String> {
        validate_client_request(&self.client_request_id)?;
        if let Some(mode_id) = &self.mode_id {
            if mode_id.trim().is_empty() || mode_id.chars().count() > 100 {
                return Err("modeId must contain 1 to 100 characters".to_owned());
            }
        }
        Ok(())
    }
}

fn validate_client_request(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err("clientRequestId is required".to_owned())
    } else {
        Ok(())
    }
}

fn validate_name(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > 200 {
        Err("name must contain 1 to 200 characters".to_owned())
    } else {
        Ok(())
    }
}

fn validate_root_count(count: usize) -> Result<(), String> {
    if count > MAX_ADDITIONAL_ROOTS {
        Err(format!(
            "at most {MAX_ADDITIONAL_ROOTS} additional roots are supported"
        ))
    } else {
        Ok(())
    }
}
