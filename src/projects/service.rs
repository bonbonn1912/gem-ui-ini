use super::approval::{to_project_approval_policy, validate_unrestricted_confirmation};
use super::contracts::*;
use super::errors::{ProjectRootErrorCode, ProjectRootValidationError};
use super::idle::{IdleGuard, NoopIdleGuard};
use super::repository::ProjectRepository;
use super::root_resolver::{
    canonical_paths_equal, resolve_project_root_set, verify_stored_project_root_set, ResolvedRoot,
};
use crate::error::AppError;
use crate::idempotency::{idempotent, ClientRequestRepo};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Default)]
pub struct ProjectServiceOptions {
    pub now: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    pub create_id: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    pub runtime_coordinator: Option<Arc<dyn IdleGuard>>,
}

pub struct ProjectService {
    projects: ProjectRepository,
    client_requests: ClientRequestRepo,
    now: Arc<dyn Fn() -> String + Send + Sync>,
    create_id: Arc<dyn Fn() -> String + Send + Sync>,
    runtime_coordinator: Arc<dyn IdleGuard>,
}

impl ProjectService {
    pub fn new(projects: ProjectRepository) -> Self {
        Self::with_options(projects, ProjectServiceOptions::default())
    }

    pub fn with_options(projects: ProjectRepository, options: ProjectServiceOptions) -> Self {
        let now = options.now.unwrap_or_else(|| Arc::new(now_iso));
        let create_id = options.create_id.unwrap_or_else(|| Arc::new(new_id));
        let runtime_coordinator = options
            .runtime_coordinator
            .unwrap_or_else(|| Arc::new(NoopIdleGuard));
        let client_requests = ClientRequestRepo::new(projects.database());
        Self {
            projects,
            client_requests,
            now,
            create_id,
            runtime_coordinator,
        }
    }

    pub fn set_runtime_coordinator(&mut self, coordinator: Arc<dyn IdleGuard>) {
        self.runtime_coordinator = coordinator;
    }

    pub fn list(&self, input: ListProjectsInput) -> Result<Vec<ProjectWithRoots>, AppError> {
        self.projects.list(input.include_archived)
    }

    pub fn get(&self, project_id: &str) -> Result<ProjectWithRoots, AppError> {
        self.projects.get_by_id(project_id)
    }

    pub fn get_root_for_reauthorization(
        &self,
        project_id: &str,
        root_id: &str,
    ) -> Result<ProjectRoot, AppError> {
        let project = self.projects.get_by_id(project_id)?;
        project
            .roots
            .into_iter()
            .find(|root| root.id == root_id)
            .ok_or_else(|| AppError::NotFound(format!("Project root {root_id} was not found")))
    }

    pub async fn create(&self, input: CreateProjectInput) -> Result<ProjectWithRoots, AppError> {
        input.validate().map_err(AppError::Validation)?;
        let request_id = input.client_request_id.clone();
        idempotent(
            &self.client_requests,
            &request_id,
            "projects.create",
            || async { self.create_inner(&input) },
        )
        .await
    }

    fn create_inner(&self, input: &CreateProjectInput) -> Result<ProjectWithRoots, AppError> {
        let resolved =
            resolve_project_root_set(&input.primary_root_path, &input.additional_root_paths)?;
        let project_id = (self.create_id)();
        let primary_root_id = (self.create_id)();
        let timestamp = (self.now)();
        let roots = std::iter::once((primary_root_id, &resolved.primary_root))
            .map(|(id, root)| ProjectRoot {
                id,
                project_id: project_id.clone(),
                kind: ProjectRootKind::Primary,
                path: root.path.clone(),
                real_path: root.real_path.clone(),
                label: root.label.clone(),
                sort_order: 0,
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            })
            .chain(
                resolved
                    .additional_roots
                    .iter()
                    .enumerate()
                    .map(|(index, root)| ProjectRoot {
                        id: (self.create_id)(),
                        project_id: project_id.clone(),
                        kind: ProjectRootKind::Additional,
                        path: root.path.clone(),
                        real_path: root.real_path.clone(),
                        label: root.label.clone(),
                        sort_order: index + 1,
                        created_at: timestamp.clone(),
                        updated_at: timestamp.clone(),
                    }),
            )
            .collect::<Vec<_>>();
        let project = AppProject {
            id: project_id,
            name: input.name.trim().to_owned(),
            primary_root_id: roots[0].id.clone(),
            root_revision: 1,
            root_fingerprint: resolved.fingerprint,
            approval_mode_id: None,
            approval_mode_state: ProjectApprovalModeState::GeminiDefault,
            archived: false,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        self.projects.create(project, &roots)
    }

    pub async fn rename(&self, input: RenameProjectInput) -> Result<ProjectWithRoots, AppError> {
        input.validate().map_err(AppError::Validation)?;
        let request_id = input.client_request_id.clone();
        idempotent(
            &self.client_requests,
            &request_id,
            "projects.rename",
            || async {
                self.projects
                    .rename(&input.project_id, input.name.trim(), &(self.now)())
            },
        )
        .await
    }

    pub async fn set_archived(
        &self,
        input: ArchiveProjectInput,
    ) -> Result<ProjectWithRoots, AppError> {
        input.validate().map_err(AppError::Validation)?;
        let request_id = input.client_request_id.clone();
        idempotent(
            &self.client_requests,
            &request_id,
            "projects.archive",
            || async {
                self.projects
                    .set_archived(&input.project_id, input.archived, &(self.now)())
            },
        )
        .await
    }

    pub async fn set_additional_roots(
        &self,
        input: SetProjectRootsInput,
    ) -> Result<ProjectWithRoots, AppError> {
        input.validate().map_err(AppError::Validation)?;
        let request_id = input.client_request_id.clone();
        idempotent(
            &self.client_requests,
            &request_id,
            "projects.set-roots",
            || async { self.set_additional_roots_inner(&input) },
        )
        .await
    }

    fn set_additional_roots_inner(
        &self,
        input: &SetProjectRootsInput,
    ) -> Result<ProjectWithRoots, AppError> {
        let current = self.projects.get_by_id(&input.project_id)?;
        if current.project.root_revision != input.expected_root_revision {
            return Err(AppError::Conflict(
                "The project root revision changed before validation".to_owned(),
            ));
        }
        self.runtime_coordinator
            .assert_project_idle(&input.project_id)?;
        let primary = primary_root(&current)?;
        let resolved = resolve_project_root_set(&primary.path, &input.additional_root_paths)?;
        if resolved.fingerprint == current.project.root_fingerprint {
            return Ok(current);
        }
        self.runtime_coordinator
            .stop_project_processes(&input.project_id)?;
        let timestamp = (self.now)();
        let additional_roots = resolved
            .additional_roots
            .iter()
            .enumerate()
            .map(|(index, root)| ProjectRoot {
                id: (self.create_id)(),
                project_id: input.project_id.clone(),
                kind: ProjectRootKind::Additional,
                path: root.path.clone(),
                real_path: root.real_path.clone(),
                label: root.label.clone(),
                sort_order: index + 1,
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            })
            .collect::<Vec<_>>();
        self.projects.replace_additional_roots(
            &input.project_id,
            input.expected_root_revision,
            input.expected_root_revision + 1,
            &resolved.fingerprint,
            &additional_roots,
            &timestamp,
        )
    }

    pub async fn delete(&self, input: DeleteProjectInput) -> Result<(), AppError> {
        input.validate().map_err(AppError::Validation)?;
        let request_id = input.client_request_id.clone();
        idempotent(
            &self.client_requests,
            &request_id,
            "projects.delete",
            || async { self.delete_inner(&input.project_id) },
        )
        .await
    }

    fn delete_inner(&self, project_id: &str) -> Result<(), AppError> {
        self.runtime_coordinator.assert_project_idle(project_id)?;
        self.runtime_coordinator
            .stop_project_processes(project_id)?;
        self.projects.delete(project_id).map(|_| ())
    }

    pub fn set_approval_mode_state(
        &self,
        project_id: &str,
        mode_id: Option<&str>,
        state: ProjectApprovalModeState,
    ) -> Result<ProjectWithRoots, AppError> {
        self.projects
            .set_approval_mode(project_id, mode_id, state, &(self.now)())
    }

    pub async fn set_approval_policy(
        &self,
        input: SetProjectApprovalPolicyInput,
        modes: Option<ApprovalModeSnapshot>,
    ) -> Result<ProjectApprovalPolicy, AppError> {
        input.validate().map_err(AppError::Validation)?;
        let request_id = input.client_request_id.clone();
        idempotent(&self.client_requests, &request_id, "projects.set-approval-policy", || async {
            let project = if let Some(mode_id) = &input.mode_id {
                let snapshot = modes.as_ref().ok_or_else(|| AppError::Validation("Dieser Modus wurde von der aktuellen Gemini-ACP-Session nicht angeboten und kann nicht projektweit gespeichert werden.".to_owned()))?;
                let selected = snapshot.available_modes.iter().find(|mode| mode.id == *mode_id).ok_or_else(|| AppError::Validation("Dieser Modus wurde von der aktuellen Gemini-ACP-Session nicht angeboten und kann nicht projektweit gespeichert werden.".to_owned()))?;
                validate_unrestricted_confirmation(selected, input.confirm_unrestricted)?;
                self.projects.set_approval_mode(&input.project_id, Some(mode_id), ProjectApprovalModeState::Available, &(self.now)())?
            } else {
                self.projects.set_approval_mode(&input.project_id, None, ProjectApprovalModeState::GeminiDefault, &(self.now)())?
            };
            Ok(to_project_approval_policy(&project, modes.as_ref()))
        }).await
    }

    pub async fn reauthorize_root_selection(
        &self,
        input: ReauthorizeProjectRootSelectionInput,
    ) -> Result<ProjectRoot, AppError> {
        let stored = self.get_root_for_reauthorization(&input.project_id, &input.root_id)?;
        let empty: Vec<String> = Vec::new();
        let selected = resolve_project_root_set(&input.selected_path, &empty)?;
        if !canonical_paths_equal(&selected.primary_root.real_path, &stored.real_path) {
            return Err(ProjectRootValidationError::new(ProjectRootErrorCode::RootReauthorizationMismatch, format!("Der ausgewählte Ordner entspricht nicht dem gespeicherten Projektordner „{}“. Bitte wähle exakt diesen Ordner aus: {}", stored.label, stored.path), Some(input.selected_path)).into());
        }
        let revalidated = resolve_project_root_set(&stored.path, &empty)?;
        if !canonical_paths_equal(&revalidated.primary_root.real_path, &stored.real_path) {
            return Err(ProjectRootValidationError::new(
                ProjectRootErrorCode::RootChangedOnDisk,
                format!(
                    "Der gespeicherte Projektordner verweist inzwischen auf einen anderen Ort: {}",
                    stored.path
                ),
                Some(stored.path),
            )
            .into());
        }
        Ok(stored)
    }

    pub async fn get_current_access(&self, project_id: &str) -> Result<ProjectAccess, AppError> {
        let project = self.projects.get_by_id(project_id)?;
        let primary = primary_root(&project)?;
        let additional = project
            .roots
            .iter()
            .filter(|root| root.kind == ProjectRootKind::Additional)
            .cloned()
            .collect::<Vec<_>>();
        let primary_resolved = ResolvedRoot {
            path: primary.path.clone(),
            real_path: primary.real_path.clone(),
            label: primary.label.clone(),
        };
        let additional_resolved = additional
            .iter()
            .map(|root| ResolvedRoot {
                path: root.path.clone(),
                real_path: root.real_path.clone(),
                label: root.label.clone(),
            })
            .collect::<Vec<_>>();
        verify_stored_project_root_set(
            &primary_resolved,
            &additional_resolved,
            &project.project.root_fingerprint,
        )?;
        Ok(ProjectAccess {
            project_id: project.project.id.clone(),
            root_revision: project.project.root_revision,
            root_fingerprint: project.project.root_fingerprint.clone(),
            primary_root: primary.clone(),
            additional_roots: additional,
        })
    }
}

fn primary_root(project: &ProjectWithRoots) -> Result<&ProjectRoot, AppError> {
    project
        .roots
        .iter()
        .find(|root| root.kind == ProjectRootKind::Primary)
        .ok_or_else(|| {
            AppError::Internal(format!(
                "Project {} has no primary root",
                project.project.id
            ))
        })
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let millis = duration.subsec_millis();
    let days = (duration.as_secs() / 86_400) as i64;
    let seconds = duration.as_secs() % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        seconds / 3600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    (year + if month <= 2 { 1 } else { 0 }, month, day)
}
