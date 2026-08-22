//! Persistent, strictly ordered session timeline.

use crate::db::DbPool;
use crate::error::AppError;
use rusqlite::{params, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const MAX_EVENT_REPLAY: usize = 1_000;
pub const MAX_EVENT_BATCH: usize = 1_000;

/// Events stay as JSON at this boundary.  ACP evolves its notification union
/// faster than the persisted schema; keeping the payload and validating its
/// `type` lets old rows remain readable without forwarding raw provider data.
pub type AgentEvent = Value;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamEnvelope {
    pub seq: u64,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub event: AgentEvent,
    pub timestamp: String,
}

#[derive(Clone, Debug)]
pub struct AppendEventInput {
    pub session_id: String,
    pub turn_id: Option<String>,
    pub event: AgentEvent,
    pub timestamp: String,
}

#[derive(Clone)]
pub struct EventRepository {
    db: DbPool,
}

impl EventRepository {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }

    pub fn database(&self) -> DbPool {
        self.db.clone()
    }

    pub fn append(&self, input: AppendEventInput) -> Result<StreamEnvelope, AppError> {
        let mut result = self.append_batch(std::slice::from_ref(&input))?;
        result
            .pop()
            .ok_or_else(|| AppError::Internal("event append returned no row".to_owned()))
    }

    /// Appends a batch atomically and computes sequence numbers while holding
    /// the SQLite write transaction.  Two concurrent streams therefore cannot
    /// observe or emit duplicate sequence numbers.
    pub fn append_batch(
        &self,
        inputs: &[AppendEventInput],
    ) -> Result<Vec<StreamEnvelope>, AppError> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        if inputs.len() > MAX_EVENT_BATCH {
            return Err(AppError::Validation(
                "an event batch may contain at most 1000 events".to_owned(),
            ));
        }
        let mut connection = self.db.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut seq = transaction.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM events WHERE session_id = ?1",
            [&inputs[0].session_id],
            |row| row.get::<_, i64>(0),
        )?;
        let mut envelopes = Vec::with_capacity(inputs.len());
        for input in inputs {
            validate_event(input)?;
            // A batch is intentionally session-local. Mixing sessions would
            // make one transaction's sequence assignment surprising and is a
            // common caller bug, so reject it explicitly.
            if input.session_id != inputs[0].session_id {
                return Err(AppError::Validation(
                    "an event batch must contain one session".to_owned(),
                ));
            }
            seq = seq
                .checked_add(1)
                .ok_or_else(|| AppError::Validation("event sequence overflow".to_owned()))?;
            let event_type = input
                .event
                .get("type")
                .and_then(Value::as_str)
                .expect("validate_event checked type");
            let payload_json = serde_json::to_string(&input.event)?;
            transaction.execute(
                "INSERT INTO events (session_id, seq, turn_id, event_type, payload_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    input.session_id,
                    seq,
                    input.turn_id,
                    event_type,
                    payload_json,
                    input.timestamp,
                ],
            )?;
            envelopes.push(StreamEnvelope {
                seq: seq as u64,
                session_id: input.session_id.clone(),
                turn_id: input.turn_id.clone(),
                event: input.event.clone(),
                timestamp: input.timestamp.clone(),
            });
        }
        transaction.commit()?;
        Ok(envelopes)
    }

    pub fn list_after(
        &self,
        session_id: &str,
        after_seq: u64,
        limit: usize,
    ) -> Result<Vec<StreamEnvelope>, AppError> {
        if limit == 0 || limit > MAX_EVENT_REPLAY {
            return Err(AppError::Validation(
                "limit must be between 1 and 1000".to_owned(),
            ));
        }
        let after_seq = i64::try_from(after_seq)
            .map_err(|_| AppError::Validation("afterSeq is too large".to_owned()))?;
        let connection = self.db.connection()?;
        let mut statement = connection.prepare(
            "SELECT session_id, seq, turn_id, event_type, payload_json, created_at
             FROM events WHERE session_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
        )?;
        let rows = statement
            .query_map(
                params![session_id, after_seq, limit as i64],
                parse_event_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(validate_stored_event).collect()
    }

    pub fn latest_sequence(&self, session_id: &str) -> Result<u64, AppError> {
        let connection = self.db.connection()?;
        let seq: i64 = connection.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM events WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?;
        seq.try_into()
            .map_err(|_| AppError::Internal("stored event sequence is negative".to_owned()))
    }

    /// Returns the first content match per session, newest event first, with
    /// the same 25/35-character ellipsis window as the Electron repository.
    pub fn search_by_content(
        &self,
        project_id: &str,
        query: &str,
    ) -> Result<Vec<ContentSearchResult>, AppError> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let pattern = format!("%{query}%");
        let connection = self.db.connection()?;
        let mut statement = connection.prepare(
            "SELECT e.session_id, e.payload_json FROM events e
             JOIN sessions s ON s.id = e.session_id WHERE s.project_id = ?1
             AND e.payload_json LIKE ?2 ORDER BY e.created_at DESC",
        )?;
        let rows = statement.query_map(params![project_id, pattern], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut result = Vec::new();
        let mut found = HashMap::<String, String>::new();
        let lower_query = query.to_lowercase();
        for row in rows {
            let (session_id, payload) = row?;
            if found.contains_key(&session_id) {
                continue;
            }
            let value: Value = match serde_json::from_str(&payload) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let Some(text) = searchable_text(&value) else {
                continue;
            };
            let lower_text = text.to_lowercase();
            let Some(index) = lower_text.find(&lower_query) else {
                continue;
            };
            // Compute the character offset on the lowercased string itself;
            // Unicode case folding can change byte length (and therefore an
            // index from `lower_text.find` must not slice the original text).
            let start = lower_text[..index].chars().count().saturating_sub(25);
            let matched_chars = query.chars().count();
            let end = (start + 25 + matched_chars + 35).min(text.chars().count());
            let snippet_text: String = text.chars().skip(start).take(end - start).collect();
            let snippet = format!(
                "{}{}{}",
                if start > 0 { "…" } else { "" },
                snippet_text.replace('\n', " ").trim(),
                if end < text.chars().count() {
                    "…"
                } else {
                    ""
                }
            );
            found.insert(session_id.clone(), snippet.clone());
            result.push(ContentSearchResult {
                session_id,
                snippet,
            });
        }
        Ok(result)
    }

    pub fn has_previous_history(&self, session_id: &str) -> Result<bool, AppError> {
        Ok(self
            .list_after(session_id, 0, 10)?
            .into_iter()
            .any(|envelope| {
                matches!(
                    event_type(&envelope.event),
                    Some("message.user" | "message.assistant.delta")
                )
            }))
    }

    pub fn compressed_history(&self, session_id: &str) -> Result<Option<String>, AppError> {
        let envelopes = self.list_after(session_id, 0, MAX_EVENT_REPLAY)?;
        if envelopes.is_empty() {
            return Ok(None);
        }
        let mut turns: Vec<(&str, String)> = Vec::new();
        let mut assistant = String::new();
        for envelope in envelopes {
            match event_type(&envelope.event) {
                Some("message.user") => {
                    flush_assistant(&mut assistant, &mut turns);
                    if let Some(text) = envelope.event.get("text").and_then(Value::as_str) {
                        if !text.trim().is_empty() {
                            turns.push(("User", text.trim().to_owned()));
                        }
                    }
                }
                Some("message.assistant.delta") => {
                    if let Some(delta) = envelope.event.get("delta").and_then(Value::as_str) {
                        assistant.push_str(delta);
                    }
                }
                Some("turn.completed") | Some("turn.failed") | Some("turn.cancelled") => {
                    flush_assistant(&mut assistant, &mut turns);
                }
                _ => {}
            }
        }
        flush_assistant(&mut assistant, &mut turns);
        if turns.is_empty() {
            return Ok(None);
        }
        Ok(Some(
            turns
                .into_iter()
                .map(|(role, text)| {
                    let text = if text.chars().count() > 2_000 {
                        let prefix: String = text.chars().take(1_950).collect();
                        format!("{prefix}... [gekürzt]")
                    } else {
                        text
                    };
                    format!("{role}: {text}")
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
        ))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchResult {
    pub session_id: String,
    pub snippet: String,
}

fn validate_event(input: &AppendEventInput) -> Result<(), AppError> {
    if input.session_id.trim().is_empty() || input.timestamp.trim().is_empty() {
        return Err(AppError::Validation(
            "event session and timestamp are required".to_owned(),
        ));
    }
    let Some(event_type) = input.event.get("type").and_then(Value::as_str) else {
        return Err(AppError::Validation("event.type is required".to_owned()));
    };
    if event_type.trim().is_empty() || event_type.chars().count() > 100 {
        return Err(AppError::Validation("event.type is invalid".to_owned()));
    }
    if !is_known_event_type(event_type) {
        return Err(AppError::Validation(format!(
            "unsupported event type {event_type}"
        )));
    }
    if input
        .turn_id
        .as_ref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(AppError::Validation("turn id must not be empty".to_owned()));
    }
    Ok(())
}

fn parse_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StreamEnvelope> {
    let seq: i64 = row.get(1)?;
    let seq = u64::try_from(seq).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Integer,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "negative event sequence",
            )),
        )
    })?;
    let stored_type: String = row.get(3)?;
    let payload_json: String = row.get(4)?;
    let event: Value = serde_json::from_str(&payload_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let event = migrate_legacy_usage_event(event);
    if event.get("type").and_then(Value::as_str) != Some(stored_type.as_str()) {
        return Err(rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "event type mismatch",
            )),
        ));
    }
    Ok(StreamEnvelope {
        seq,
        session_id: row.get(0)?,
        turn_id: row.get(2)?,
        event,
        timestamp: row.get(5)?,
    })
}

fn validate_stored_event(envelope: StreamEnvelope) -> Result<StreamEnvelope, AppError> {
    if envelope.seq == 0 {
        return Err(AppError::Internal(
            "stored event sequence is zero".to_owned(),
        ));
    }
    event_type(&envelope.event)
        .ok_or_else(|| AppError::Internal("stored event has no type".to_owned()))?;
    Ok(envelope)
}

fn is_known_event_type(value: &str) -> bool {
    matches!(
        value,
        "session.started"
            | "session.ready"
            | "session.failed"
            | "session.info.updated"
            | "message.user"
            | "message.assistant.delta"
            | "message.thought.delta"
            | "tool.started"
            | "tool.updated"
            | "tool.completed"
            | "tool.failed"
            | "permission.requested"
            | "permission.resolved"
            | "usage.updated"
            | "usage.tokens.observed"
            | "usage.context.observed"
            | "commands.updated"
            | "mode.updated"
            | "config.updated"
            | "plan.updated"
            | "plan.removed"
            | "turn.completed"
            | "turn.cancelled"
            | "turn.failed"
            | "process.disconnected"
    )
}

fn event_type(event: &Value) -> Option<&str> {
    event.get("type").and_then(Value::as_str)
}

fn searchable_text(event: &Value) -> Option<String> {
    ["text", "delta", "title", "error"]
        .iter()
        .find_map(|key| event.get(*key).and_then(Value::as_str).map(str::to_owned))
}

fn flush_assistant(assistant: &mut String, turns: &mut Vec<(&str, String)>) {
    if !assistant.trim().is_empty() {
        turns.push(("Assistant", std::mem::take(assistant).trim().to_owned()));
    }
}

/// Converts an old flat usage event into the snapshot shape while preserving
/// its conservative/partial semantics.  This is intentionally public so a
/// future migration or replay endpoint can use exactly the same conversion.
pub fn migrate_legacy_usage_event(value: Value) -> Value {
    if value.get("type").and_then(Value::as_str) != Some("usage.updated")
        || value.get("snapshot").is_some()
    {
        return value;
    }
    let count = |key: &str| value.get(key).and_then(Value::as_u64);
    let used = count("used");
    let size = count("size");
    let context = match (used, size.filter(|size| *size > 0)) {
        (Some(used), Some(size)) => {
            Some(json!({ "used": used, "size": size, "source": "legacy_event" }))
        }
        _ => None,
    };
    let input = count("inputTokens");
    let output = count("outputTokens");
    let total = if context.is_some() {
        None
    } else {
        count("totalTokens")
    };
    let total = total.or_else(|| {
        input
            .zip(output)
            .and_then(|(left, right)| left.checked_add(right))
    });
    let total_kind = if value.get("totalTokens").is_some() {
        json!("provider")
    } else if input.is_some() && output.is_some() {
        json!("derived_input_plus_output")
    } else {
        Value::Null
    };
    let session = if input.is_some() || output.is_some() || total.is_some() {
        Some(json!({
            "tokens": { "input": input, "output": output, "total": total,
              "thought": null, "cachedRead": null, "cachedWrite": null, "tool": null,
              "totalKind": total_kind },
            "coverage": "partial", "source": "legacy_event"
        }))
    } else {
        None
    };
    json!({
        "type": "usage.updated",
        "snapshot": { "revision": 0, "lastTurn": null, "session": session,
          "context": context, "cost": null, "updatedAt": "1970-01-01T00:00:00.000Z" }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbPool;

    fn fixture() -> (DbPool, String) {
        let db = DbPool::open_in_memory().unwrap();
        let project = "p";
        let connection = db.connection().unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        let root = "r";
        tx.execute("INSERT INTO project_roots (id, project_id, kind, path, real_path, label, sort_order, created_at, updated_at) VALUES (?1, ?2, 'primary', '/tmp', '/tmp', 'tmp', 0, 'now', 'now')", params![root, project]).unwrap();
        tx.execute("INSERT INTO projects (id, name, primary_root_id, root_revision, root_fingerprint, archived, created_at, updated_at) VALUES (?1, 'p', ?2, 1, ?3, 0, 'now', 'now')", params![project, root, "a".repeat(64)]).unwrap();
        tx.execute("INSERT INTO sessions (id, provider, project_id, last_root_revision, last_root_fingerprint, title, status, created_at, updated_at) VALUES ('s', 'gemini-cli', ?1, 1, ?2, 'Session', 'idle', 'now', 'now')", params![project, "a".repeat(64)]).unwrap();
        tx.commit().unwrap();
        drop(connection);
        (db, "s".into())
    }

    #[test]
    fn assigns_sequences_and_replays_after_cursor() {
        let (db, session_id) = fixture();
        let repo = EventRepository::new(db);
        let first = repo
            .append(AppendEventInput {
                session_id: session_id.clone(),
                turn_id: None,
                event: json!({"type":"message.assistant.delta","messageId":"m","delta":"A"}),
                timestamp: "2026-08-20T12:00:00.000Z".into(),
            })
            .unwrap();
        let second = repo
            .append(AppendEventInput {
                session_id,
                turn_id: None,
                event: json!({"type":"message.assistant.delta","messageId":"m","delta":"B"}),
                timestamp: "2026-08-20T12:00:00.000Z".into(),
            })
            .unwrap();
        assert_eq!((first.seq, second.seq), (1, 2));
        assert_eq!(repo.list_after("s", 1, 1).unwrap().len(), 1);
    }

    #[test]
    fn compressed_history_truncates_assistant_output() {
        let (db, session_id) = fixture();
        let repo = EventRepository::new(db);
        repo.append(AppendEventInput {
            session_id: session_id.clone(),
            turn_id: None,
            event: json!({"type":"message.user","text":"hello"}),
            timestamp: "now".into(),
        })
        .unwrap();
        repo.append(AppendEventInput {
            session_id: session_id.clone(),
            turn_id: None,
            event: json!({"type":"message.assistant.delta","delta":"x".repeat(2200)}),
            timestamp: "now".into(),
        })
        .unwrap();
        let history = repo.compressed_history(&session_id).unwrap().unwrap();
        assert!(history.contains("User: hello"));
        assert!(history.contains("[gekürzt]"));
    }
}
