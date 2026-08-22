use super::contracts::*;
use super::repository::JiraRepository;
use crate::context_attachments::{
    AddContextLinkInput, ContextAttachmentOrigin, ContextAttachmentScope, ContextAttachmentService,
};
use crate::error::AppError;
use crate::git::now_iso;
use std::sync::Arc;
use uuid::Uuid;

pub trait ContextAttachmentIngestor: Send + Sync {
    fn ingest_link(
        &self,
        project_id: &str,
        session_id: &str,
        url: &str,
        title: &str,
        client_request_id: &str,
    ) -> Result<String, AppError>;
}

impl<T: ContextAttachmentIngestor + ?Sized> ContextAttachmentIngestor for Arc<T> {
    fn ingest_link(
        &self,
        project_id: &str,
        session_id: &str,
        url: &str,
        title: &str,
        client_request_id: &str,
    ) -> Result<String, AppError> {
        (**self).ingest_link(project_id, session_id, url, title, client_request_id)
    }
}

/// Production adapter used by `JiraService`: Jira attachments are ordinary
/// session-scoped link attachments, so they go through the same URL policy,
/// deduplication and SQLite transaction as links added from the renderer.
impl ContextAttachmentIngestor for ContextAttachmentService {
    fn ingest_link(
        &self,
        project_id: &str,
        session_id: &str,
        url: &str,
        title: &str,
        client_request_id: &str,
    ) -> Result<String, AppError> {
        let stored = ContextAttachmentService::ingest_link(
            self,
            AddContextLinkInput {
                client_request_id: client_request_id.to_owned(),
                project_id: project_id.to_owned(),
                scope: ContextAttachmentScope::Session,
                session_id: Some(session_id.to_owned()),
                url: url.to_owned(),
                title: Some(title.to_owned()),
                origin: ContextAttachmentOrigin::Manual,
                default_include: Some(false),
            },
        )?;
        Ok(stored.public.id)
    }
}

pub struct JiraService<A> {
    pub repository: JiraRepository,
    pub context_attachments: A,
}
impl<A: ContextAttachmentIngestor> JiraService<A> {
    pub fn list_configs(&self) -> Result<Vec<JiraConfig>, AppError> {
        self.repository.list_configs()
    }
    pub fn save_config(&self, input: SaveJiraConfigInput) -> Result<JiraConfig, AppError> {
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > 100 {
            return Err(AppError::Validation(
                "Der Jira-Konfigurationsname muss 1 bis 100 Zeichen enthalten.".into(),
            ));
        }
        if let Some(existing) = self.repository.find_config_by_name(name)? {
            if input.config_id.as_deref() != Some(existing.id.as_str()) {
                return Err(AppError::Conflict(format!(
                    "Es gibt bereits eine Jira-Integration mit dem Namen „{name}“."
                )));
            }
        }
        let prefixes = input
            .issue_prefixes
            .iter()
            .map(|value| normalize_prefix(value).map_err(AppError::Validation))
            .collect::<Result<Vec<_>, _>>()?;
        if prefixes.is_empty() || prefixes.len() > MAX_JIRA_ISSUE_PREFIXES {
            return Err(AppError::Validation(
                "Mindestens ein und höchstens 25 Jira-Prefixe sind erforderlich.".into(),
            ));
        }
        let id = input
            .config_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let now = now_iso();
        let created_at = self
            .repository
            .find_config(&id)?
            .map(|value| value.created_at)
            .unwrap_or_else(|| now.clone());
        let config = JiraConfig {
            id,
            name: name.into(),
            base_url: normalize_jira_base_url(&input.base_url).map_err(AppError::Validation)?,
            issue_prefixes: prefixes,
            created_at,
            updated_at: now,
        };
        self.repository.save_config(&config)
    }
    pub fn delete_config(&self, input: DeleteJiraConfigInput) -> Result<(), AppError> {
        self.repository.delete_config(&input.config_id)
    }
    pub fn activate(
        &self,
        input: ActivateJiraProjectIntegrationInput,
    ) -> Result<JiraProjectIntegration, AppError> {
        if self.repository.find_config(&input.config_id)?.is_none() {
            return Err(AppError::NotFound(
                "Jira-Konfiguration nicht gefunden.".into(),
            ));
        }
        self.repository
            .activate(&input.project_id, &input.config_id, &now_iso())?;
        self.repository.project_integration(&input.project_id)
    }
    pub fn deactivate(
        &self,
        input: DeactivateJiraProjectIntegrationInput,
    ) -> Result<JiraProjectIntegration, AppError> {
        self.repository.deactivate(&input.project_id)?;
        self.repository.project_integration(&input.project_id)
    }
    pub fn project_integration(
        &self,
        project_id: &str,
    ) -> Result<JiraProjectIntegration, AppError> {
        self.repository.project_integration(project_id)
    }
    pub fn attach_issue(
        &self,
        input: AttachJiraIssueInput,
    ) -> Result<AttachJiraIssueResult, AppError> {
        let key = normalize_issue_key(&input.issue_key).map_err(AppError::Validation)?;
        let integration = self.repository.project_integration(&input.project_id)?;
        let config = integration.active_config.ok_or_else(|| {
            AppError::Conflict("Jira ist für dieses Projekt nicht aktiviert.".into())
        })?;
        let url = build_jira_issue_url(&config.base_url, &key);
        let prefix = key.split('-').next().unwrap_or_default().to_owned();
        if !config.issue_prefixes.iter().any(|value| value == &prefix) {
            return Err(AppError::Validation(format!(
                "Der Jira-Prefix „{prefix}“ gehört nicht zur aktiven Integration."
            )));
        }
        let attachment_id = self.context_attachments.ingest_link(
            &input.project_id,
            &input.session_id,
            &url,
            &key,
            &input.client_request_id,
        )?;
        Ok(AttachJiraIssueResult {
            r#match: JiraIssueMatch {
                issue_key: key,
                prefix,
                url,
            },
            attachment_id,
        })
    }
}
