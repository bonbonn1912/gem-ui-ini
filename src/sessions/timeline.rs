//! In-memory timeline batching used between ACP normalization and SQLite.

use super::event_repository::{AgentEvent, AppendEventInput, EventRepository, StreamEnvelope};
use crate::constants::{EVENT_BUFFER_WINDOW_MS, MAX_EVENT_BATCH_CHARS};
use crate::error::AppError;
use serde_json::Value;
use std::time::{Duration, Instant};

/// A synchronous counterpart to the ACP mpsc batcher.  The controller can call
/// `push` for every normalized event and `flush_if_due` from its runtime timer.
/// Non-deltas are a hard ordering barrier, exactly as in the Electron queue.
#[derive(Debug, Default)]
pub struct TimelineAccumulator {
    events: Vec<AppendEventInput>,
    started_at: Option<Instant>,
}

impl TimelineAccumulator {
    pub fn push(&mut self, input: AppendEventInput) -> Vec<Vec<AppendEventInput>> {
        let mut flushed = Vec::new();
        if !is_delta(&input.event) {
            self.flush_into(&mut flushed);
            flushed.push(vec![input]);
            return flushed;
        }
        if self.started_at.is_none() {
            self.started_at = Some(Instant::now());
        }
        if let Some(previous) = self.events.last_mut() {
            if same_delta(&previous.event, &input.event) {
                let old = previous
                    .event
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let next = input
                    .event
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if old.chars().count() + next.chars().count() <= MAX_EVENT_BATCH_CHARS {
                    previous.event["delta"] = Value::String(format!("{old}{next}"));
                    return flushed;
                }
            }
        }
        self.events.push(input);
        // A single incoming delta may exceed the cap. Split it by Unicode
        // scalar values so a renderer never receives an overlarge row.
        self.split_last_if_needed();
        flushed
    }

    pub fn flush(&mut self) -> Option<Vec<AppendEventInput>> {
        if self.events.is_empty() {
            self.started_at = None;
            return None;
        }
        self.started_at = None;
        Some(std::mem::take(&mut self.events))
    }

    pub fn flush_if_due(&mut self) -> Option<Vec<AppendEventInput>> {
        let due = self.started_at.is_some_and(|started| {
            started.elapsed() >= Duration::from_millis(EVENT_BUFFER_WINDOW_MS)
        });
        due.then(|| self.flush()).flatten()
    }

    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    fn flush_into(&mut self, batches: &mut Vec<Vec<AppendEventInput>>) {
        if let Some(events) = self.flush() {
            batches.push(events);
        }
    }

    fn split_last_if_needed(&mut self) {
        let Some(last) = self.events.pop() else {
            return;
        };
        let Some(text) = last.event.get("delta").and_then(Value::as_str) else {
            self.events.push(last);
            return;
        };
        if text.chars().count() <= MAX_EVENT_BATCH_CHARS {
            self.events.push(last);
            return;
        }
        let mut remaining = text.to_owned();
        while !remaining.is_empty() {
            let (prefix, suffix) = split_chars(&remaining, MAX_EVENT_BATCH_CHARS);
            let mut part = last.clone();
            part.event["delta"] = Value::String(prefix.to_owned());
            self.events.push(part);
            remaining = suffix.to_owned();
        }
    }
}

/// Persists a flushed accumulator batch and returns the sequence envelopes to
/// publish through a Tauri `Channel`.
pub fn persist_batch(
    repository: &EventRepository,
    events: &[AppendEventInput],
) -> Result<Vec<StreamEnvelope>, AppError> {
    repository.append_batch(events)
}

fn is_delta(event: &AgentEvent) -> bool {
    matches!(
        event.get("type").and_then(Value::as_str),
        Some("message.assistant.delta" | "message.thought.delta")
    )
}

fn same_delta(left: &AgentEvent, right: &AgentEvent) -> bool {
    is_delta(left)
        && left.get("type") == right.get("type")
        && left.get("messageId") == right.get("messageId")
}

fn split_chars(value: &str, chars: usize) -> (&str, &str) {
    if value.chars().count() <= chars {
        return (value, "");
    }
    let index = value
        .char_indices()
        .nth(chars)
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    value.split_at(index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn delta(kind: &str, text: &str) -> AppendEventInput {
        AppendEventInput {
            session_id: "s".into(),
            turn_id: None,
            event: json!({"type":kind,"messageId":"m","delta":text}),
            timestamp: "now".into(),
        }
    }

    #[test]
    fn merges_only_consecutive_same_message_and_non_delta_is_barrier() {
        let mut buffer = TimelineAccumulator::default();
        assert!(buffer
            .push(delta("message.assistant.delta", "a"))
            .is_empty());
        assert!(buffer
            .push(delta("message.assistant.delta", "b"))
            .is_empty());
        let batches = buffer.push(AppendEventInput {
            session_id: "s".into(),
            turn_id: None,
            event: json!({"type":"turn.completed","stopReason":"end_turn"}),
            timestamp: "now".into(),
        });
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0][0].event["delta"], "ab");
        assert_eq!(batches[1][0].event["type"], "turn.completed");
    }

    #[test]
    fn splits_unicode_at_character_limit() {
        let mut buffer = TimelineAccumulator::default();
        buffer.push(delta(
            "message.assistant.delta",
            &"é".repeat(MAX_EVENT_BATCH_CHARS + 1),
        ));
        let events = buffer.flush().unwrap();
        assert_eq!(
            events[0].event["delta"].as_str().unwrap().chars().count(),
            MAX_EVENT_BATCH_CHARS
        );
        assert_eq!(
            events[1].event["delta"].as_str().unwrap().chars().count(),
            1
        );
    }
}
