//! Defensive normalization of ACP/Gemini usage payloads.
//!
//! ACP's standard `usage` object is cumulative according to the SDK contract,
//! while Gemini CLI 0.56 exposes per-prompt counters under `_meta.quota`.
//! Keeping the scope explicit is what prevents a fallback counter from being
//! added twice after a reconnect.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenCounters {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub total: Option<u64>,
    pub thought: Option<u64>,
    pub cached_read: Option<u64>,
    pub cached_write: Option<u64>,
    pub tool: Option<u64>,
    pub total_kind: Option<TotalKind>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TotalKind {
    Provider,
    DerivedInputPlusOutput,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelTokenUsage {
    pub model: String,
    pub input: u64,
    pub output: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageScope {
    Turn,
    SessionCumulative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenUsageSource {
    AcpPromptUsage,
    GeminiMetaQuota,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageTokenObservation {
    pub kind: String,
    pub scope: UsageScope,
    pub source: TokenUsageSource,
    pub tokens: TokenCounters,
    pub by_model: Vec<ModelTokenUsage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageCost {
    pub amount: f64,
    pub currency: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageContextObservation {
    pub kind: String,
    pub source: String,
    pub used: u64,
    pub size: u64,
    pub cost: Option<UsageCost>,
}

pub fn parse_prompt_usage(response: &Value) -> Option<UsageTokenObservation> {
    let object = response.as_object()?;
    let by_model = parse_model_usage(object.get("_meta"));
    if let Some(tokens) = parse_standard_usage(object.get("usage")) {
        return Some(UsageTokenObservation {
            kind: "tokens".into(),
            scope: UsageScope::SessionCumulative,
            source: TokenUsageSource::AcpPromptUsage,
            tokens,
            by_model,
        });
    }
    parse_gemini_quota(object.get("_meta")).map(|tokens| UsageTokenObservation {
        kind: "tokens".into(),
        scope: UsageScope::Turn,
        source: TokenUsageSource::GeminiMetaQuota,
        tokens,
        by_model,
    })
}

pub fn parse_usage_update(update: &Value) -> Option<UsageContextObservation> {
    let object = update.as_object()?;
    let used = safe_count(object.get("used"))?;
    let size = safe_count(object.get("size"))?;
    if size == 0 {
        return None;
    }
    Some(UsageContextObservation {
        kind: "context".into(),
        source: "acp_usage_update".into(),
        used,
        size,
        cost: parse_cost(object.get("cost")),
    })
}

pub fn add_token_counters(left: &TokenCounters, right: &TokenCounters) -> TokenCounters {
    let input = add_count(left.input, right.input);
    let output = add_count(left.output, right.output);
    let total = add_count(left.total, right.total);
    let total_kind = total.map(|_| {
        if left.total_kind == Some(TotalKind::Provider)
            || right.total_kind == Some(TotalKind::Provider)
        {
            TotalKind::Provider
        } else {
            TotalKind::DerivedInputPlusOutput
        }
    });
    TokenCounters {
        input,
        output,
        total,
        thought: add_count(left.thought, right.thought),
        cached_read: add_count(left.cached_read, right.cached_read),
        cached_write: add_count(left.cached_write, right.cached_write),
        tool: add_count(left.tool, right.tool),
        total_kind,
    }
}

pub fn safe_count(value: Option<&Value>) -> Option<u64> {
    let value = value?.as_u64()?;
    // SQLite's INTEGER and JavaScript's safe integers are both bounded below
    // this. Refuse values that cannot be represented by either side.
    (value <= 9_007_199_254_740_991).then_some(value)
}

fn parse_standard_usage(value: Option<&Value>) -> Option<TokenCounters> {
    let value = value?.as_object()?;
    let input = safe_count(value.get("inputTokens"));
    let output = safe_count(value.get("outputTokens"));
    let provider_total = safe_count(value.get("totalTokens"));
    if input.is_none() && output.is_none() && provider_total.is_none() {
        return None;
    }
    Some(build_counters(
        input,
        output,
        provider_total,
        safe_count(value.get("thoughtTokens")),
        safe_count(value.get("cachedReadTokens")),
        safe_count(value.get("cachedWriteTokens")),
        safe_count(value.get("toolTokens")),
    ))
}

fn parse_gemini_quota(meta: Option<&Value>) -> Option<TokenCounters> {
    let counts = meta?.get("quota")?.get("token_count")?.as_object()?;
    let input = safe_count(counts.get("input_tokens"));
    let output = safe_count(counts.get("output_tokens"));
    let provider_total = safe_count(counts.get("total_tokens"));
    if input.is_none() && output.is_none() && provider_total.is_none() {
        return None;
    }
    Some(build_counters(
        input,
        output,
        provider_total,
        safe_count(counts.get("thoughts_token_count")),
        safe_count(counts.get("cached_content_token_count")),
        None,
        safe_count(counts.get("tool_use_prompt_token_count")),
    ))
}

fn parse_model_usage(meta: Option<&Value>) -> Vec<ModelTokenUsage> {
    let Some(entries) = meta
        .and_then(|value| value.get("quota"))
        .and_then(|value| value.get("model_usage"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    entries
        .iter()
        .take(50)
        .filter_map(|entry| {
            let model = entry.get("model")?.as_str()?.trim();
            if model.is_empty() || model.chars().count() > 200 {
                return None;
            }
            let counts = entry.get("token_count")?;
            Some(ModelTokenUsage {
                model: model.to_owned(),
                input: safe_count(counts.get("input_tokens")).unwrap_or(0),
                output: safe_count(counts.get("output_tokens")).unwrap_or(0),
            })
        })
        .collect()
}

fn parse_cost(value: Option<&Value>) -> Option<UsageCost> {
    let value = value?.as_object()?;
    let amount = value.get("amount")?.as_f64()?;
    let currency = value.get("currency")?.as_str()?.trim().to_uppercase();
    if !amount.is_finite()
        || amount < 0.0
        || currency.len() != 3
        || !currency.bytes().all(|byte| byte.is_ascii_uppercase())
    {
        return None;
    }
    Some(UsageCost { amount, currency })
}

fn build_counters(
    input: Option<u64>,
    output: Option<u64>,
    provider_total: Option<u64>,
    thought: Option<u64>,
    cached_read: Option<u64>,
    cached_write: Option<u64>,
    tool: Option<u64>,
) -> TokenCounters {
    let derived = input
        .zip(output)
        .and_then(|(left, right)| left.checked_add(right));
    let total = provider_total.or(derived);
    TokenCounters {
        input,
        output,
        total,
        thought,
        cached_read,
        cached_write,
        tool,
        total_kind: total.map(|_| {
            if provider_total.is_some() {
                TotalKind::Provider
            } else {
                TotalKind::DerivedInputPlusOutput
            }
        }),
    }
}

fn add_count(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => left.checked_add(right),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn standard_usage_wins_over_gemini_fallback() {
        let result = parse_prompt_usage(&json!({
            "usage": { "inputTokens": 10, "outputTokens": 20, "totalTokens": 30 },
            "_meta": { "quota": { "token_count": { "input_tokens": 1, "output_tokens": 2 } } }
        }))
        .unwrap();
        assert_eq!(result.source, TokenUsageSource::AcpPromptUsage);
        assert_eq!(result.scope, UsageScope::SessionCumulative);
        assert_eq!(result.tokens.total, Some(30));
    }

    #[test]
    fn parses_gemini_turn_counters_and_model_split() {
        let result = parse_prompt_usage(&json!({
            "_meta": { "quota": { "token_count": { "input_tokens": 1234, "output_tokens": 567 }, "model_usage": [{ "model": "pro", "token_count": { "input_tokens": 1200, "output_tokens": 500 } }] } }
        })).unwrap();
        assert_eq!(result.source, TokenUsageSource::GeminiMetaQuota);
        assert_eq!(
            result.tokens.total_kind,
            Some(TotalKind::DerivedInputPlusOutput)
        );
        assert_eq!(result.by_model[0].model, "pro");
    }

    #[test]
    fn rejects_invalid_context_and_keeps_cost_separate() {
        assert!(parse_usage_update(&json!({ "used": 10, "size": 0 })).is_none());
        let context = parse_usage_update(
            &json!({ "used": 10, "size": 100, "cost": { "amount": 0.1, "currency": "usd" } }),
        )
        .unwrap();
        assert_eq!(context.cost.unwrap().currency, "USD");
    }
}
