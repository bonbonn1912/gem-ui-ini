use super::events::AcpEvent;
use crate::constants::{EVENT_BUFFER_WINDOW_MS, MAX_EVENT_BATCH_CHARS};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::{self, Duration, MissedTickBehavior};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventBatch {
    pub events: Vec<AcpEvent>,
}

#[derive(Debug, Default)]
pub struct BatchAccumulator {
    events: Vec<AcpEvent>,
}

impl BatchAccumulator {
    pub fn push(&mut self, event: AcpEvent) -> Vec<EventBatch> {
        let mut flushed = Vec::new();
        if event.delta_kind().is_none() {
            self.flush_into(&mut flushed);
            self.events.push(event);
            self.flush_into(&mut flushed);
            return flushed;
        }
        let mut remaining = event;
        while let Some(text) = remaining.delta().map(str::to_owned) {
            if text.is_empty() {
                break;
            }
            let available = self
                .events
                .last()
                .filter(|last| same_delta(last, &remaining))
                .and_then(AcpEvent::delta)
                .map(|value| MAX_EVENT_BATCH_CHARS.saturating_sub(value.chars().count()))
                .unwrap_or(MAX_EVENT_BATCH_CHARS);
            if available == 0 {
                let (prefix, suffix) = split_chars(&text, MAX_EVENT_BATCH_CHARS);
                self.events
                    .push(replace_delta(remaining.clone(), prefix.to_owned()));
                if suffix.is_empty() {
                    break;
                }
                remaining = replace_delta(remaining, suffix.to_owned());
                continue;
            }
            let take = text.chars().count().min(available);
            let (prefix, suffix) = split_chars(&text, take);
            let part = replace_delta(remaining.clone(), prefix.to_owned());
            if let Some(last) = self.events.last_mut() {
                if same_delta(last, &part) {
                    append_delta(last, prefix);
                } else {
                    self.events.push(part);
                }
            } else {
                self.events.push(part);
            }
            if suffix.is_empty() {
                break;
            }
            remaining = replace_delta(remaining, suffix.to_owned());
        }
        flushed
    }

    pub fn flush(&mut self) -> Option<EventBatch> {
        if self.events.is_empty() {
            return None;
        }
        let events = std::mem::take(&mut self.events);
        Some(EventBatch { events })
    }

    fn flush_into(&mut self, batches: &mut Vec<EventBatch>) {
        if let Some(batch) = self.flush() {
            batches.push(batch);
        }
    }
}

fn same_delta(left: &AcpEvent, right: &AcpEvent) -> bool {
    left.delta_kind() == right.delta_kind() && left.message_id() == right.message_id()
}

fn append_delta(target: &mut AcpEvent, text: &str) {
    match target {
        AcpEvent::AssistantDelta { delta, .. } | AcpEvent::ThoughtDelta { delta, .. } => {
            delta.push_str(text)
        }
        AcpEvent::Other { .. } => unreachable!(),
    }
}

fn replace_delta(event: AcpEvent, delta: String) -> AcpEvent {
    match event {
        AcpEvent::AssistantDelta {
            session_id,
            message_id,
            ..
        } => AcpEvent::AssistantDelta {
            session_id,
            message_id,
            delta,
        },
        AcpEvent::ThoughtDelta {
            session_id,
            message_id,
            ..
        } => AcpEvent::ThoughtDelta {
            session_id,
            message_id,
            delta,
        },
        AcpEvent::Other { .. } => event,
    }
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

/// Consumes events until the 32-ms window expires.  The first interval tick
/// is intentionally ignored by only flushing an accumulator that is nonempty,
/// so idle sessions never publish empty batches.
pub struct EventBatcher {
    input: mpsc::Receiver<AcpEvent>,
    output: mpsc::Sender<EventBatch>,
    accumulator: BatchAccumulator,
}

impl EventBatcher {
    pub fn new(input: mpsc::Receiver<AcpEvent>, output: mpsc::Sender<EventBatch>) -> Self {
        Self {
            input,
            output,
            accumulator: BatchAccumulator::default(),
        }
    }

    pub async fn run(mut self) {
        let mut interval = time::interval(Duration::from_millis(EVENT_BUFFER_WINDOW_MS));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        // Tokio's first interval tick is immediate; consume it so the first
        // event receives the full 32-ms coalescing window.
        interval.tick().await;
        loop {
            tokio::select! {
                event = self.input.recv() => match event {
                    Some(event) => for batch in self.accumulator.push(event) { if self.output.send(batch).await.is_err() { return; } },
                    None => { if let Some(batch) = self.accumulator.flush() { let _ = self.output.send(batch).await; } return; }
                },
                _ = interval.tick() => {
                    if let Some(batch) = self.accumulator.flush() { if self.output.send(batch).await.is_err() { return; } }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant(id: &str, text: &str) -> AcpEvent {
        AcpEvent::AssistantDelta {
            session_id: "s".into(),
            message_id: Some(id.into()),
            delta: text.into(),
        }
    }
    fn thought(id: &str, text: &str) -> AcpEvent {
        AcpEvent::ThoughtDelta {
            session_id: "s".into(),
            message_id: Some(id.into()),
            delta: text.into(),
        }
    }

    #[test]
    fn merges_only_consecutive_same_message_and_never_emits_empty() {
        let mut accumulator = BatchAccumulator::default();
        assert!(accumulator.push(assistant("m", "a")).is_empty());
        assert!(accumulator.push(assistant("m", "b")).is_empty());
        let batches = accumulator.push(thought("t", "c"));
        assert!(batches.is_empty());
        assert_eq!(
            accumulator.flush().unwrap().events,
            vec![assistant("m", "ab"), thought("t", "c")]
        );
    }

    #[test]
    fn splits_unicode_delta_at_exactly_one_hundred_thousand_characters() {
        let mut accumulator = BatchAccumulator::default();
        let text = "é".repeat(MAX_EVENT_BATCH_CHARS + 1);
        assert!(accumulator.push(assistant("m", &text)).is_empty());
        let batch = accumulator.flush().unwrap();
        assert_eq!(
            batch.events[0].delta().unwrap().chars().count(),
            MAX_EVENT_BATCH_CHARS
        );
        assert_eq!(batch.events[1].delta().unwrap().chars().count(), 1);
    }
}
