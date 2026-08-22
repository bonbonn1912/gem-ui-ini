use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::rpc::{RpcNotification, RpcRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeltaKind {
    Assistant,
    Thought,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AcpEvent {
    AssistantDelta {
        session_id: String,
        message_id: Option<String>,
        delta: String,
    },
    ThoughtDelta {
        session_id: String,
        message_id: Option<String>,
        delta: String,
    },
    Other {
        method: String,
        session_id: Option<String>,
        payload: Value,
    },
}

impl AcpEvent {
    pub fn from_notification(notification: RpcNotification) -> Self {
        let session_id = notification
            .params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let update = notification.params.get("update");
        let kind = update
            .and_then(|value| value.get("sessionUpdate"))
            .and_then(Value::as_str);
        let message_id = update
            .and_then(|value| value.get("messageId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let delta = update
            .and_then(|value| value.get("content"))
            .and_then(|value| value.get("text"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        match (notification.method.as_str(), kind, delta) {
            ("session/update", Some("agent_message_chunk"), Some(delta)) => Self::AssistantDelta {
                session_id,
                message_id,
                delta,
            },
            ("session/update", Some("agent_thought_chunk"), Some(delta)) => Self::ThoughtDelta {
                session_id,
                message_id,
                delta,
            },
            _ => Self::Other {
                method: notification.method,
                session_id: (!session_id.is_empty()).then_some(session_id),
                payload: notification.params,
            },
        }
    }

    pub fn delta_kind(&self) -> Option<DeltaKind> {
        match self {
            Self::AssistantDelta { .. } => Some(DeltaKind::Assistant),
            Self::ThoughtDelta { .. } => Some(DeltaKind::Thought),
            Self::Other { .. } => None,
        }
    }

    pub fn message_id(&self) -> Option<&str> {
        match self {
            Self::AssistantDelta { message_id, .. } | Self::ThoughtDelta { message_id, .. } => {
                message_id.as_deref()
            }
            Self::Other { .. } => None,
        }
    }

    pub fn delta(&self) -> Option<&str> {
        match self {
            Self::AssistantDelta { delta, .. } | Self::ThoughtDelta { delta, .. } => Some(delta),
            Self::Other { .. } => None,
        }
    }
}

pub fn is_internal_control_message(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with("[MODE_UPDATE]")
        || trimmed.starts_with("[MODE_CHANGE]")
        || trimmed.starts_with("[SET_MODE]")
        || trimmed.starts_with("[MODEL_UPDATE]")
        || trimmed.starts_with("[MODEL_CHANGE]")
        || trimmed.starts_with("[SET_MODEL]")
        || trimmed.starts_with("[CONFIG_UPDATE]")
}

pub fn strip_session_context(text: &str) -> String {
    let cleaned = text;
    while let Some(start) = cleaned.find("<session_context>") {
        if let Some(end) = cleaned[start..].find("</session_context>") {
            let before = &cleaned[..start];
            let after = &cleaned[start + end + "</session_context>".len()..];
            let combined = format!("{}{}", before.trim_end(), after.trim_start());
            return strip_session_context(&combined);
        } else {
            return cleaned[..start].trim().to_owned();
        }
    }
    cleaned.trim().to_owned()
}

/// Converts ACP `session/update` notifications into the strict renderer event
/// payloads persisted by the sessions timeline. Unsupported provider updates
/// are deliberately ignored: forwarding an arbitrary provider object would
/// make replay violate `AgentEventSchema`.
pub fn normalize_notification(notification: &RpcNotification) -> Vec<Value> {
    if notification.method != "session/update" {
        return Vec::new();
    }
    let update = notification.params.get("update").unwrap_or(&Value::Null);
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let message_id = || {
        update
            .get("messageId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string())
    };
    let content_text = || {
        update
            .get("content")
            .and_then(|value| value.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    match kind {
        "user_message_chunk" => {
            let raw = content_text();
            if is_internal_control_message(&raw) {
                None
            } else {
                let text = strip_session_context(&raw);
                if is_internal_control_message(&text)
                    || (text.trim().is_empty() && raw.contains("<session_context>"))
                {
                    None
                } else {
                    Some(serde_json::json!({
                        "type": "message.user",
                        "messageId": message_id(),
                        "text": text,
                        "attachmentIds": []
                    }))
                }
            }
        }
        "agent_message_chunk" => {
            let raw = content_text();
            if is_internal_control_message(&raw) {
                None
            } else {
                let text = strip_session_context(&raw);
                if is_internal_control_message(&text)
                    || (text.trim().is_empty() && raw.contains("<session_context>"))
                {
                    None
                } else {
                    Some(serde_json::json!({
                        "type": "message.assistant.delta",
                        "messageId": message_id(),
                        "delta": text
                    }))
                }
            }
        }
        "agent_thought_chunk" => Some(serde_json::json!({
            "type": "message.thought.delta",
            "messageId": message_id(),
            "delta": content_text()
        })),
        "tool_call" => Some(serde_json::json!({
            "type": "tool.started",
            "toolCallId": tool_call_id(update),
            "title": update.get("title").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or("Werkzeug"),
            "kind": update.get("kind").and_then(Value::as_str).filter(|value| !value.trim().is_empty()),
            "arguments": update.get("rawInput").cloned().or_else(|| update.get("raw_input").cloned()).unwrap_or(Value::Null)
        })),
        "tool_call_update" => match update.get("status").and_then(Value::as_str) {
            Some("completed") => Some(serde_json::json!({
                "type": "tool.completed",
                "toolCallId": tool_call_id(update),
                "result": update.get("rawOutput").cloned().or_else(|| update.get("raw_output").cloned()).unwrap_or(Value::Null)
            })),
            Some("failed") => Some(serde_json::json!({
                "type": "tool.failed",
                "toolCallId": tool_call_id(update),
                "error": { "code": "provider_tool_failed", "message": update.get("error").and_then(Value::as_str).unwrap_or("Werkzeug fehlgeschlagen"), "retryable": false }
            })),
            _ => Some(serde_json::json!({
                "type": "tool.updated",
                "toolCallId": tool_call_id(update),
                "status": update.get("status").and_then(Value::as_str).unwrap_or("in_progress"),
                "update": update.clone()
            }))
        },
        "available_commands_update" => Some(serde_json::json!({
            "type": "commands.updated",
            "commands": update.get("availableCommands").and_then(Value::as_array).map(|commands| commands.iter().filter_map(|command| {
                let name = command.as_str().or_else(|| command.get("name").and_then(Value::as_str))?.trim();
                if name.is_empty() { return None; }
                Some(serde_json::json!({
                    "name": name,
                    "description": command.get("description").and_then(Value::as_str).filter(|value| !value.trim().is_empty())
                }))
            }).take(500).collect::<Vec<_>>()).unwrap_or_default()
        })),
        "usage_update" => None,
        _ => None,
    }
    .into_iter()
    .filter(|event| match event.get("type").and_then(Value::as_str) {
        Some("message.user") => event.get("text").and_then(Value::as_str).is_some(),
        Some("message.assistant.delta" | "message.thought.delta") => event
            .get("delta")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty()),
        _ => true,
    })
    .collect()
}

/// Converts ACP's server-side permission request to the exact persisted
/// renderer shape. The transport still uses the JSON-RPC id as requestId.
pub fn normalize_permission_request(request: &RpcRequest) -> Option<Value> {
    if request.method != "session/request_permission" {
        return None;
    }
    let request_id = request
        .id
        .as_str()
        .map(ToOwned::to_owned)
        .or_else(|| request.id.is_number().then(|| request.id.to_string()))?;
    let params = &request.params;
    let options = params.get("options")?.as_array()?;
    if options.is_empty() {
        return None;
    }
    let mapped = options
        .iter()
        .filter_map(|option| {
            let option_id = option.get("optionId").and_then(Value::as_str).filter(|value| !value.trim().is_empty())?;
            let label = option.get("name").or_else(|| option.get("label")).and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or("Auswählen");
            Some(serde_json::json!({
                "optionId": option_id,
                "label": label,
                "kind": option.get("kind").and_then(Value::as_str).filter(|value| !value.trim().is_empty())
            }))
        })
        .take(20)
        .collect::<Vec<_>>();
    if mapped.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "type": "permission.requested",
        "requestId": request_id,
        "toolCallId": params.get("toolCall").and_then(|tool| tool.get("toolCallId")).and_then(Value::as_str).or_else(|| params.get("toolCallId").and_then(Value::as_str)),
        "title": params.get("toolCall").and_then(|tool| tool.get("title")).and_then(Value::as_str).or_else(|| params.get("title").and_then(Value::as_str)).unwrap_or("Freigabe erforderlich"),
        "options": mapped
    }))
}

fn tool_call_id(update: &Value) -> String {
    update
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::rpc::RpcNotification;

    #[test]
    fn normalizes_text_session_updates_and_keeps_unknown_updates() {
        let event = AcpEvent::from_notification(RpcNotification {
            jsonrpc: "2.0".into(),
            method: "session/update".into(),
            params: serde_json::json!({"sessionId":"s", "update":{"sessionUpdate":"agent_message_chunk", "messageId":"m", "content":{"type":"text", "text":"Hi"}}}),
        });
        assert_eq!(event.delta_kind(), Some(DeltaKind::Assistant));
        assert_eq!(event.delta(), Some("Hi"));
        let unknown = AcpEvent::from_notification(RpcNotification {
            jsonrpc: "2.0".into(),
            method: "session/update".into(),
            params: serde_json::json!({"sessionId":"s", "update":{"sessionUpdate":"tool_call"}}),
        });
        assert!(matches!(unknown, AcpEvent::Other { .. }));
    }

    #[test]
    fn normalizes_renderer_events_and_permission_ids_without_forwarding_provider_shape() {
        let events = normalize_notification(&RpcNotification {
            jsonrpc: "2.0".into(),
            method: "session/update".into(),
            params: serde_json::json!({"update":{"sessionUpdate":"agent_message_chunk","messageId":"m","content":{"type":"text","text":"Hi"}}}),
        });
        assert_eq!(events[0]["type"], "message.assistant.delta");
        assert_eq!(events[0]["delta"], "Hi");
        let permission = normalize_permission_request(&RpcRequest {
            jsonrpc: "2.0".into(),
            id: Value::String("rpc-7".into()),
            method: "session/request_permission".into(),
            params: serde_json::json!({"sessionId":"s","toolCall":{"toolCallId":"t","title":"Run"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"}]}),
        }).unwrap();
        assert_eq!(permission["requestId"], "rpc-7");
        assert_eq!(permission["options"][0]["optionId"], "allow");
    }
}
