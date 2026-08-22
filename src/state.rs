use crate::acp::SessionManager;
use crate::db::DbPool;
use crate::error::AppError;
use crate::hub::SubscriptionHub;
use crate::idempotency::ClientRequestRepo;
use crate::projects::{
    ProjectRepository, ProjectService, ProjectServiceOptions, SessionRuntimeCoordinator,
};
use crate::sessions::SessionRepository;
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;

/// Handles owned by the process. Domain logic belongs in its domain module;
/// this struct only wires shared resources into Tauri commands.
pub struct AppState {
    pub db: DbPool,
    projects: Arc<ProjectService>,
    pub sessions: Arc<SessionManager>,
    pub capabilities: Arc<CapabilityService>,
    pub hubs: Hubs,
    pub client_requests: ClientRequestRepo,
}

pub struct CapabilityService;

pub struct Hubs {
    pub git: SubscriptionHub<String, Value>,
    pub context_attachments: SubscriptionHub<String, Value>,
    pub todos: SubscriptionHub<String, Value>,
    pub gitlab: SubscriptionHub<String, Value>,
}

impl AppState {
    pub fn open(database_path: impl AsRef<Path>) -> Result<Self, AppError> {
        let db = DbPool::open(database_path)?;
        Ok(Self::from_db(db))
    }

    pub fn from_db(db: DbPool) -> Self {
        let sessions = Arc::new(SessionManager::new());
        let runtime_coordinator = Arc::new(SessionRuntimeCoordinator::new(
            SessionRepository::new(db.clone()),
            Arc::clone(&sessions),
        ));
        let projects = Arc::new(ProjectService::with_options(
            ProjectRepository::new(db.clone()),
            ProjectServiceOptions {
                runtime_coordinator: Some(runtime_coordinator),
                ..Default::default()
            },
        ));
        Self {
            client_requests: ClientRequestRepo::new(db.clone()),
            db,
            projects,
            sessions,
            capabilities: Arc::new(CapabilityService),
            hubs: Hubs {
                git: SubscriptionHub::new(),
                context_attachments: SubscriptionHub::new(),
                todos: SubscriptionHub::new(),
                gitlab: SubscriptionHub::new(),
            },
        }
    }

    pub fn project_service(&self) -> &ProjectService {
        &self.projects
    }

    pub fn shared_project_service(&self) -> Arc<ProjectService> {
        Arc::clone(&self.projects)
    }
}

#[cfg(test)]
mod tests {
    use super::AppState;
    use crate::db::DbPool;

    #[test]
    fn state_wires_all_four_hubs_and_idempotency_repo() {
        let state = AppState::from_db(DbPool::open_in_memory().unwrap());
        assert_eq!(state.hubs.git.subscriber_count(), 0);
        assert_eq!(state.hubs.context_attachments.subscriber_count(), 0);
        assert_eq!(state.hubs.todos.subscriber_count(), 0);
        assert_eq!(state.hubs.gitlab.subscriber_count(), 0);
        assert_eq!(state.db.schema_version().unwrap(), 1);
    }
}
