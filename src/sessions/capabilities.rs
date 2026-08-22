//! Negotiated ACP capabilities and safe renderer-facing option validation.

use super::contracts::SessionOption;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCapabilities {
    pub load_session: bool,
    pub image_prompt: bool,
    pub audio_prompt: bool,
    pub resource_prompt: bool,
    pub models: Vec<SessionOption>,
    pub modes: Vec<SessionOption>,
}

impl SessionCapabilities {
    /// Parses both ACP's current `agentCapabilities` shape and the older
    /// Gemini `capabilities` shape.  Missing optional fields mean unsupported;
    /// an absent capability object is handled as an unknown agent and keeps
    /// compatibility with minimal ACP test agents.
    pub fn from_initialize(response: &Value) -> Self {
        let roots = [
            response.get("agentCapabilities"),
            response.get("capabilities"),
            response.get("sessionCapabilities"),
        ];
        let root = roots.into_iter().flatten().next();
        let load_session = root
            .and_then(|value| first_bool(value, &["loadSession", "load_session"]))
            .unwrap_or(false);
        let prompt = root
            .and_then(|value| {
                value
                    .get("promptCapabilities")
                    .or_else(|| value.get("prompt_capabilities"))
            })
            .or_else(|| response.get("promptCapabilities"));
        let image_prompt = prompt
            .and_then(|value| first_bool(value, &["image", "images"]))
            .unwrap_or(false);
        let audio_prompt = prompt
            .and_then(|value| first_bool(value, &["audio", "audioFiles"]))
            .unwrap_or(false);
        let resource_prompt = prompt
            .and_then(|value| first_bool(value, &["resource", "resources", "embeddedContext"]))
            .unwrap_or(false);
        let models = parse_options(response, root, &["models", "availableModels"]);
        let modes = parse_options(response, root, &["modes", "availableModes"]);
        Self {
            load_session,
            image_prompt,
            audio_prompt,
            resource_prompt,
            models,
            modes,
        }
    }

    pub fn validate_prompt(&self, prompt: &Value) -> Result<(), AppError> {
        let blocks = prompt.as_array().into_iter().flatten();
        for block in blocks {
            let kind = block
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let unsupported = match kind {
                "image" | "image_url" => !self.image_prompt,
                "audio" | "audio_url" => !self.audio_prompt,
                "resource" | "resource_link" | "embedded_context" => !self.resource_prompt,
                _ => false,
            };
            if unsupported {
                return Err(AppError::Conflict(format!(
                    "ACP agent does not support prompt block '{kind}'"
                )));
            }
        }
        Ok(())
    }

    pub fn validate_mode(&self, mode_id: &str) -> Result<(), AppError> {
        validate_option(mode_id, &self.modes, "mode")
    }

    pub fn validate_model(&self, model_id: &str) -> Result<(), AppError> {
        validate_option(model_id, &self.models, "model")
    }
}

fn validate_option(id: &str, options: &[SessionOption], kind: &str) -> Result<(), AppError> {
    if id.trim().is_empty() {
        return Err(AppError::Validation(format!("{kind} id must not be empty")));
    }
    // Empty lists mean the provider did not advertise an enumerable picker;
    // in that case the ACP request remains valid and the provider validates it.
    if !options.is_empty() && !options.iter().any(|option| option.id == id) {
        return Err(AppError::Conflict(format!("unknown ACP {kind} '{id}'")));
    }
    Ok(())
}

fn first_bool(value: &Value, names: &[&str]) -> Option<bool> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_bool))
}

fn parse_options(response: &Value, root: Option<&Value>, names: &[&str]) -> Vec<SessionOption> {
    names
        .iter()
        .find_map(|name| {
            response
                .get(*name)
                .or_else(|| root.and_then(|value| value.get(*name)))
        })
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| {
                    if let Some(id) = value.as_str() {
                        return Some(SessionOption {
                            id: id.to_owned(),
                            name: id.to_owned(),
                            description: None,
                        });
                    }
                    let id = value
                        .get("id")
                        .or_else(|| value.get("modelId"))
                        .or_else(|| value.get("modeId"))?
                        .as_str()?;
                    let name = value
                        .get("name")
                        .or_else(|| value.get("label"))
                        .and_then(Value::as_str)
                        .unwrap_or(id);
                    Some(SessionOption {
                        id: id.to_owned(),
                        name: name.to_owned(),
                        description: value
                            .get("description")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned),
                    })
                })
                .take(50)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_capabilities_and_gates_prompt_blocks_and_options() {
        let caps = SessionCapabilities::from_initialize(&json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": {"image": true, "audio": false},
                "models": [{"id":"pro","name":"Pro"}],
                "modes": ["code"]
            }
        }));
        assert!(caps.load_session && caps.image_prompt && !caps.audio_prompt);
        caps.validate_prompt(&json!([{"type":"image","data":"x"}]))
            .unwrap();
        assert!(caps
            .validate_prompt(&json!([{"type":"audio","data":"x"}]))
            .is_err());
        assert!(caps.validate_mode("code").is_ok());
        assert!(caps.validate_model("flash").is_err());
    }
}
