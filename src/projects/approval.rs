use super::contracts::{
    ApprovalModeSnapshot, ProjectApprovalMode, ProjectApprovalModeState, ProjectApprovalPolicy,
    ProjectWithRoots,
};
use crate::error::AppError;
use std::future::Future;

pub fn is_unrestricted_mode(mode: &ProjectApprovalMode) -> bool {
    // Gemini's ACP contract reserves exactly this id for allow-all mode.
    mode.id == "yolo"
}

pub async fn apply_project_approval_mode<F, Fut>(
    requested_mode_id: Option<&str>,
    modes: Option<&ApprovalModeSnapshot>,
    set_mode: F,
) -> (Option<String>, ProjectApprovalModeState)
where
    F: FnOnce(&str) -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    let Some(requested_mode_id) = requested_mode_id else {
        return (
            modes.and_then(|snapshot| snapshot.current_mode_id.clone()),
            ProjectApprovalModeState::GeminiDefault,
        );
    };
    let Some(snapshot) = modes else {
        return (None, ProjectApprovalModeState::Unavailable);
    };
    if !snapshot
        .available_modes
        .iter()
        .any(|mode| mode.id == requested_mode_id)
    {
        return (
            snapshot.current_mode_id.clone(),
            ProjectApprovalModeState::Unavailable,
        );
    }
    if snapshot.current_mode_id.as_deref() != Some(requested_mode_id)
        && set_mode(requested_mode_id).await.is_err()
    {
        return (
            snapshot.current_mode_id.clone(),
            ProjectApprovalModeState::Unavailable,
        );
    }
    (
        Some(requested_mode_id.to_owned()),
        ProjectApprovalModeState::Available,
    )
}

pub fn to_project_approval_policy(
    project: &ProjectWithRoots,
    modes: Option<&ApprovalModeSnapshot>,
) -> ProjectApprovalPolicy {
    let available_modes: Vec<ProjectApprovalMode> = modes
        .map(|snapshot| {
            snapshot
                .available_modes
                .iter()
                .cloned()
                .map(|mut mode| {
                    mode.unrestricted = is_unrestricted_mode(&mode);
                    mode
                })
                .collect()
        })
        .unwrap_or_default();
    let message = if project.project.approval_mode_state == ProjectApprovalModeState::Unavailable {
        Some(match &project.project.approval_mode_id {
            Some(mode_id) => format!(
                "Der gespeicherte Projektmodus „{mode_id}“ wird von dieser Gemini-Session nicht angeboten. Gemini verwendet deshalb seinen eigenen Standardmodus."
            ),
            None => "Gemini verwendet seinen eigenen Standardmodus.".to_owned(),
        })
    } else if available_modes.is_empty() {
        Some(
            "Gemini hat noch keine Projektmodi angeboten. Erstelle oder lade zuerst eine Session."
                .to_owned(),
        )
    } else {
        None
    };
    ProjectApprovalPolicy {
        project_id: project.project.id.clone(),
        mode_id: project.project.approval_mode_id.clone(),
        state: project.project.approval_mode_state.clone(),
        current_mode_id: modes.and_then(|snapshot| snapshot.current_mode_id.clone()),
        available_modes,
        message,
    }
}

pub fn validate_unrestricted_confirmation(
    mode: &ProjectApprovalMode,
    confirmed: bool,
) -> Result<(), AppError> {
    if is_unrestricted_mode(mode) && !confirmed {
        return Err(AppError::Validation(
            "Der Modus „Alles erlauben“ benötigt eine ausdrückliche Bestätigung, da Gemini damit Tools ohne einzelne Rückfrage ausführen darf.".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::contracts::{
        ApprovalModeSnapshot, ProjectApprovalMode, ProjectApprovalModeState,
    };
    use super::apply_project_approval_mode;
    use crate::error::AppError;

    fn modes() -> ApprovalModeSnapshot {
        ApprovalModeSnapshot {
            current_mode_id: Some("default".to_owned()),
            available_modes: vec![
                ProjectApprovalMode {
                    id: "default".to_owned(),
                    name: "Default".to_owned(),
                    description: None,
                    unrestricted: false,
                },
                ProjectApprovalMode {
                    id: "runtime-offered".to_owned(),
                    name: "Runtime offered".to_owned(),
                    description: None,
                    unrestricted: false,
                },
            ],
        }
    }

    #[test]
    fn applies_only_advertised_modes() {
        let snapshot = modes();
        let mut called = false;
        let result = block_on(apply_project_approval_mode(
            Some("runtime-offered"),
            Some(&snapshot),
            |_id| {
                called = true;
                async { Ok::<_, AppError>(()) }
            },
        ));
        assert_eq!(
            result,
            (
                Some("runtime-offered".to_owned()),
                ProjectApprovalModeState::Available
            )
        );
        assert!(called);
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        use std::sync::Arc;
        use std::task::{Context, Poll, Wake, Waker};
        struct Noop;
        impl Wake for Noop {
            fn wake(self: Arc<Self>) {}
        }
        let waker: Waker = Arc::new(Noop).into();
        let mut future = Box::pin(future);
        let mut context = Context::from_waker(&waker);
        loop {
            if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
                return value;
            }
        }
    }
}
