//! Tauri command boundary for sessions and ordered event subscriptions.
//! Materialized from the checked sessions snapshot; project approval helpers
//! and one-shot test synchronization are intentionally retained.
//!
//! The application root owns construction/wiring of this service.  Keeping
//! the command state independent of `AppState` lets the sessions vertical
//! slice be integrated without changing the central state module.

use super::capabilities::SessionCapabilities;
use super::contracts::*;
use super::event_pipeline::SessionEventPipeline;
use super::event_repository::StreamEnvelope;
use super::service::SessionService;
use crate::acp::AcpProcessConfig;
use crate::attachments::AttachmentService;
use crate::context_attachments::{ContextAttachmentService, PromptPart as ContextPromptPart};
use crate::error::AppError;
use crate::hub::Subscription;
use crate::idempotency::{idempotent, ClientRequestRepo};
use crate::project_files::{
    ProjectFileReferenceInput, ProjectFileService, PromptPart as ProjectPromptPart,
};
use crate::projects::{
    ApprovalModeSnapshot, ProjectApprovalMode, ProjectRepository, ProjectWithRoots,
};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tauri::{ipc::Channel, State};
use tokio::sync::Mutex;
use uuid::Uuid;

pub type ProcessConfigFactory =
    Arc<dyn Fn(&AppSession, &ProjectWithRoots) -> Result<AcpProcessConfig, AppError> + Send + Sync>;

/// A prepared external context is deliberately resolved immediately before a
/// turn.  The resolver is where the GitLab service consumes its short-lived
/// prepared reference, checks the current root/session binding and returns
/// the exact ACP parts plus renderer snapshot.  Keeping this as a callback
/// avoids making the sessions slice depend on a concrete GitLab transport.
pub type ExternalContextResolver = Arc<
    dyn Fn(
            AppSession,
            ProjectWithRoots,
            Value,
        )
            -> Pin<Box<dyn Future<Output = Result<ResolvedExternalContext, AppError>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone, Debug)]
pub struct ResolvedExternalContext {
    pub parts: Vec<Value>,
    pub snapshot: Value,
}

impl ResolvedExternalContext {
    /// Adapter for the existing GitLab prepared-context contract.  A caller
    /// still owns the resolver and therefore decides how the one-shot/TTL
    /// reference is consumed; this function only performs strict shape
    /// conversion at the ACP boundary.
    pub fn gitlab(
        prepared: crate::gitlab::PreparedExternalContext,
        parts: Vec<crate::gitlab::ReviewPromptPart>,
    ) -> Result<Self, AppError> {
        if prepared.reference.kind != "gitlab_review"
            || prepared.reference.id.trim().is_empty()
            || prepared.title.trim().is_empty()
            || prepared.repository_label.trim().is_empty()
            || prepared.merge_request_reference.trim().is_empty()
            || !matches!(
                prepared.context_mode.as_str(),
                "affected_lines" | "whole_file" | "comment_only"
            )
            || prepared.expires_at.trim().is_empty()
        {
            return Err(AppError::Validation(
                "GitLab-Kontextreferenz ist ungültig oder abgelaufen.".to_owned(),
            ));
        }
        if prepared.start_line.is_some_and(|line| line == 0)
            || prepared.end_line.is_some_and(|line| line == 0)
        {
            return Err(AppError::Validation(
                "GitLab-Zeilennummer muss positiv sein.".to_owned(),
            ));
        }
        let snapshot = serde_json::json!({
            "kind": prepared.reference.kind,
            "id": prepared.reference.id,
            "title": prepared.title,
            "repositoryLabel": prepared.repository_label,
            "mergeRequestReference": prepared.merge_request_reference,
            "filePath": prepared.file_path,
            "startLine": prepared.start_line,
            "endLine": prepared.end_line,
            "contextMode": prepared.context_mode,
        });
        let parts = parts
            .into_iter()
            .map(|part| serde_json::json!({"type": part.r#type, "text": part.text}))
            .collect();
        Ok(Self { parts, snapshot })
    }
}

#[derive(Clone, Debug)]
struct PreparedPrompt {
    acp: Value,
    user_event: Value,
    attachment_ids: Vec<String>,
}

pub struct SessionCommandService {
    pub service: SessionService,
    pub projects: ProjectRepository,
    pub client_requests: ClientRequestRepo,
    pub pipeline: SessionEventPipeline,
    config_factory: ProcessConfigFactory,
    attachments: Option<Arc<AttachmentService>>,
    context_attachments: Option<Arc<ContextAttachmentService>>,
    project_files: Option<Arc<ProjectFileService>>,
    external_context_resolver: Option<ExternalContextResolver>,
    subscriptions: Mutex<HashMap<String, Subscription<String, Vec<StreamEnvelope>>>>,
    pipeline_tasks: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    active_turns: Arc<Mutex<HashMap<String, String>>>,
}

impl SessionCommandService {
    pub fn new(
        service: SessionService,
        projects: ProjectRepository,
        client_requests: ClientRequestRepo,
        pipeline: SessionEventPipeline,
        config_factory: ProcessConfigFactory,
    ) -> Self {
        Self {
            service,
            projects,
            client_requests,
            pipeline,
            config_factory,
            attachments: None,
            context_attachments: None,
            project_files: None,
            external_context_resolver: None,
            subscriptions: Mutex::new(HashMap::new()),
            pipeline_tasks: Mutex::new(HashMap::new()),
            active_turns: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn with_attachment_service(mut self, attachments: Arc<AttachmentService>) -> Self {
        self.attachments = Some(attachments);
        self
    }

    pub fn with_context_attachment_service(
        mut self,
        service: Arc<ContextAttachmentService>,
    ) -> Self {
        self.context_attachments = Some(service);
        self
    }

    pub fn with_project_file_service(mut self, service: Arc<ProjectFileService>) -> Self {
        self.project_files = Some(service);
        self
    }

    pub fn with_external_context_resolver(mut self, resolver: ExternalContextResolver) -> Self {
        self.external_context_resolver = Some(resolver);
        self
    }

    /// Runtime inspection used by cancellation UX and idle guards.
    pub async fn active_turn(&self, session_id: &str) -> Option<String> {
        self.active_turns.lock().await.get(session_id).cloned()
    }

    /// Stops the active turn without closing the ACP process.  ACP
    /// `session/cancel` ends a turn, not the process; the manager waits for
    /// the correlated `stopReason=cancelled` response.
    pub async fn stop_active_turn(&self, session_id: &str) -> Result<(), AppError> {
        self.service.cancel(session_id).await
    }

    async fn reserve_turn(&self, session_id: &str, turn_id: &str) -> Result<(), AppError> {
        let mut turns = self.active_turns.lock().await;
        if let Some(existing) = turns.get(session_id) {
            return Err(AppError::Conflict(format!(
                "session already has active turn '{existing}'"
            )));
        }
        turns.insert(session_id.to_owned(), turn_id.to_owned());
        Ok(())
    }

    async fn release_turn_if_current(&self, session_id: &str, turn_id: &str) {
        let mut turns = self.active_turns.lock().await;
        if turns
            .get(session_id)
            .is_some_and(|current| current == turn_id)
        {
            turns.remove(session_id);
        }
    }

    async fn ensure_process(&self, session: &AppSession) -> Result<AppSession, AppError> {
        let opened = self.service.manager.snapshot(&session.id).await.is_none();
        if opened {
            let project = self.projects.get_by_id(&session.project_id)?;
            let config = (self.config_factory)(session, &project)?;
            self.service.open_process(&session.id, config).await?;
        }
        // Subscribe before `session/new`: providers are allowed to announce
        // readiness/options as notifications while that request is pending.
        let mut tasks = self.pipeline_tasks.lock().await;
        if tasks
            .get(&session.id)
            .is_some_and(|task| task.is_finished())
        {
            tasks.remove(&session.id);
        }
        if !tasks.contains_key(&session.id) {
            let task = self.pipeline.spawn(session.id.clone()).await?;
            tasks.insert(session.id.clone(), task);
        }
        drop(tasks);
        let mut current = session.clone();
        if opened || current.provider_session_id.is_none() {
            let project = self.projects.get_by_id(&session.project_id)?;
            let primary = project
                .roots
                .iter()
                .find(|root| matches!(root.kind, crate::projects::ProjectRootKind::Primary))
                .ok_or_else(|| AppError::Internal("project has no primary root".to_owned()))?;
            let had_provider_session = current.provider_session_id.is_some();
            let can_load = self
                .service
                .capability_snapshot(&session.id)
                .await
                .map(|capabilities| capabilities.load_session)
                .unwrap_or(false);
            let (response, operation) = if can_load {
                if let Some(provider_id) = current.provider_session_id.as_deref() {
                    match self
                        .service
                        .manager
                        .session_load(&session.id, provider_id, &primary.real_path)
                        .await
                    {
                        Ok(response) => (response, "load"),
                        Err(_) => (
                            self.service
                                .manager
                                .session_new(&session.id, &primary.real_path)
                                .await
                                .map_err(|error| AppError::Upstream(error.to_string()))?,
                            "new",
                        ),
                    }
                } else {
                    (
                        self.service
                            .manager
                            .session_new(&session.id, &primary.real_path)
                            .await
                            .map_err(|error| AppError::Upstream(error.to_string()))?,
                        "new",
                    )
                }
            } else {
                (
                    self.service
                        .manager
                        .session_new(&session.id, &primary.real_path)
                        .await
                        .map_err(|error| AppError::Upstream(error.to_string()))?,
                    "new",
                )
            };
            let capabilities = SessionCapabilities::from_initialize(&response);
            self.service
                .cache_capabilities(&session.id, capabilities.clone())
                .await;
            let provider_id = response
                .get("sessionId")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| current.provider_session_id.clone())
                .ok_or_else(|| {
                    AppError::Upstream("ACP session/new response omitted sessionId".to_owned())
                })?;
            self.service
                .manager
                .set_provider_session_id(&session.id, provider_id.clone())
                .await;
            current = self.service.sessions.update(
                &session.id,
                super::contracts::SessionUpdate {
                    provider_session_id: Some(Some(provider_id.clone())),
                    available_models: Some(capabilities.models.clone()),
                    available_modes: Some(capabilities.modes.clone()),
                    status: Some(SessionStatus::Idle),
                    updated_at: super::event_pipeline::now_iso(),
                    ..Default::default()
                },
            )?;
            if let Some(pipeline) = &self.service.live {
                let _ = pipeline.append_event(
                    &session.id,
                    None,
                    serde_json::json!({"type":"session.started","providerSessionId":provider_id}),
                );
                let _ = pipeline.append_event(&session.id, None, serde_json::json!({"type":"session.ready","modes":current.available_modes.iter().map(|option| option.id.clone()).collect::<Vec<_>>(),"models":current.available_models.iter().map(|option| option.id.clone()).collect::<Vec<_>>()}));
            }
            if had_provider_session && operation == "new" {
                self.service.mark_reconnected(&session.id).await;
            } else if operation == "load" {
                self.service.clear_reconnected(&session.id).await;
            }
        }
        Ok(current)
    }

    async fn current_project(&self, session: &AppSession) -> Result<ProjectWithRoots, AppError> {
        self.projects.get_by_id(&session.project_id)
    }

    /// Returns the modes advertised by a live project session. When requested,
    /// an existing persisted session is opened so project settings never
    /// present invented provider modes.
    pub async fn project_approval_snapshot(
        &self,
        project_id: &str,
        open_if_needed: bool,
    ) -> Result<Option<ApprovalModeSnapshot>, AppError> {
        self.projects.get_by_id(project_id)?;
        let sessions = self.service.sessions.list_by_project(project_id, true)?;
        let mut selected = None;
        for session in &sessions {
            if self.service.manager.snapshot(&session.id).await.is_some() {
                selected = Some(self.service.sessions.get_by_id(&session.id)?);
                break;
            }
        }
        if selected.is_none() && open_if_needed {
            if let Some(candidate) = sessions
                .iter()
                .find(|session| !session.archived)
                .or_else(|| sessions.first())
            {
                selected = Some(self.ensure_process(candidate).await?);
            }
        }
        Ok(selected.map(|session| ApprovalModeSnapshot {
            current_mode_id: session.mode,
            available_modes: session
                .available_modes
                .into_iter()
                .map(|mode| ProjectApprovalMode {
                    unrestricted: mode.id == "yolo",
                    id: mode.id,
                    name: mode.name,
                    description: mode.description,
                })
                .collect(),
        }))
    }

    /// Applies one project mode atomically to every active project session.
    /// Validation runs for all sessions before the first provider is mutated.
    pub async fn apply_project_mode(
        &self,
        project_id: &str,
        mode_id: &str,
    ) -> Result<ApprovalModeSnapshot, AppError> {
        let sessions = self.service.sessions.list_by_project(project_id, true)?;
        let mut active = Vec::new();
        for session in sessions {
            if self.service.manager.snapshot(&session.id).await.is_some() {
                let current = self.service.sessions.get_by_id(&session.id)?;
                if !current
                    .available_modes
                    .iter()
                    .any(|mode| mode.id == mode_id)
                {
                    return Err(AppError::Conflict(
                        "Mindestens eine aktive Gemini-Session bietet diesen Modus nicht an. Die Projekteinstellung wurde nicht geändert.".to_owned(),
                    ));
                }
                active.push(current);
            }
        }
        if active.is_empty() {
            let _ = self.project_approval_snapshot(project_id, true).await?;
            for session in self.service.sessions.list_by_project(project_id, true)? {
                if self.service.manager.snapshot(&session.id).await.is_some() {
                    if !session
                        .available_modes
                        .iter()
                        .any(|mode| mode.id == mode_id)
                    {
                        return Err(AppError::Conflict(
                            "Die aktive Gemini-Session bietet diesen Modus nicht an.".to_owned(),
                        ));
                    }
                    active.push(session);
                }
            }
        }
        if active.is_empty() {
            return Err(AppError::Validation(
                "Dieser Modus wurde von keiner aktuellen Gemini-ACP-Session angeboten.".to_owned(),
            ));
        }
        for session in active {
            if session.mode.as_deref() != Some(mode_id) {
                self.service
                    .set_mode(&session.id, mode_id, super::event_pipeline::now_iso())
                    .await?;
            }
        }
        self.project_approval_snapshot(project_id, false)
            .await?
            .ok_or_else(|| AppError::Internal("Projektmodus-Snapshot fehlt.".to_owned()))
    }

    async fn prepare_prompt(
        &self,
        session: &AppSession,
        project: &ProjectWithRoots,
        input: &SendPromptInput,
    ) -> Result<PreparedPrompt, AppError> {
        let capabilities = self
            .service
            .capability_snapshot(&session.id)
            .await
            .unwrap_or_default();
        let mut blocks = Vec::new();
        if !input.text.trim().is_empty() {
            blocks.push(serde_json::json!({"type":"text", "text": input.text}));
        }

        let mut attachment_ids = Vec::new();
        if !input.attachment_ids.is_empty() {
            let attachments = self.attachments.as_ref().ok_or_else(|| {
                AppError::Internal("attachment service is not wired for image prompts".to_owned())
            })?;
            for image in attachments.prompt_images(&input.attachment_ids)? {
                attachment_ids.push(image.id.clone());
                blocks.push(serde_json::json!({
                    "type": "image",
                    "data": image.data,
                    "mimeType": image.mime_type
                }));
            }
        }

        let mut context_snapshots = Vec::<Value>::new();
        if !input.context_attachment_ids.is_empty() {
            let context_service = self.context_attachments.as_ref().ok_or_else(|| {
                AppError::Internal("context attachment service is not wired".to_owned())
            })?;
            let (parts, snapshots) = context_service.build_prompt_context(
                &project.project.id,
                &session.id,
                &input.context_attachment_ids,
                capabilities.image_prompt,
            )?;
            context_snapshots = snapshots
                .into_iter()
                .map(serde_json::to_value)
                .collect::<Result<_, _>>()?;
            blocks.extend(parts.into_iter().map(context_part_to_acp));
        }

        let mut project_snapshots = Vec::<Value>::new();
        if !input.project_files.is_empty() {
            let project_file_service = self.project_files.as_ref().ok_or_else(|| {
                AppError::Internal("project file service is not wired".to_owned())
            })?;
            let references = input
                .project_files
                .iter()
                .cloned()
                .map(serde_json::from_value::<ProjectFileReferenceInput>)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| {
                    AppError::Validation(format!("Ungültige Projektdateireferenz: {error}"))
                })?;
            let context = project_file_service.build_prompt_context(
                &project.project.id,
                input.expected_root_revision,
                &references,
            )?;
            project_snapshots = context
                .snapshots
                .into_iter()
                .map(serde_json::to_value)
                .collect::<Result<_, _>>()?;
            blocks.extend(context.parts.into_iter().map(project_part_to_acp));
        }

        let mut external_snapshots = Vec::<Value>::new();
        if !input.external_context_refs.is_empty() {
            let resolver = self.external_context_resolver.as_ref().ok_or_else(|| {
                AppError::Internal("external context resolver is not wired".to_owned())
            })?;
            for reference in &input.external_context_refs {
                let resolved =
                    (resolver)(session.clone(), project.clone(), reference.clone()).await?;
                if resolved.snapshot.get("kind").and_then(Value::as_str) != Some("gitlab_review")
                    || resolved
                        .snapshot
                        .get("id")
                        .and_then(Value::as_str)
                        .is_none()
                {
                    return Err(AppError::Validation(
                        "Externer Kontext-Snapshot ist ungültig oder veraltet.".to_owned(),
                    ));
                }
                external_snapshots.push(resolved.snapshot);
                blocks.extend(resolved.parts);
            }
        }

        if blocks.is_empty() {
            return Err(AppError::Validation(
                "prompt requires text or an attachment".to_owned(),
            ));
        }
        capabilities.validate_prompt(&Value::Array(blocks.clone()))?;

        let history_mode = input
            .history_mode
            .clone()
            .unwrap_or(PromptHistoryMode::Compressed);
        let reconnect = self.service.reconnect_state(&session.id).await?;
        if reconnect.reconnected && matches!(history_mode, PromptHistoryMode::Compressed) {
            if let Some(history) = self.service.compressed_history(&session.id)? {
                blocks.insert(
                    0,
                    serde_json::json!({
                        "type":"text",
                        "text": format!("[Previous GeminUI session history]\n{history}")
                    }),
                );
            }
        }

        let mut user_event = serde_json::json!({
            "type": "message.user",
            "messageId": Value::Null,
            "text": input.text.clone(),
            "attachmentIds": input.attachment_ids.clone(),
        });
        if !context_snapshots.is_empty() {
            user_event["contextAttachments"] = Value::Array(context_snapshots);
        }
        if !project_snapshots.is_empty() {
            user_event["projectFiles"] = Value::Array(project_snapshots);
        }
        if !external_snapshots.is_empty() {
            user_event["externalContexts"] = Value::Array(external_snapshots);
        }
        Ok(PreparedPrompt {
            acp: Value::Array(blocks),
            user_event,
            attachment_ids,
        })
    }

    async fn start_background_turn(
        &self,
        session: &AppSession,
        turn_id: String,
        mut prepared: PreparedPrompt,
    ) -> Result<(), AppError> {
        self.reserve_turn(&session.id, &turn_id).await?;
        prepared.user_event["messageId"] = Value::String(turn_id.clone());
        if let Err(error) = (|| -> Result<(), AppError> {
            if let Some(attachments) = &self.attachments {
                let mut unique = std::collections::HashSet::new();
                for id in &prepared.attachment_ids {
                    if unique.insert(id.clone()) {
                        attachments
                            .repository()
                            .mark_sent(id, &session.id, &turn_id)?;
                    }
                }
            }
            self.service.update(
                &session.id,
                super::contracts::SessionUpdate {
                    status: Some(SessionStatus::Running),
                    title: if session.title == "Neue Session"
                        && !prepared.user_event["text"]
                            .as_str()
                            .unwrap_or_default()
                            .trim()
                            .is_empty()
                    {
                        Some(generate_session_title(
                            prepared.user_event["text"].as_str().unwrap_or_default(),
                        ))
                    } else {
                        None
                    },
                    updated_at: super::event_pipeline::now_iso(),
                    ..Default::default()
                },
            )?;
            if let Some(pipeline) = &self.service.live {
                let _ = pipeline.append_event(
                    &session.id,
                    Some(turn_id.clone()),
                    prepared.user_event.clone(),
                )?;
            }
            Ok(())
        })() {
            self.release_turn_if_current(&session.id, &turn_id).await;
            return Err(error);
        }

        let service = self.service.clone();
        let projects = self.projects.clone();
        let active_turns = Arc::clone(&self.active_turns);
        let session_id = session.id.clone();
        tokio::spawn(async move {
            let mut result = service
                .prompt_with_turn(&session_id, turn_id.clone(), prepared.acp.clone())
                .await;
            if let Err(ref error) = result {
                let err_msg = error.to_string();
                if err_msg.contains("Session not found") || err_msg.contains("-32602") {
                    if let Ok(sess) = service.sessions.get_by_id(&session_id) {
                        if let Ok(project) = projects.get_by_id(&sess.project_id) {
                            if let Some(primary) = project
                                .roots
                                .iter()
                                .find(|root| matches!(root.kind, crate::projects::ProjectRootKind::Primary))
                            {
                                if let Ok(response) = service
                                    .manager
                                    .session_new(&session_id, &primary.real_path)
                                    .await
                                {
                                    if let Some(new_provider_id) =
                                        response.get("sessionId").and_then(|v| v.as_str())
                                    {
                                        let _ = service.sessions.update(
                                            &session_id,
                                            super::contracts::SessionUpdate {
                                                provider_session_id: Some(Some(
                                                    new_provider_id.to_owned(),
                                                )),
                                                updated_at: super::event_pipeline::now_iso(),
                                                ..Default::default()
                                            },
                                        );
                                    }
                                    result = service
                                        .prompt_with_turn(&session_id, turn_id.clone(), prepared.acp)
                                        .await;
                                }
                            }
                        }
                    }
                }
            }
            let current = service.sessions.get_by_id(&session_id).ok();
            let status = match current.as_ref().map(|value| &value.status) {
                Some(SessionStatus::Disconnected) => None,
                _ => Some(if result.is_ok() {
                    SessionStatus::Idle
                } else {
                    SessionStatus::Error
                }),
            };
            if let Some(status) = status {
                let _ = service.sessions.update(
                    &session_id,
                    super::contracts::SessionUpdate {
                        status: Some(status),
                        updated_at: super::event_pipeline::now_iso(),
                        ..Default::default()
                    },
                );
            }
            if result.is_ok() {
                service.clear_reconnected(&session_id).await;
            }
            let mut turns = active_turns.lock().await;
            if turns
                .get(&session_id)
                .is_some_and(|current| current == &turn_id)
            {
                turns.remove(&session_id);
            }
        });
        Ok(())
    }
}

fn context_part_to_acp(part: ContextPromptPart) -> Value {
    match part {
        ContextPromptPart::Text { text } => serde_json::json!({"type":"text", "text":text}),
        ContextPromptPart::Image { mime_type, data } => serde_json::json!({
            "type":"image", "mimeType":mime_type, "data":data
        }),
        ContextPromptPart::ResourceLink {
            name,
            uri,
            mime_type,
            size,
            description,
        } => serde_json::json!({
            "type":"resource_link", "name":name, "uri":uri, "mimeType":mime_type,
            "size":size, "description":description
        }),
    }
}

fn project_part_to_acp(part: ProjectPromptPart) -> Value {
    match part {
        ProjectPromptPart::Text { text } => serde_json::json!({"type":"text", "text":text}),
    }
}

#[tauri::command]
pub async fn sessions_list(
    state: State<'_, SessionCommandService>,
    input: ListSessionsInput,
) -> Result<Vec<AppSession>, AppError> {
    state
        .service
        .list(&input.project_id, input.include_archived)
}

#[tauri::command]
pub async fn sessions_create(
    state: State<'_, SessionCommandService>,
    input: CreateSessionInput,
) -> Result<AppSession, AppError> {
    let operation = "sessions.create";
    idempotent(
        &state.client_requests,
        &input.client_request_id,
        operation,
        || async {
            let project = state.projects.get_by_id(&input.project_id)?;
            let now = super::event_pipeline::now_iso();
            let session = AppSession {
                id: Uuid::new_v4().to_string(),
                provider: "gemini-cli".to_owned(),
                provider_session_id: None,
                project_id: project.project.id.clone(),
                last_root_revision: project.project.root_revision,
                last_root_fingerprint: project.project.root_fingerprint.clone(),
                title: input
                    .title
                    .clone()
                    .unwrap_or_else(|| "Neue Session".to_owned()),
                status: SessionStatus::Idle,
                model: None,
                mode: None,
                available_models: Vec::new(),
                available_modes: Vec::new(),
                pinned: false,
                archived: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            let roots = SessionRootAuditSnapshot::from_roots(
                &session.id,
                project.project.root_revision,
                &project.project.root_fingerprint,
                now,
                &project.roots,
            );
            state.service.sessions.create(session, Some(&roots))
        },
    )
    .await
}

#[tauri::command]
pub async fn sessions_update(
    state: State<'_, SessionCommandService>,
    input: UpdateSessionInput,
) -> Result<AppSession, AppError> {
    if input.title.is_none()
        && input.pinned.is_none()
        && input.archived.is_none()
        && input.model.is_none()
        && input.mode.is_none()
    {
        return Err(AppError::Validation(
            "at least one session field must be updated".to_owned(),
        ));
    }
    let request = input.client_request_id.clone();
    idempotent(
        &state.client_requests,
        &request,
        "sessions.update",
        || async {
            state.service.update(
                &input.session_id,
                SessionUpdate {
                    title: input.title.clone(),
                    pinned: input.pinned,
                    archived: input.archived,
                    model: input.model.clone(),
                    mode: input.mode.clone(),
                    updated_at: super::event_pipeline::now_iso(),
                    ..Default::default()
                },
            )
        },
    )
    .await
}

#[tauri::command]
pub async fn sessions_delete(
    state: State<'_, SessionCommandService>,
    input: DeleteSessionInput,
) -> Result<VoidResult, AppError> {
    let request = input.client_request_id.clone();
    idempotent(
        &state.client_requests,
        &request,
        "sessions.delete",
        || async {
            // `deleteProviderHistory` is intentionally accepted for wire
            // compatibility. ACP has no portable history-delete method, so local
            // session/event deletion remains the single authoritative operation.
            state
                .service
                .delete(&input.session_id)
                .await
                .map(|_| VoidResult { ok: true })
        },
    )
    .await
}

#[tauri::command]
pub async fn sessions_send_prompt(
    state: State<'_, SessionCommandService>,
    input: SendPromptInput,
) -> Result<SendPromptResult, AppError> {
    let request = input.client_request_id.clone();
    idempotent(
        &state.client_requests,
        &request,
        "sessions.send-prompt",
        || async {
            let mut session = state.service.sessions.get_by_id(&input.session_id)?;
            let project = state.current_project(&session).await?;
            state.service.ensure_root_revision(
                &session.id,
                project.project.root_revision,
                Some(&project.project.root_fingerprint),
            )?;
            session = state.ensure_process(&session).await?;
            let prepared = state.prepare_prompt(&session, &project, &input).await?;
            let turn_id = Uuid::new_v4().to_string();
            state
                .start_background_turn(&session, turn_id.clone(), prepared)
                .await?;
            Ok(SendPromptResult { turn_id })
        },
    )
    .await
}

#[tauri::command]
pub async fn sessions_cancel_turn(
    state: State<'_, SessionCommandService>,
    input: CancelTurnInput,
) -> Result<VoidResult, AppError> {
    let request = input.client_request_id.clone();
    idempotent(
        &state.client_requests,
        &request,
        "sessions.cancel-turn",
        || async {
            let active = state.active_turn(&input.session_id).await;
            if let Some(expected) = input.turn_id.as_deref() {
                if active.as_deref() != Some(expected) {
                    let _ = state.service.sessions.update(
                        &input.session_id,
                        super::contracts::SessionUpdate {
                            status: Some(SessionStatus::Idle),
                            updated_at: super::event_pipeline::now_iso(),
                            ..Default::default()
                        },
                    );
                    return Ok(VoidResult { ok: true });
                }
            } else if active.is_none() {
                let _ = state.service.sessions.update(
                    &input.session_id,
                    super::contracts::SessionUpdate {
                        status: Some(SessionStatus::Idle),
                        updated_at: super::event_pipeline::now_iso(),
                        ..Default::default()
                    },
                );
                return Ok(VoidResult { ok: true });
            }
            state
                .stop_active_turn(&input.session_id)
                .await
                .map(|_| VoidResult { ok: true })
        },
    )
    .await
}

#[tauri::command]
pub async fn sessions_respond_to_permission(
    state: State<'_, SessionCommandService>,
    input: PermissionResponse,
) -> Result<VoidResult, AppError> {
    let request = input.client_request_id.clone();
    idempotent(
        &state.client_requests,
        &request,
        "sessions.respond-to-permission",
        || async {
            state
                .service
                .respond_to_permission(&input.session_id, &input.request_id, &input.option_id)
                .await?;
            if let Some(pipeline) = Some(&state.pipeline) {
                let _ = pipeline.append_permission_resolved(
                    &input.session_id,
                    &input.request_id,
                    &input.option_id,
                )?;
            }
            Ok(VoidResult { ok: true })
        },
    )
    .await
}

#[tauri::command]
pub async fn sessions_set_mode(
    state: State<'_, SessionCommandService>,
    input: SetSessionModeInput,
) -> Result<AppSession, AppError> {
    let request = input.client_request_id.clone();
    idempotent(
        &state.client_requests,
        &request,
        "sessions.set-mode",
        || async {
            let session = state.service.sessions.get_by_id(&input.session_id)?;
            state.ensure_process(&session).await?;
            state
                .service
                .set_mode(
                    &input.session_id,
                    &input.mode_id,
                    super::event_pipeline::now_iso(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
pub async fn sessions_set_model(
    state: State<'_, SessionCommandService>,
    input: SetSessionModelInput,
) -> Result<AppSession, AppError> {
    let request = input.client_request_id.clone();
    idempotent(
        &state.client_requests,
        &request,
        "sessions.set-model",
        || async {
            let session = state.service.sessions.get_by_id(&input.session_id)?;
            state.ensure_process(&session).await?;
            state
                .service
                .set_model(
                    &input.session_id,
                    &input.model_id,
                    super::event_pipeline::now_iso(),
                )
                .await
        },
    )
    .await
}

#[tauri::command]
pub async fn sessions_get_reconnect_state(
    state: State<'_, SessionCommandService>,
    input: GetReconnectStateInput,
) -> Result<ReconnectState, AppError> {
    state.service.reconnect_state(&input.session_id).await
}

#[tauri::command]
pub async fn sessions_search(
    state: State<'_, SessionCommandService>,
    input: SearchSessionsInput,
) -> Result<SessionSearchResult, AppError> {
    state.service.search(input)
}

#[tauri::command]
pub async fn events_subscribe_session(
    state: State<'_, SessionCommandService>,
    input: SubscribeSessionEventsInput,
    on_batch: Channel<Vec<StreamEnvelope>>,
) -> Result<EventSubscriptionResult, AppError> {
    let subscription = state
        .pipeline
        .hub
        .subscribe_channel(input.session_id.clone(), on_batch);
    let id = new_subscription_id();
    let replay = state.pipeline.replay(&input.session_id, input.after_seq)?;
    let usage_snapshot = state
        .pipeline
        .usage
        .as_ref()
        .and_then(|usage| usage.get_snapshot(&input.session_id).ok())
        .flatten();
    state
        .subscriptions
        .lock()
        .await
        .insert(id.clone(), subscription);
    Ok(EventSubscriptionResult {
        subscription_id: id,
        replay,
        usage_snapshot,
    })
}

fn new_subscription_id() -> String {
    Uuid::new_v4().to_string()
}

#[tauri::command]
pub async fn events_unsubscribe_session(
    state: State<'_, SessionCommandService>,
    input: UnsubscribeSessionEventsInput,
) -> Result<VoidResult, AppError> {
    state
        .subscriptions
        .lock()
        .await
        .remove(&input.subscription_id);
    Ok(VoidResult { ok: true })
}

pub fn generate_session_title(prompt: &str) -> String {
    let first_line = prompt.replace("\r\n", "\n");
    let first_line = first_line.lines().next().unwrap_or_default().trim();
    let mut clean = strip_inline_code(first_line);
    clean = strip_heading_or_list(&clean);
    let prefixes = [
        "kannst du bitte",
        "könntest du bitte",
        "bitte",
        "erstelle mir",
        "mach mir",
        "schreibe mir",
    ];
    let lower = clean.to_lowercase();
    for prefix in prefixes {
        if lower.starts_with(prefix) {
            clean = strip_heading_or_list(clean[prefix.len()..].trim());
            break;
        }
    }
    if clean.is_empty() {
        return "Neue Session".to_owned();
    }
    let chars: Vec<char> = clean.chars().collect();
    let mut result: String = chars.iter().take(45).collect();
    if chars.len() > 45 {
        if let Some(space) = result
            .char_indices()
            .filter(|(_, character)| *character == ' ')
            .map(|(index, _)| index)
            .next_back()
            .filter(|index| *index > 20)
        {
            result.truncate(space);
        }
        result = format!("{}…", result.trim());
    }
    let mut output = result.chars();
    output.next().map_or_else(
        || "Neue Session".to_owned(),
        |first| first.to_uppercase().collect::<String>() + output.as_str(),
    )
}

fn strip_inline_code(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut in_code = false;
    for character in value.chars() {
        if character == '`' {
            in_code = !in_code;
        } else if !in_code {
            result.push(character);
        }
    }
    result.trim().to_owned()
}

fn strip_heading_or_list(value: &str) -> String {
    let value = value.trim_start();
    value
        .strip_prefix('#')
        .or_else(|| value.strip_prefix('-'))
        .or_else(|| value.strip_prefix('*'))
        .unwrap_or(value)
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        generate_session_title, new_subscription_id, PreparedPrompt, SessionCommandService,
    };
    use crate::acp::{
        CancelResult, PermissionBroker, ProcessError, ProcessFactory, ProcessFuture, ProcessHandle,
        SessionManager,
    };
    use crate::db::DbPool;
    use crate::hub::SubscriptionHub;
    use crate::idempotency::ClientRequestRepo;
    use crate::sessions::{
        EventRepository, SessionEventPipeline, SessionRepository, SessionService,
    };
    use serde_json::{json, Value};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::Notify;

    #[test]
    fn title_generation_matches_renderer_prefix_and_length_rules() {
        assert_eq!(
            generate_session_title("kannst du bitte # eine API bauen\nmehr"),
            "Eine API bauen"
        );
        assert_eq!(
            generate_session_title("`intern` schreibe mir einen Test"),
            "Einen Test"
        );
        assert_eq!(generate_session_title("   "), "Neue Session");
        let title = generate_session_title(
            "erstelle mir eine sehr lange Session-Beschreibung mit vielen Details",
        );
        assert!(title.chars().count() <= 46);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn session_event_subscription_ids_match_the_renderer_uuid_contract() {
        let id = new_subscription_id();
        assert_eq!(uuid::Uuid::parse_str(&id).unwrap().to_string(), id);
    }

    struct BlockingProcess {
        release: Arc<Notify>,
        permissions: PermissionBroker,
    }

    impl ProcessHandle for BlockingProcess {
        fn permissions(&self) -> PermissionBroker {
            self.permissions.clone()
        }

        fn request<'a>(
            &'a self,
            _method: &'a str,
            _params: Value,
        ) -> ProcessFuture<'a, Result<Value, ProcessError>> {
            Box::pin(async move {
                self.release.notified().await;
                Ok(json!({"stopReason":"cancelled"}))
            })
        }

        fn cancel_with_fallback<'a>(
            &'a self,
            _session_id: &'a str,
            _grace_period: Duration,
        ) -> ProcessFuture<'a, Result<CancelResult, ProcessError>> {
            Box::pin(async move {
                // Keep one permit when cancellation wins the scheduling race
                // and the prompt future has not reached `notified()` yet.
                self.release.notify_one();
                Ok(CancelResult::Semantic)
            })
        }

        fn terminate<'a>(&'a self) -> ProcessFuture<'a, Result<(), ProcessError>> {
            Box::pin(async { Ok(()) })
        }
    }

    struct BlockingFactory {
        process: Arc<BlockingProcess>,
    }

    impl ProcessFactory for BlockingFactory {
        fn spawn<'a>(
            &'a self,
            _session_id: &'a str,
            _config: crate::acp::AcpProcessConfig,
        ) -> ProcessFuture<'a, Result<Arc<dyn ProcessHandle>, ProcessError>> {
            let process = Arc::clone(&self.process);
            Box::pin(async move { Ok(process as Arc<dyn ProcessHandle>) })
        }
    }

    #[tokio::test]
    async fn send_runtime_returns_before_acp_response_and_cancel_is_parallel() {
        let db = DbPool::open_in_memory().unwrap();
        {
            let connection = db.connection().unwrap();
            let tx = connection.unchecked_transaction().unwrap();
            tx.execute("INSERT INTO project_roots (id, project_id, kind, path, real_path, label, sort_order, created_at, updated_at) VALUES ('r','p','primary','/tmp','/tmp','tmp',0,'now','now')", []).unwrap();
            tx.execute("INSERT INTO projects (id,name,primary_root_id,root_revision,root_fingerprint,archived,created_at,updated_at) VALUES ('p','p','r',1,?1,0,'now','now')", ["a".repeat(64)]).unwrap();
            tx.execute("INSERT INTO sessions (id,provider,project_id,last_root_revision,last_root_fingerprint,title,status,created_at,updated_at) VALUES ('s','gemini-cli','p',1,?1,'Neue Session','idle','now','now')", ["a".repeat(64)]).unwrap();
            tx.commit().unwrap();
        }

        let release = Arc::new(Notify::new());
        let manager = Arc::new(SessionManager::with_factory(Arc::new(BlockingFactory {
            process: Arc::new(BlockingProcess {
                release,
                permissions: PermissionBroker::default(),
            }),
        })));
        manager
            .open("s", crate::acp::AcpProcessConfig::new("fake", "/tmp"))
            .await
            .unwrap();
        let sessions = SessionRepository::new(db.clone());
        let events = EventRepository::new(db.clone());
        let pipeline = SessionEventPipeline::new(
            manager.clone(),
            sessions.clone(),
            events.clone(),
            None,
            SubscriptionHub::new(),
        );
        let service =
            SessionService::new(sessions, events.clone(), manager).with_pipeline(pipeline.clone());
        let command = SessionCommandService::new(
            service,
            crate::projects::ProjectRepository::new(db.clone()),
            ClientRequestRepo::new(db),
            pipeline,
            Arc::new(|_, _| Ok(crate::acp::AcpProcessConfig::new("fake", "/tmp"))),
        );
        let session = command.service.sessions.get_by_id("s").unwrap();
        let started = Instant::now();
        command.start_background_turn(&session, "turn-1".to_owned(), PreparedPrompt {
            acp: json!([{"type":"text","text":"hello"}]),
            user_event: json!({"type":"message.user","messageId":null,"text":"hello","attachmentIds":[]}),
            attachment_ids: vec![],
        }).await.unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "send path waited for ACP response"
        );
        assert_eq!(command.active_turn("s").await.as_deref(), Some("turn-1"));
        command.stop_active_turn("s").await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if command.active_turn("s").await.is_none() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let replay = command.pipeline.replay("s", 0).unwrap();
        assert!(replay
            .iter()
            .any(|event| event.event["type"] == "message.user"));
        assert!(replay
            .iter()
            .any(|event| event.event["type"] == "turn.cancelled"));
    }
}
