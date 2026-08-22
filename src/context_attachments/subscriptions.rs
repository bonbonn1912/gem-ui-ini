use super::{ContextAttachmentList, ContextAttachmentService, ListContextAttachmentsInput};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tauri::ipc::Channel;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsubscribeContextAttachmentsInput {
    pub subscription_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextAttachmentPush {
    pub subscription_id: String,
    pub list: ContextAttachmentList,
}

struct Subscriber {
    project_id: String,
    session_id: Option<String>,
    channel: Channel<ContextAttachmentPush>,
}

fn same_project(project_id: &str, subscriber: &Subscriber) -> bool {
    subscriber.project_id == project_id
}

#[derive(Clone, Default)]
pub struct ContextAttachmentSubscriptionHub {
    subscribers: Arc<RwLock<HashMap<String, Subscriber>>>,
}

impl ContextAttachmentSubscriptionHub {
    pub fn subscribe(
        &self,
        input: ListContextAttachmentsInput,
        list: ContextAttachmentList,
        on_change: Channel<ContextAttachmentPush>,
    ) -> Result<ContextAttachmentPush, AppError> {
        let id = Uuid::new_v4().to_string();
        let result = ContextAttachmentPush {
            subscription_id: id.clone(),
            list,
        };
        self.subscribers
            .write()
            .map_err(|_| AppError::StatePoisoned)?
            .insert(
                id,
                Subscriber {
                    project_id: input.project_id,
                    session_id: input.session_id,
                    channel: on_change,
                },
            );
        Ok(result)
    }

    pub fn unsubscribe(&self, input: UnsubscribeContextAttachmentsInput) -> Result<(), AppError> {
        self.subscribers
            .write()
            .map_err(|_| AppError::StatePoisoned)?
            .remove(&input.subscription_id);
        Ok(())
    }

    pub fn notify(&self, service: &ContextAttachmentService, project_id: &str) {
        let subscriptions = self
            .subscribers
            .read()
            .map(|subscribers| {
                subscribers
                    .iter()
                    .filter(|(_, subscriber)| same_project(project_id, subscriber))
                    .map(|(id, subscriber)| {
                        (
                            id.clone(),
                            subscriber.session_id.clone(),
                            subscriber.channel.clone(),
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut dead = Vec::new();
        for (id, session_id, channel) in subscriptions {
            let list = match service.list(ListContextAttachmentsInput {
                project_id: project_id.to_owned(),
                session_id,
            }) {
                Ok(list) => list,
                Err(_) => continue,
            };
            if channel
                .send(ContextAttachmentPush {
                    subscription_id: id.clone(),
                    list,
                })
                .is_err()
            {
                dead.push(id);
            }
        }
        if let Ok(mut subscribers) = self.subscribers.write() {
            for id in dead {
                subscribers.remove(&id);
            }
        }
    }

    pub fn subscriber_count(&self) -> usize {
        self.subscribers
            .read()
            .map(|value| value.len())
            .unwrap_or(0)
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn context_attachments_subscribe(
    state: tauri::State<'_, ContextAttachmentSubscriptionHub>,
    service: tauri::State<'_, ContextAttachmentService>,
    input: ListContextAttachmentsInput,
    on_change: Channel<ContextAttachmentPush>,
) -> Result<ContextAttachmentPush, AppError> {
    let list = service.list(input.clone())?;
    state.subscribe(input, list, on_change)
}

#[tauri::command(rename_all = "camelCase")]
pub fn context_attachments_unsubscribe(
    state: tauri::State<'_, ContextAttachmentSubscriptionHub>,
    input: UnsubscribeContextAttachmentsInput,
) -> Result<crate::context_attachments::VoidResult, AppError> {
    state.unsubscribe(input)?;
    Ok(crate::context_attachments::VoidResult { ok: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn unsubscribe_is_idempotent_for_unknown_subscription() {
        let hub = ContextAttachmentSubscriptionHub::default();
        hub.unsubscribe(UnsubscribeContextAttachmentsInput {
            subscription_id: "missing".to_owned(),
        })
        .unwrap();
        assert_eq!(hub.subscriber_count(), 0);
    }

    #[test]
    fn initial_state_is_only_the_command_result_and_updates_are_pushed() {
        let received = Arc::new(AtomicUsize::new(0));
        let callback_count = Arc::clone(&received);
        let channel = Channel::new(move |_| {
            callback_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        let list = ContextAttachmentList {
            project_id: "project".to_owned(),
            session_id: Some("session".to_owned()),
            project_attachments: Vec::new(),
            session_attachments: Vec::new(),
            included_count: 0,
            estimated_total_tokens: 0,
            over_budget: false,
        };
        let hub = ContextAttachmentSubscriptionHub::default();
        let result = hub
            .subscribe(
                ListContextAttachmentsInput {
                    project_id: "project".to_owned(),
                    session_id: Some("session".to_owned()),
                },
                list,
                channel,
            )
            .unwrap();
        assert!(!result.subscription_id.is_empty());
        assert_eq!(received.load(Ordering::SeqCst), 0);
        assert_eq!(hub.subscriber_count(), 1);
    }
}
