use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::oneshot;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub permission_id: String,
    pub session_id: String,
    pub tool_call: Value,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionOutcome {
    Selected { option_id: String },
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionResolution {
    pub permission_id: String,
    pub outcome: PermissionOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PermissionError {
    #[error("permission request is no longer pending")]
    NotPending,
    #[error("permission option was not offered by the agent")]
    InvalidOption,
    #[error("permission broker is closed")]
    Closed,
    #[error("permission broker lock was poisoned")]
    Poisoned,
    #[error("permission request id is already pending")]
    Duplicate,
}

struct Pending {
    request: PermissionRequest,
    sender: oneshot::Sender<PermissionResolution>,
}

/// Bridges an ACP request to an explicit renderer decision.  No option is
/// selected implicitly; closing the broker resolves every waiter as cancelled.
#[derive(Clone, Default)]
pub struct PermissionBroker {
    pending: Arc<Mutex<HashMap<String, Pending>>>,
    sequence: Arc<Mutex<u64>>,
    closed: Arc<AtomicBool>,
}

impl PermissionBroker {
    pub fn request(
        &self,
        session_id: impl Into<String>,
        tool_call: Value,
        options: Vec<PermissionOption>,
    ) -> Result<(PermissionRequest, oneshot::Receiver<PermissionResolution>), PermissionError> {
        self.request_generated(session_id, tool_call, options)
    }

    /// Registers a provider permission request under the provider's JSON-RPC
    /// request id.  The id must not be replaced with a locally generated id:
    /// ACP sends the response back to this exact id and concurrent permission
    /// prompts are otherwise easy to cross-wire.
    pub fn request_with_id(
        &self,
        permission_id: impl Into<String>,
        session_id: impl Into<String>,
        tool_call: Value,
        options: Vec<PermissionOption>,
    ) -> Result<(PermissionRequest, oneshot::Receiver<PermissionResolution>), PermissionError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(PermissionError::Closed);
        }
        let permission_id = permission_id.into();
        if permission_id.trim().is_empty() {
            return Err(PermissionError::NotPending);
        }
        let request = PermissionRequest {
            permission_id: permission_id.clone(),
            session_id: session_id.into(),
            tool_call,
            options,
        };
        let (sender, receiver) = oneshot::channel();
        if self.closed.load(Ordering::Acquire) {
            return Err(PermissionError::Closed);
        }
        let mut pending = self.pending.lock().map_err(|_| PermissionError::Poisoned)?;
        if pending.contains_key(&permission_id) {
            return Err(PermissionError::Duplicate);
        }
        pending.insert(
            permission_id,
            Pending {
                request: request.clone(),
                sender,
            },
        );
        Ok((request, receiver))
    }

    fn generated_permission_id(
        &self,
        session_id: &str,
        tool_call: &Value,
    ) -> Result<String, PermissionError> {
        let tool_id = tool_call
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or("tool");
        let mut sequence = self
            .sequence
            .lock()
            .map_err(|_| PermissionError::Poisoned)?;
        *sequence += 1;
        Ok(format!("{session_id}:{tool_id}:{}", *sequence))
    }

    pub fn request_generated(
        &self,
        session_id: impl Into<String>,
        tool_call: Value,
        options: Vec<PermissionOption>,
    ) -> Result<(PermissionRequest, oneshot::Receiver<PermissionResolution>), PermissionError> {
        if self.closed.load(Ordering::Acquire) {
            return Err(PermissionError::Closed);
        }
        let session_id = session_id.into();
        let permission_id = self.generated_permission_id(&session_id, &tool_call)?;
        self.request_with_id(permission_id, session_id, tool_call, options)
    }

    pub fn resolve(&self, permission_id: &str, option_id: &str) -> Result<(), PermissionError> {
        let pending = {
            let mut map = self.pending.lock().map_err(|_| PermissionError::Poisoned)?;
            let offered = map
                .get(permission_id)
                .ok_or(PermissionError::NotPending)?
                .request
                .options
                .iter()
                .any(|option| option.option_id == option_id);
            if !offered {
                return Err(PermissionError::InvalidOption);
            }
            map.remove(permission_id)
                .ok_or(PermissionError::NotPending)?
        };
        let _ = pending.sender.send(PermissionResolution {
            permission_id: permission_id.to_owned(),
            outcome: PermissionOutcome::Selected {
                option_id: option_id.to_owned(),
            },
        });
        Ok(())
    }

    pub fn cancel(&self, permission_id: &str) -> Result<bool, PermissionError> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| PermissionError::Poisoned)?
            .remove(permission_id);
        if let Some(pending) = pending {
            let _ = pending.sender.send(PermissionResolution {
                permission_id: permission_id.to_owned(),
                outcome: PermissionOutcome::Cancelled,
            });
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Resolves every pending permission belonging to one ACP session as
    /// cancelled.  ACP cancellation must not leave a server request parked
    /// behind a renderer that can no longer answer it.
    pub fn cancel_session(&self, session_id: &str) -> Result<usize, PermissionError> {
        let pending = {
            let mut map = self.pending.lock().map_err(|_| PermissionError::Poisoned)?;
            let ids = map
                .iter()
                .filter(|(_, pending)| pending.request.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| map.remove(&id).map(|pending| (id, pending)))
                .collect::<Vec<_>>()
        };
        let count = pending.len();
        for (permission_id, pending) in pending {
            let _ = pending.sender.send(PermissionResolution {
                permission_id,
                outcome: PermissionOutcome::Cancelled,
            });
        }
        Ok(count)
    }

    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let pending = match self.pending.lock() {
            Ok(mut map) => std::mem::take(&mut *map),
            Err(_) => return,
        };
        for (permission_id, pending) in pending {
            let _ = pending.sender.send(PermissionResolution {
                permission_id,
                outcome: PermissionOutcome::Cancelled,
            });
        }
    }

    pub fn pending(&self) -> Vec<PermissionRequest> {
        self.pending
            .lock()
            .map(|map| {
                map.values()
                    .map(|pending| pending.request.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|map| map.len()).unwrap_or(0)
    }
}

impl Drop for PermissionBroker {
    fn drop(&mut self) {
        if Arc::strong_count(&self.pending) == 1 {
            self.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn validates_exact_option_and_closes_waiters_as_cancelled() {
        let broker = PermissionBroker::default();
        let (request, waiter) = broker
            .request(
                "s",
                serde_json::json!({"toolCallId":"t"}),
                vec![PermissionOption {
                    option_id: "allow".into(),
                    name: "Allow".into(),
                    kind: "allow_once".into(),
                }],
            )
            .unwrap();
        assert_eq!(
            broker.resolve(&request.permission_id, "wrong"),
            Err(PermissionError::InvalidOption)
        );
        broker.close();
        assert_eq!(waiter.await.unwrap().outcome, PermissionOutcome::Cancelled);
        assert_eq!(broker.pending_count(), 0);
    }

    #[tokio::test]
    async fn provider_request_id_is_preserved_for_the_oneshot() {
        let broker = PermissionBroker::default();
        let (request, waiter) = broker
            .request_with_id(
                "rpc-77",
                "session",
                serde_json::json!({"toolCallId":"tool"}),
                vec![PermissionOption {
                    option_id: "allow".into(),
                    name: "Allow".into(),
                    kind: "allow_once".into(),
                }],
            )
            .unwrap();
        assert_eq!(request.permission_id, "rpc-77");
        broker.resolve("rpc-77", "allow").unwrap();
        let resolution = waiter.await.unwrap();
        assert_eq!(resolution.permission_id, "rpc-77");
        assert_eq!(broker.pending_count(), 0);
    }

    #[tokio::test]
    async fn cancelling_session_resolves_only_its_provider_waiters() {
        let broker = PermissionBroker::default();
        let (_, first) = broker
            .request_with_id("one", "session-a", Value::Null, vec![])
            .unwrap();
        let (_, second) = broker
            .request_with_id("two", "session-b", Value::Null, vec![])
            .unwrap();
        assert_eq!(broker.cancel_session("session-a").unwrap(), 1);
        assert_eq!(first.await.unwrap().outcome, PermissionOutcome::Cancelled);
        assert_eq!(broker.pending_count(), 1);
        drop(second);
    }
}
