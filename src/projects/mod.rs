//! Independent projects vertical slice: contracts, roots, persistence and
//! project-wide approval policy.

mod approval;
pub mod commands;
mod contracts;
mod errors;
mod fingerprint;
mod idle;
mod repository;
mod root_resolver;
mod service;

pub use approval::{
    apply_project_approval_mode, is_unrestricted_mode, to_project_approval_policy,
    validate_unrestricted_confirmation,
};
pub use contracts::*;
pub use errors::{ProjectBusyError, ProjectRootErrorCode, ProjectRootValidationError};
pub use fingerprint::{compute_root_fingerprint, sha256_hex};
pub use idle::{IdleGuard, NoopIdleGuard, ProjectRuntimeCoordinator, SessionRuntimeCoordinator};
pub use repository::ProjectRepository;
pub use root_resolver::{
    canonical_paths_equal, resolve_project_root_set, verify_stored_project_root_set,
    ResolvedProjectRootSet, ResolvedRoot,
};
pub use service::{ProjectService, ProjectServiceOptions};
