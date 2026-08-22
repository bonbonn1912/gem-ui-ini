//! Tauri command adapters for the project-scoped Git service.
//!
//! The state is deliberately a small domain-owned holder.  Application setup
//! creates it once (after loading the selected Git binary) and manages it with
//! Tauri; command registration therefore remains a thin, auditable list.

use super::service::{
    spawn_status_poller, GetGitFileDiffInput, GetGitProjectStatusInput, GitFileDiff,
    GitProjectStatus, GitRepositoryList, GitService, GitStatusSubscriptionResult,
};
use crate::error::AppError;
use crate::hub::{Subscription, SubscriptionHub};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, State};
use uuid::Uuid;

#[derive(Debug, serde::Serialize)]
pub struct VoidResult {
    pub ok: bool,
}

pub struct GitCommandState {
    pub service: Arc<GitService>,
    pub hub: SubscriptionHub<String, Value>,
    subscriptions: Mutex<HashMap<String, ActiveSubscription>>,
    pub poll_interval: Duration,
}

struct ActiveSubscription {
    _hub_subscription: Subscription<String, Value>,
    _poller: super::service::GitStatusPollerHandle,
}

impl GitCommandState {
    pub fn new(service: Arc<GitService>, hub: SubscriptionHub<String, Value>) -> Self {
        Self {
            service,
            hub,
            subscriptions: Mutex::new(HashMap::new()),
            poll_interval: Duration::from_secs(2),
        }
    }
}

#[tauri::command]
pub async fn git_list_project_repositories(
    state: State<'_, GitCommandState>,
    input: GetGitProjectStatusInput,
) -> Result<GitRepositoryList, AppError> {
    state.service.list_project_repositories(input).await
}

#[tauri::command]
pub async fn git_get_project_status(
    state: State<'_, GitCommandState>,
    input: GetGitProjectStatusInput,
) -> Result<GitProjectStatus, AppError> {
    state.service.get_project_status(input).await
}

#[tauri::command]
pub async fn git_get_file_diff(
    state: State<'_, GitCommandState>,
    input: GetGitFileDiffInput,
) -> Result<GitFileDiff, AppError> {
    state.service.get_file_diff(input).await
}

#[tauri::command]
pub async fn git_subscribe_project_status(
    state: State<'_, GitCommandState>,
    input: GetGitProjectStatusInput,
    on_change: Channel<Value>,
) -> Result<GitStatusSubscriptionResult, AppError> {
    let status = state.service.get_project_status(input.clone()).await?;
    let subscription_id = Uuid::new_v4().to_string();
    let hub_subscription = state
        .hub
        .subscribe_channel(input.project_id.clone(), on_change);
    let poller = spawn_status_poller(
        Arc::clone(&state.service),
        input,
        state.hub.clone(),
        state.poll_interval,
    );
    state
        .subscriptions
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .insert(
            subscription_id.clone(),
            ActiveSubscription {
                _hub_subscription: hub_subscription,
                _poller: poller,
            },
        );
    Ok(GitStatusSubscriptionResult {
        subscription_id,
        status,
    })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsubscribeGitProjectStatusInput {
    pub subscription_id: String,
}

#[tauri::command]
pub fn git_unsubscribe_project_status(
    state: State<'_, GitCommandState>,
    input: UnsubscribeGitProjectStatusInput,
) -> Result<VoidResult, AppError> {
    // Removing the value drops both the channel subscription and its poller.
    state
        .subscriptions
        .lock()
        .map_err(|_| AppError::StatePoisoned)?
        .remove(&input.subscription_id);
    Ok(VoidResult { ok: true })
}
