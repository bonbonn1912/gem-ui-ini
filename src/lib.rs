pub mod acp;
pub mod attachments;
pub mod constants;
pub mod context_attachments;
pub mod db;
pub mod error;
pub mod extensions;
pub mod external;
pub mod git;
pub mod gitlab;
pub mod hub;
pub mod idempotency;
pub mod integrations;
pub mod jira;
pub mod links;
pub mod processes;
pub mod project_files;
pub mod projects;
pub mod sessions;
pub mod settings;
pub mod state;
pub mod todos;
pub mod updates;

pub use hub::SubscriptionHub;
pub use idempotency::{idempotent, ClientRequestRepo};

use crate::acp::AcpProcessConfig;
use crate::attachments::{AttachmentRepository, AttachmentService};
use crate::context_attachments::{ContextAttachmentService, ContextAttachmentSubscriptionHub};
use crate::error::AppError;
use crate::extensions::{AgentExtensionCommandState, AgentExtensionService};
use crate::git::{GitCommandState, GitService};
use crate::gitlab::{
    GitLabCommandState, GitLabRepository, GitLabService, GitLabTokenVault, HybridSecretStorage,
    KeyringStorage, ReqwestGitLabTransport, ReviewContextSnapshotStore,
};
use crate::integrations::IntegrationCommandState;
use crate::jira::{ContextAttachmentIngestor, JiraCommandState, JiraRepository, JiraService};
use crate::links::{LinkMetadataFetcherService, PreviewHost};
use crate::processes::binary_probe::{
    resolve_executable, resolve_gemini_launch, Environment, ProbePlatform,
};
use crate::project_files::ProjectFileService;
use crate::projects::ProjectWithRoots;
use crate::sessions::commands::ResolvedExternalContext;
use crate::sessions::{
    EventRepository, ProcessConfigFactory, SessionCommandService, SessionEventPipeline,
    SessionRepository, SessionService, UsageRepository, UsageService,
};
use crate::settings::{SettingsCommandState, SettingsRepository};
use crate::state::AppState;
use crate::todos::{TodoService, TodoSubscriptionHub};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, State};

#[tauri::command]
async fn get_capabilities(
    state: State<'_, SettingsCommandState>,
) -> Result<settings::AppCapabilities, AppError> {
    settings::commands::current_capabilities(&state).await
}

fn process_config_factory(settings: SettingsRepository) -> ProcessConfigFactory {
    Arc::new(move |_session, project: &ProjectWithRoots| {
        let configured = settings
            .gemini()?
            .and_then(|value| value.binary_path)
            .unwrap_or_else(|| "gemini".to_owned());
        let environment: Environment = std::env::vars().collect();
        let resolved = resolve_executable(&configured, &environment)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        let launch = resolve_gemini_launch(&resolved, &environment, ProbePlatform::current())
            .map_err(|error| AppError::Validation(error.to_string()))?;
        let primary = project
            .roots
            .iter()
            .find(|root| matches!(root.kind, projects::ProjectRootKind::Primary))
            .ok_or_else(|| AppError::Internal("Projekt besitzt keinen Hauptordner.".to_owned()))?;
        let mut config = AcpProcessConfig::new(launch.executable_path, &primary.real_path);
        config.args = launch
            .executable_args
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        config.additional_roots = project
            .roots
            .iter()
            .filter(|root| matches!(root.kind, projects::ProjectRootKind::Additional))
            .map(|root| PathBuf::from(&root.real_path))
            .collect();
        Ok(config)
    })
}

fn setup_application(app: &mut tauri::App) -> Result<(), AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Internal(error.to_string()))?;
    std::fs::create_dir_all(&data_dir)?;
    let state = AppState::open(data_dir.join("geminui.sqlite"))?;
    let db = state.db.clone();
    let projects = state.shared_project_service();
    let manager = Arc::clone(&state.sessions);

    let attachments = Arc::new(AttachmentService::new(
        &data_dir,
        AttachmentRepository::new(db.clone()),
    )?);
    let context_attachments = Arc::new(ContextAttachmentService::new(&data_dir, db.clone())?);
    context_attachments.initialize()?;
    let project_files = Arc::new(ProjectFileService::new(db.clone()));
    let todos = TodoService::new(db.clone(), (*context_attachments).clone());
    let context_hub = ContextAttachmentSubscriptionHub::default();
    let todo_hub = TodoSubscriptionHub::default();
    let link_fetcher = LinkMetadataFetcherService::production()?;
    let preview = PreviewHost::new(data_dir.join("link-preview"));

    let settings_repository = SettingsRepository::new(db.clone());
    let git_binary = settings_repository
        .git()?
        .and_then(|value| value.binary_path)
        .map(PathBuf::from);
    let git_service = Arc::new(GitService::new(Arc::clone(&projects), git_binary));
    let git_state = GitCommandState::new(Arc::clone(&git_service), SubscriptionHub::new());

    let secret_storage = HybridSecretStorage::new(
        data_dir.join("secrets/gitlab-master-key"),
        Some(KeyringStorage::new(
            "dev.geminui.desktop",
            "gitlab-token-master-key",
        )),
    )
    .map_err(AppError::Internal)?;
    let gitlab_service = Arc::new(GitLabService {
        repository: GitLabRepository::new(db.clone()),
        vault: GitLabTokenVault::new(Arc::new(secret_storage)),
        transport_factory: Arc::new(|connection, _token| {
            ReqwestGitLabTransport::new(Duration::from_secs(15), connection.allow_self_signed_tls)
        }),
    });
    let review_snapshots = Arc::new(ReviewContextSnapshotStore::new(Duration::from_secs(600)));
    let gitlab_state = GitLabCommandState::new(
        Arc::clone(&gitlab_service),
        Arc::clone(&projects),
        Arc::clone(&git_service),
        SubscriptionHub::new(),
    )
    .with_review_context_snapshots(Arc::clone(&review_snapshots));

    let jira_ingestor: Arc<dyn ContextAttachmentIngestor> =
        Arc::new((*context_attachments).clone());
    let jira_state = JiraCommandState {
        service: Arc::new(JiraService {
            repository: JiraRepository::new(db.clone()),
            context_attachments: jira_ingestor,
        }),
    };
    let extension_state = AgentExtensionCommandState {
        service: Arc::new(AgentExtensionService::new(Arc::clone(&projects))),
    };

    let session_repository = SessionRepository::new(db.clone());
    let event_repository = EventRepository::new(db.clone());
    let usage = UsageService::new(UsageRepository::new(db.clone()));
    let event_pipeline = SessionEventPipeline::new(
        Arc::clone(&manager),
        session_repository.clone(),
        event_repository.clone(),
        Some(usage),
        SubscriptionHub::new(),
    );
    let session_service =
        SessionService::new(session_repository, event_repository, Arc::clone(&manager))
            .with_pipeline(event_pipeline.clone());

    let external_resolver = {
        let snapshots = Arc::clone(&review_snapshots);
        Arc::new(
            move |session: sessions::AppSession, project: ProjectWithRoots, reference: Value| {
                let snapshots = Arc::clone(&snapshots);
                Box::pin(async move {
                    if session.project_id != project.project.id
                        || reference.get("kind").and_then(Value::as_str) != Some("gitlab_review")
                    {
                        return Err(AppError::Conflict(
                            "Der externe Kontext gehört nicht zu dieser Session.".to_owned(),
                        ));
                    }
                    let id = reference
                        .get("id")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .ok_or_else(|| {
                            AppError::Validation("GitLab-Kontext-ID fehlt.".to_owned())
                        })?;
                    let root_ids = project
                        .roots
                        .iter()
                        .map(|root| root.id.clone())
                        .collect::<Vec<_>>();
                    let (prepared, parts) = snapshots
                        .consume_for_project(
                            id,
                            &project.project.id,
                            project.project.root_revision,
                            &root_ids,
                        )?
                        .ok_or_else(|| {
                            AppError::Conflict(
                                "Der GitLab-Kontext ist abgelaufen oder wurde bereits verwendet."
                                    .to_owned(),
                            )
                        })?;
                    ResolvedExternalContext::gitlab(prepared, parts)
                })
                    as std::pin::Pin<
                        Box<
                            dyn std::future::Future<
                                    Output = Result<ResolvedExternalContext, AppError>,
                                > + Send,
                        >,
                    >
            },
        )
    };
    let session_commands = SessionCommandService::new(
        session_service,
        projects::ProjectRepository::new(db.clone()),
        ClientRequestRepo::new(db.clone()),
        event_pipeline,
        process_config_factory(settings_repository.clone()),
    )
    .with_attachment_service(Arc::clone(&attachments))
    .with_context_attachment_service(Arc::clone(&context_attachments))
    .with_project_file_service(Arc::clone(&project_files))
    .with_external_context_resolver(external_resolver);

    let manager_for_change = Arc::clone(&manager);
    let settings_state = SettingsCommandState::new(settings_repository)?
        .with_git_service(Arc::clone(&git_service))
        .with_gemini_binary_change_hook(Arc::new(move |_path| {
            let manager = Arc::clone(&manager_for_change);
            Box::pin(async move {
                let snapshots = manager.snapshots().await;
                if snapshots.iter().any(|snapshot| snapshot.status != acp::SessionStatus::Idle) {
                    return Err(AppError::Conflict("Die Gemini-Binärdatei kann während einer laufenden Anfrage nicht gewechselt werden.".to_owned()));
                }
                for snapshot in snapshots {
                    manager.close(&snapshot.id).await.map_err(|error| AppError::Upstream(error.to_string()))?;
                }
                Ok(())
            })
        }));

    app.manage((*attachments).clone());
    app.manage((*context_attachments).clone());
    app.manage((*project_files).clone());
    app.manage(todos);
    app.manage(context_hub);
    app.manage(todo_hub);
    app.manage(link_fetcher);
    app.manage(preview);
    app.manage(git_state);
    app.manage(gitlab_state);
    app.manage(jira_state);
    app.manage(extension_state);
    app.manage(settings_state);
    app.manage(IntegrationCommandState::new(db));
    app.manage(session_commands);
    app.manage(state);
    Ok(())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(updates::updater_plugin())
        .invoke_handler(tauri::generate_handler![
            get_capabilities,
            projects::commands::projects_list,
            projects::commands::projects_get,
            projects::commands::projects_reauthorize_root,
            projects::commands::projects_get_approval_policy,
            project_files::commands::project_files_search,
            projects::commands::projects_pick_folders,
            projects::commands::projects_create,
            projects::commands::projects_rename,
            projects::commands::projects_set_archived,
            projects::commands::projects_set_additional_roots,
            projects::commands::projects_set_approval_policy,
            projects::commands::projects_delete,
            sessions::commands::sessions_list,
            sessions::commands::sessions_create,
            sessions::commands::sessions_update,
            sessions::commands::sessions_delete,
            sessions::commands::sessions_send_prompt,
            sessions::commands::sessions_cancel_turn,
            sessions::commands::sessions_respond_to_permission,
            sessions::commands::sessions_set_mode,
            sessions::commands::sessions_set_model,
            sessions::commands::sessions_get_reconnect_state,
            sessions::commands::sessions_search,
            settings::commands::settings_choose_gemini_binary,
            settings::commands::settings_choose_git_binary,
            attachments::commands::attachments_pick_images,
            attachments::commands::attachments_stage_dropped_paths,
            attachments::commands::attachments_stage_clipboard_image,
            attachments::commands::attachments_get_preview,
            attachments::commands::attachments_remove,
            context_attachments::commands::context_attachments_list,
            context_attachments::commands::context_attachments_add_files,
            context_attachments::commands::context_attachments_add_link,
            context_attachments::commands::context_attachments_update,
            context_attachments::commands::context_attachments_set_inclusion,
            context_attachments::commands::context_attachments_remove,
            context_attachments::commands::context_attachments_refresh_link_preview,
            context_attachments::commands::context_attachments_get_bytes,
            context_attachments::subscriptions::context_attachments_subscribe,
            context_attachments::subscriptions::context_attachments_unsubscribe,
            context_attachments::commands::context_attachments_open_file,
            todos::commands::todos_list,
            todos::commands::todos_create,
            todos::commands::todos_update,
            todos::commands::todos_reorder,
            todos::commands::todos_delete,
            todos::commands::todos_add_files,
            todos::commands::todos_add_link,
            todos::commands::todos_attach_attachment,
            todos::commands::todos_detach_attachment,
            todos::commands::todos_prepare_for_session,
            todos::subscriptions::todos_subscribe,
            todos::subscriptions::todos_unsubscribe,
            links::commands::link_preview_open,
            links::commands::link_preview_set_bounds,
            links::commands::link_preview_close,
            links::commands::link_preview_clear_storage,
            sessions::commands::events_subscribe_session,
            sessions::commands::events_unsubscribe_session,
            git::commands::git_list_project_repositories,
            git::commands::git_get_project_status,
            git::commands::git_get_file_diff,
            git::commands::git_subscribe_project_status,
            git::commands::git_unsubscribe_project_status,
            integrations::integrations_list_project,
            gitlab::commands::gitlab_list_repository_candidates,
            gitlab::commands::gitlab_list_connections,
            gitlab::commands::gitlab_test_connection,
            gitlab::commands::gitlab_save_connection,
            gitlab::commands::gitlab_replace_token,
            gitlab::commands::gitlab_remove_connection,
            gitlab::commands::gitlab_enable_binding,
            gitlab::commands::gitlab_disable_binding,
            gitlab::commands::gitlab_list_merge_requests,
            gitlab::commands::gitlab_select_merge_request,
            gitlab::commands::gitlab_connect_merge_request_url,
            gitlab::commands::gitlab_get_review_state,
            gitlab::commands::gitlab_subscribe_review_state,
            gitlab::commands::gitlab_unsubscribe_review_state,
            gitlab::commands::gitlab_prepare_review_context,
            gitlab::commands::gitlab_resolve_discussion,
            gitlab::commands::gitlab_reply_to_discussion,
            jira::commands::jira_list_configs,
            jira::commands::jira_save_config,
            jira::commands::jira_delete_config,
            jira::commands::jira_get_project_integration,
            jira::commands::jira_activate_project_integration,
            jira::commands::jira_deactivate_project_integration,
            jira::commands::jira_attach_issue,
            extensions::commands::agent_extensions_list_skills,
            extensions::commands::agent_extensions_list_mcp_servers,
            external::external_open_https_url,
            updates::plugin::app_check_for_updates,
            updates::plugin::app_download_update,
            updates::plugin::app_install_update,
        ])
        .setup(|app| {
            setup_application(app)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building GeminUI");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(state) = handle.try_state::<AppState>() {
                let manager = Arc::clone(&state.sessions);
                let _ = tauri::async_runtime::block_on(manager.dispose());
            }
        }
    });
}
