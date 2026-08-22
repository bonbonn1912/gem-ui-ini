//! Session orchestration around persistence and the ACP process manager.

use super::capabilities::SessionCapabilities;
use super::contracts::{
    AppSession, PromptHistoryMode, ReconnectState, SearchSessionsInput, SendPromptInput,
    SessionSearchResult, SessionSearchResultItem, SessionStatus, SessionUpdate,
};
use super::event_pipeline::{now_iso, SessionEventPipeline};
use super::event_repository::EventRepository;
use super::session_repository::SessionRepository;
use crate::acp::{AcpProcessConfig, SessionError, SessionManager, SessionSnapshot};
use crate::error::AppError;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone)]
pub struct SessionService {
    pub sessions: SessionRepository,
    pub events: EventRepository,
    pub manager: Arc<SessionManager>,
    reconnected: Arc<Mutex<HashSet<String>>>,
    capabilities: Arc<Mutex<HashMap<String, SessionCapabilities>>>,
    pub(crate) live: Option<SessionEventPipeline>,
}

impl SessionService {
    pub fn new(
        sessions: SessionRepository,
        events: EventRepository,
        manager: Arc<SessionManager>,
    ) -> Self {
        Self {
            sessions,
            events,
            manager,
            reconnected: Arc::new(Mutex::new(HashSet::new())),
            capabilities: Arc::new(Mutex::new(HashMap::new())),
            live: None,
        }
    }

    pub fn with_pipeline(mut self, pipeline: SessionEventPipeline) -> Self {
        self.live = Some(pipeline);
        self
    }

    pub(crate) async fn cache_capabilities(
        &self,
        session_id: &str,
        capabilities: SessionCapabilities,
    ) {
        self.capabilities
            .lock()
            .await
            .insert(session_id.to_owned(), capabilities);
    }

    pub(crate) async fn capability_snapshot(
        &self,
        session_id: &str,
    ) -> Option<SessionCapabilities> {
        self.capabilities.lock().await.get(session_id).cloned()
    }

    pub fn list(
        &self,
        project_id: &str,
        include_archived: bool,
    ) -> Result<Vec<AppSession>, AppError> {
        self.sessions.list_by_project(project_id, include_archived)
    }

    pub fn update(&self, session_id: &str, update: SessionUpdate) -> Result<AppSession, AppError> {
        self.sessions.update(session_id, update)
    }

    pub async fn delete(&self, session_id: &str) -> Result<(), AppError> {
        self.manager
            .close(session_id)
            .await
            .map_err(session_error)?;
        self.sessions.delete(session_id)
    }

    /// Opens an ACP process while preserving the hard three-process limit.  An
    /// idle victim is evicted first (oldest active-process open order), while
    /// running/permission/cancelling sessions are never interrupted.
    pub async fn open_process(
        &self,
        session_id: &str,
        config: AcpProcessConfig,
    ) -> Result<SessionSnapshot, AppError> {
        let snapshot = self
            .manager
            .open_with_eviction(session_id, config)
            .await
            .map_err(session_error)?;
        if let Some(response) = self.manager.initialize_response(session_id).await {
            let negotiated = SessionCapabilities::from_initialize(&response);
            self.capabilities
                .lock()
                .await
                .insert(session_id.to_owned(), negotiated.clone());
            if !negotiated.models.is_empty() || !negotiated.modes.is_empty() {
                let _ = self.sessions.update(
                    session_id,
                    SessionUpdate {
                        available_models: Some(negotiated.models),
                        available_modes: Some(negotiated.modes),
                        status: Some(SessionStatus::Idle),
                        updated_at: now_iso(),
                        ..Default::default()
                    },
                );
            }
        }
        Ok(snapshot)
    }

    pub async fn close_process(&self, session_id: &str) -> Result<(), AppError> {
        self.manager
            .close(session_id)
            .await
            .map_err(session_error)?;
        self.capabilities.lock().await.remove(session_id);
        Ok(())
    }

    pub async fn prompt(&self, session_id: &str, prompt: Value) -> Result<Value, AppError> {
        let turn_id = Uuid::new_v4().to_string();
        self.prompt_with_turn(session_id, turn_id, prompt).await
    }

    pub async fn prompt_with_turn(
        &self,
        session_id: &str,
        turn_id: String,
        prompt: Value,
    ) -> Result<Value, AppError> {
        if let Some(capabilities) = self.capabilities.lock().await.get(session_id).cloned() {
            capabilities.validate_prompt(&prompt)?;
        }
        let response = self
            .manager
            .prompt(session_id, prompt)
            .await
            .map_err(session_error);
        match response {
            Ok(response) => {
                if let Some(pipeline) = &self.live {
                    pipeline.append_prompt_result(session_id, &turn_id, &response)?;
                }
                Ok(response)
            }
            Err(error) => {
                if let Some(pipeline) = &self.live {
                    let _ = pipeline.append_event(session_id, Some(turn_id), json!({
                        "type": "turn.failed",
                        "error": {"code": error.code(), "message": error.to_string(), "retryable": false}
                    }));
                }
                Err(error)
            }
        }
    }

    pub async fn send_prompt(&self, input: SendPromptInput) -> Result<String, AppError> {
        self.ensure_root_revision(&input.session_id, input.expected_root_revision, None)?;
        let session = self.sessions.get_by_id(&input.session_id)?;
        let turn_id = Uuid::new_v4().to_string();
        let mut blocks = Vec::new();
        if !input.text.trim().is_empty() {
            blocks.push(json!({"type":"text", "text": input.text}));
        }
        if input.attachment_payloads.is_empty() {
            for attachment_id in &input.attachment_ids {
                blocks.push(json!({"type":"image", "attachmentId": attachment_id}));
            }
        } else {
            blocks.extend(input.attachment_payloads.iter().cloned());
        }
        if !input.project_files.is_empty()
            || !input.external_context_refs.is_empty()
            || !input.context_attachment_ids.is_empty()
        {
            blocks.push(json!({
                "type": "text",
                "text": format!("[GeminUI context: projectFiles={}, contextAttachments={}, externalContexts={}]", input.project_files.len(), input.context_attachment_ids.len(), input.external_context_refs.len())
            }));
        }
        if blocks.is_empty() {
            return Err(AppError::Validation(
                "prompt requires text or an attachment".to_owned(),
            ));
        }
        let history_mode = input.history_mode.unwrap_or(PromptHistoryMode::Compressed);
        let should_inject = self.reconnected.lock().await.contains(&input.session_id);
        if should_inject && matches!(history_mode, PromptHistoryMode::Compressed) {
            if let Some(history) = self.events.compressed_history(&input.session_id)? {
                blocks.insert(0, json!({"type":"text", "text": format!("[Previous GeminUI session history]\n{history}")}));
            }
        }
        if let Some(pipeline) = &self.live {
            let _ = pipeline.append_event(&input.session_id, Some(turn_id.clone()), json!({
                "type":"message.user",
                "messageId": turn_id,
                "text": input.text,
                "attachmentIds": input.attachment_ids,
                "contextAttachments": input.context_attachment_ids.into_iter().map(|id| json!({"id":id,"kind":"file","title":id})).collect::<Vec<_>>(),
                // The renderer event contract requires resolved snapshots for
                // project files/external contexts. The prompt still carries
                // their IDs in the ACP context block above; unresolved refs
                // must not be persisted as malformed replay payloads.
                "projectFiles": [],
                "externalContexts": []
            }));
        }
        let _ = session; // Root validation above also proves the record exists.
        let response = self
            .prompt_with_turn(&input.session_id, turn_id.clone(), Value::Array(blocks))
            .await?;
        if should_inject {
            self.clear_reconnected(&input.session_id).await;
        }
        let _ = response;
        Ok(turn_id)
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), AppError> {
        self.manager
            .cancel(session_id)
            .await
            .map(|_| ())
            .map_err(session_error)
    }

    pub async fn respond_to_permission(
        &self,
        session_id: &str,
        permission_id: &str,
        option_id: &str,
    ) -> Result<(), AppError> {
        self.manager
            .resolve_permission(session_id, permission_id, option_id)
            .await
            .map_err(session_error)
    }

    pub async fn set_mode(
        &self,
        session_id: &str,
        mode_id: &str,
        updated_at: String,
    ) -> Result<AppSession, AppError> {
        if let Some(capabilities) = self.capabilities.lock().await.get(session_id).cloned() {
            capabilities.validate_mode(mode_id)?;
        }
        self.manager
            .set_mode(session_id, mode_id)
            .await
            .map_err(session_error)?;
        self.sessions.update(
            session_id,
            SessionUpdate {
                mode: Some(Some(mode_id.to_owned())),
                updated_at,
                ..Default::default()
            },
        )
    }

    pub async fn set_model(
        &self,
        session_id: &str,
        model_id: &str,
        updated_at: String,
    ) -> Result<AppSession, AppError> {
        if let Some(capabilities) = self.capabilities.lock().await.get(session_id).cloned() {
            capabilities.validate_model(model_id)?;
        }
        self.manager
            .set_model(session_id, model_id)
            .await
            .map_err(session_error)?;
        self.sessions.update(
            session_id,
            SessionUpdate {
                model: Some(Some(model_id.to_owned())),
                updated_at,
                ..Default::default()
            },
        )
    }

    /// Marks that provider `session/load` failed and the controller opened a
    /// fresh ACP process.  The next prompt can then prepend the compressed
    /// local timeline exactly once.
    pub async fn mark_reconnected(&self, session_id: &str) {
        self.reconnected.lock().await.insert(session_id.to_owned());
        if let Ok(connection) = self.events.database().connection() {
            let _ = connection.execute(
                "INSERT INTO settings (key, value_json, version, updated_at) VALUES (?1, 'true', 1, ?2) ON CONFLICT(key) DO UPDATE SET value_json = 'true', version = version + 1, updated_at = excluded.updated_at",
                rusqlite::params![format!("session-reconnected:{session_id}"), now_iso()],
            );
        }
    }

    pub async fn clear_reconnected(&self, session_id: &str) {
        self.reconnected.lock().await.remove(session_id);
        if let Ok(connection) = self.events.database().connection() {
            let _ = connection.execute(
                "DELETE FROM settings WHERE key = ?1",
                [format!("session-reconnected:{session_id}")],
            );
        }
    }

    pub async fn reconnect_state(&self, session_id: &str) -> Result<ReconnectState, AppError> {
        let has_history = self.events.has_previous_history(session_id)?;
        let disconnected =
            self.sessions.get_by_id(session_id)?.status == SessionStatus::Disconnected;
        let persisted = self
            .events
            .database()
            .connection()
            .ok()
            .and_then(|connection| {
                connection
                    .query_row(
                        "SELECT value_json FROM settings WHERE key = ?1",
                        [format!("session-reconnected:{session_id}")],
                        |row| row.get::<_, String>(0),
                    )
                    .ok()
            })
            .and_then(|value| serde_json::from_str::<bool>(&value).ok())
            .unwrap_or(false);
        let reconnected =
            (self.reconnected.lock().await.contains(session_id) || disconnected || persisted)
                && has_history;
        Ok(ReconnectState {
            session_id: session_id.to_owned(),
            reconnected,
            has_history,
        })
    }

    pub fn compressed_history(&self, session_id: &str) -> Result<Option<String>, AppError> {
        self.events.compressed_history(session_id)
    }

    pub fn ensure_root_revision(
        &self,
        session_id: &str,
        expected_revision: u64,
        expected_fingerprint: Option<&str>,
    ) -> Result<AppSession, AppError> {
        let session = self.sessions.get_by_id(session_id)?;
        let fingerprint_matches = expected_fingerprint
            .map(|fingerprint| fingerprint == session.last_root_fingerprint)
            .unwrap_or(true);
        if session.last_root_revision != expected_revision || !fingerprint_matches {
            let _ = self.sessions.update(
                session_id,
                SessionUpdate {
                    status: Some(SessionStatus::RootsChanged),
                    updated_at: now_iso(),
                    ..Default::default()
                },
            );
            return Err(AppError::Conflict(
                "project roots changed; reload the session before prompting".to_owned(),
            ));
        }
        Ok(session)
    }

    /// Reopens an ACP process and tries provider history first.  A provider
    /// that lost its session is replaced with `session/new`; the durable local
    /// timeline remains authoritative and is injected on the next compressed
    /// prompt exactly once.
    pub async fn load_or_reconnect(
        &self,
        session_id: &str,
        config: AcpProcessConfig,
        cwd: &str,
    ) -> Result<AppSession, AppError> {
        let existing = self.sessions.get_by_id(session_id)?;
        let _ = self.manager.close(session_id).await;
        self.open_process(session_id, config).await?;
        if let Some(pipeline) = &self.live {
            let _ = pipeline.spawn(session_id.to_owned()).await;
        }
        let previous_provider_id = existing.provider_session_id.clone();
        let can_load = self
            .capability_snapshot(session_id)
            .await
            .map(|capabilities| capabilities.load_session)
            .unwrap_or(false);
        let (response, operation) = if can_load {
            if let Some(provider_id) = previous_provider_id.as_deref() {
                match self
                    .manager
                    .session_load(session_id, provider_id, cwd)
                    .await
                {
                    Ok(response) => (response, "load"),
                    Err(_) => (
                        self.manager
                            .session_new(session_id, cwd)
                            .await
                            .map_err(session_error)?,
                        "new",
                    ),
                }
            } else {
                (
                    self.manager
                        .session_new(session_id, cwd)
                        .await
                        .map_err(session_error)?,
                    "new",
                )
            }
        } else {
            (
                self.manager
                    .session_new(session_id, cwd)
                    .await
                    .map_err(session_error)?,
                "new",
            )
        };
        let provider_id = response
            .get("sessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or(previous_provider_id);
        let capabilities = SessionCapabilities::from_initialize(&response);
        self.capabilities
            .lock()
            .await
            .insert(session_id.to_owned(), capabilities.clone());
        let updated = self.sessions.update(
            session_id,
            SessionUpdate {
                provider_session_id: Some(provider_id),
                available_models: Some(capabilities.models),
                available_modes: Some(capabilities.modes),
                status: Some(SessionStatus::Idle),
                updated_at: now_iso(),
                ..Default::default()
            },
        )?;
        if operation == "new" {
            self.mark_reconnected(session_id).await;
        } else {
            self.clear_reconnected(session_id).await;
        }
        if let Some(pipeline) = &self.live {
            let _ = pipeline.append_event(
                session_id,
                None,
                json!({"type":"session.started","providerSessionId":updated.provider_session_id}),
            );
            let _ = pipeline.append_event(session_id, None, json!({"type":"session.ready","modes":updated.available_modes.iter().map(|option| option.id.clone()).collect::<Vec<_>>(),"models":updated.available_models.iter().map(|option| option.id.clone()).collect::<Vec<_>>() }));
        }
        Ok(updated)
    }

    pub fn search(&self, input: SearchSessionsInput) -> Result<SessionSearchResult, AppError> {
        let query = input.query.trim();
        if query.is_empty() {
            return Err(AppError::Validation("query must not be empty".to_owned()));
        }
        let sessions = self.sessions.list_by_project(&input.project_id, true)?;
        let lower_query = query.to_lowercase();
        let title_matches = sessions
            .iter()
            .filter(|session| session.title.to_lowercase().contains(&lower_query))
            .map(|session| session.id.clone())
            .collect::<std::collections::HashSet<_>>();
        let content = if input.search_content {
            self.events.search_by_content(&input.project_id, query)?
        } else {
            Vec::new()
        };
        let content_map = content
            .into_iter()
            .map(|item| (item.session_id, item.snippet))
            .collect::<std::collections::HashMap<_, _>>();
        let mut results = Vec::new();
        for session_id in title_matches.iter().chain(content_map.keys()) {
            if results
                .iter()
                .any(|item: &SessionSearchResultItem| &item.session_id == session_id)
            {
                continue;
            }
            results.push(SessionSearchResultItem {
                session_id: (*session_id).clone(),
                title_matches: title_matches.contains(session_id),
                matched_snippet: content_map.get(session_id).cloned(),
            });
        }
        Ok(SessionSearchResult {
            project_id: input.project_id,
            query: query.to_owned(),
            results,
        })
    }
}

fn session_error(error: SessionError) -> AppError {
    match error {
        SessionError::Capacity => AppError::Conflict(
            "Es laufen bereits drei Gemini-Sessions. Stoppe zuerst eine laufende Anfrage."
                .to_owned(),
        ),
        SessionError::AlreadyActive(id) => {
            AppError::Conflict(format!("Session {id} already owns an ACP process"))
        }
        SessionError::NotFound(id) => AppError::NotFound(format!("Session {id} is not active")),
        SessionError::Disposed => {
            AppError::Conflict("The ACP session manager is disposed".to_owned())
        }
        other => AppError::Upstream(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbPool;
    use crate::sessions::event_repository::AppendEventInput;

    fn fixture() -> SessionService {
        let db = DbPool::open_in_memory().unwrap();
        let connection = db.connection().unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        tx.execute("INSERT INTO project_roots (id,project_id,kind,path,real_path,label,sort_order,created_at,updated_at) VALUES ('r','p','primary','/tmp','/tmp','tmp',0,'now','now')", []).unwrap();
        tx.execute("INSERT INTO projects (id,name,primary_root_id,root_revision,root_fingerprint,archived,created_at,updated_at) VALUES ('p','p','r',1,?1,0,'now','now')", ["a".repeat(64)]).unwrap();
        tx.execute("INSERT INTO sessions (id,provider,project_id,last_root_revision,last_root_fingerprint,title,status,created_at,updated_at) VALUES ('s','gemini-cli','p',1,?1,'Neue Session','idle','now','now')", ["a".repeat(64)]).unwrap();
        tx.commit().unwrap();
        drop(connection);
        SessionService::new(
            SessionRepository::new(db.clone()),
            EventRepository::new(db),
            Arc::new(SessionManager::new()),
        )
    }

    #[tokio::test]
    async fn reconnect_marker_survives_as_a_durable_setting_until_cleared() {
        let service = fixture();
        service.events.append(AppendEventInput { session_id: "s".into(), turn_id: None, event: json!({"type":"message.user","messageId":"m","text":"hello","attachmentIds":[]}), timestamp: now_iso() }).unwrap();
        service.mark_reconnected("s").await;
        assert!(service.reconnect_state("s").await.unwrap().reconnected);
        service.clear_reconnected("s").await;
        assert!(!service.reconnect_state("s").await.unwrap().reconnected);
    }
}
