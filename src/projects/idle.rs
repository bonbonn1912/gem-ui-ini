use crate::acp::{SessionManager, SessionSnapshot, SessionStatus};
use crate::error::AppError;
use crate::sessions::SessionRepository;
use std::future::Future;
use std::sync::Arc;

/// Abstraction over the ACP/session runtime. Root changes are allowed only
/// after every session belonging to the project is idle.
pub trait IdleGuard: Send + Sync {
    fn assert_project_idle(&self, project_id: &str) -> Result<(), AppError>;
    fn stop_project_processes(&self, project_id: &str) -> Result<(), AppError>;
}

pub trait ProjectRuntimeCoordinator: IdleGuard {}
impl<T: IdleGuard + ?Sized> ProjectRuntimeCoordinator for T {}

/// Coordinates project mutations with the persistent session registry and the
/// in-memory ACP process manager.  The project service is synchronous at the
/// mutation boundary, so manager operations are completed on a short-lived
/// helper thread.  This is important for Tauri commands: calling Tokio's
/// `block_on` directly from an async command would panic when the command is
/// already running on the Tauri runtime.
pub struct SessionRuntimeCoordinator {
    sessions: SessionRepository,
    manager: Arc<SessionManager>,
}

impl SessionRuntimeCoordinator {
    pub fn new(sessions: SessionRepository, manager: Arc<SessionManager>) -> Self {
        Self { sessions, manager }
    }

    fn manager_snapshots(&self) -> Result<Vec<SessionSnapshot>, AppError> {
        let manager = Arc::clone(&self.manager);
        run_on_runtime(async move { Ok(manager.snapshots().await) })
    }

    fn close_sessions(&self, session_ids: Vec<String>) -> Result<(), AppError> {
        if session_ids.is_empty() {
            return Ok(());
        }
        let manager = Arc::clone(&self.manager);
        run_on_runtime(async move {
            for session_id in session_ids {
                manager.close(&session_id).await.map_err(|error| {
                    AppError::Internal(format!(
                        "ACP-Prozess {session_id} konnte nicht beendet werden: {error}"
                    ))
                })?;
            }
            Ok(())
        })
    }
}

impl IdleGuard for SessionRuntimeCoordinator {
    fn assert_project_idle(&self, project_id: &str) -> Result<(), AppError> {
        let persisted = self.sessions.list_by_project(project_id, true)?;
        if let Some(session) = persisted.iter().find(|session| {
            matches!(
                session.status,
                crate::sessions::SessionStatus::Starting
                    | crate::sessions::SessionStatus::Running
                    | crate::sessions::SessionStatus::AwaitingPermission
                    | crate::sessions::SessionStatus::Cancelling
            )
        }) {
            return Err(AppError::Conflict(format!(
                "Projekt kann nicht geändert werden, solange Session {} aktiv ist ({:?}).",
                session.id, session.status
            )));
        }

        let active_ids = persisted
            .iter()
            .map(|session| session.id.as_str())
            .collect::<std::collections::HashSet<_>>();
        if let Some(snapshot) = self.manager_snapshots()?.into_iter().find(|snapshot| {
            active_ids.contains(snapshot.id.as_str())
                && !matches!(snapshot.status, SessionStatus::Idle)
        }) {
            return Err(AppError::Conflict(format!(
                "Projekt kann nicht geändert werden, solange Session {} aktiv ist ({:?}).",
                snapshot.id, snapshot.status
            )));
        }
        Ok(())
    }

    fn stop_project_processes(&self, project_id: &str) -> Result<(), AppError> {
        let project_session_ids = self
            .sessions
            .list_by_project(project_id, true)?
            .into_iter()
            .map(|session| session.id)
            .collect::<std::collections::HashSet<_>>();
        let active_ids = self
            .manager_snapshots()?
            .into_iter()
            .filter(|snapshot| project_session_ids.contains(&snapshot.id))
            .map(|snapshot| snapshot.id)
            .collect::<Vec<_>>();
        self.close_sessions(active_ids)
    }
}

fn run_on_runtime<T, F>(future: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: Future<Output = Result<T, AppError>> + Send + 'static,
{
    std::thread::spawn(move || tauri::async_runtime::block_on(future))
        .join()
        .map_err(|_| {
            AppError::Internal("ACP-Laufzeitkoordinator ist unerwartet abgebrochen.".to_owned())
        })?
}

#[derive(Debug, Default)]
pub struct NoopIdleGuard;

impl IdleGuard for NoopIdleGuard {
    fn assert_project_idle(&self, _project_id: &str) -> Result<(), AppError> {
        Ok(())
    }
    fn stop_project_processes(&self, _project_id: &str) -> Result<(), AppError> {
        Ok(())
    }
}
