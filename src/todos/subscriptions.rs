use super::{ListTodosInput, TodoList, TodoService};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tauri::ipc::Channel;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsubscribeTodosInput {
    pub subscription_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoPush {
    pub subscription_id: String,
    pub list: TodoList,
}

struct Subscriber {
    project_id: String,
    channel: Channel<TodoPush>,
}

#[derive(Clone, Default)]
pub struct TodoSubscriptionHub {
    subscribers: Arc<RwLock<HashMap<String, Subscriber>>>,
}

impl TodoSubscriptionHub {
    pub fn subscribe(
        &self,
        input: ListTodosInput,
        list: TodoList,
        on_change: Channel<TodoPush>,
    ) -> Result<TodoPush, AppError> {
        let id = Uuid::new_v4().to_string();
        let result = TodoPush {
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
                    channel: on_change,
                },
            );
        Ok(result)
    }

    pub fn unsubscribe(&self, input: UnsubscribeTodosInput) -> Result<(), AppError> {
        self.subscribers
            .write()
            .map_err(|_| AppError::StatePoisoned)?
            .remove(&input.subscription_id);
        Ok(())
    }

    pub fn notify(&self, project_id: &str, list: TodoList) {
        let subscriptions = self
            .subscribers
            .read()
            .map(|subscribers| {
                subscribers
                    .iter()
                    .filter(|(_, subscriber)| subscriber.project_id == project_id)
                    .map(|(id, subscriber)| (id.clone(), subscriber.channel.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut dead = Vec::new();
        for (id, channel) in subscriptions {
            if channel
                .send(TodoPush {
                    subscription_id: id.clone(),
                    list: list.clone(),
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
pub fn todos_subscribe(
    state: tauri::State<'_, TodoSubscriptionHub>,
    service: tauri::State<'_, TodoService>,
    input: ListTodosInput,
    on_change: Channel<TodoPush>,
) -> Result<TodoPush, AppError> {
    let list = service.list(input.clone())?;
    state.subscribe(input, list, on_change)
}

#[tauri::command(rename_all = "camelCase")]
pub fn todos_unsubscribe(
    state: tauri::State<'_, TodoSubscriptionHub>,
    input: UnsubscribeTodosInput,
) -> Result<crate::todos::VoidResult, AppError> {
    state.unsubscribe(input)?;
    Ok(crate::todos::VoidResult { ok: true })
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
        let hub = TodoSubscriptionHub::default();
        hub.unsubscribe(UnsubscribeTodosInput {
            subscription_id: "missing".to_owned(),
        })
        .unwrap();
        assert_eq!(hub.subscriber_count(), 0);
    }

    #[test]
    fn initial_state_is_only_the_command_result() {
        let received = Arc::new(AtomicUsize::new(0));
        let callback_count = Arc::clone(&received);
        let channel = Channel::new(move |_| {
            callback_count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        let list = TodoList {
            project_id: "project".to_owned(),
            todos: Vec::new(),
            open_count: 0,
            done_count: 0,
        };
        let hub = TodoSubscriptionHub::default();
        let result = hub
            .subscribe(
                ListTodosInput {
                    project_id: "project".to_owned(),
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
