//! Live ACP notification normalization, durable timeline writes and replay fanout.

use super::event_repository::{AppendEventInput, EventRepository, StreamEnvelope};
use super::session_repository::SessionRepository;
use super::timeline::TimelineAccumulator;
use super::usage::{RecordContextInput, UsageService};
use crate::acp::{
    normalize_notification, normalize_permission_request, RpcError, RpcInbound, SessionManager,
};
use crate::error::AppError;
use crate::hub::SubscriptionHub;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::task::JoinHandle;
use tokio::time::{self, Duration, MissedTickBehavior};

/// Owns one live process subscription. The JSON-RPC correlator remains the
/// only consumer of responses; this pipeline consumes the manager's broadcast
/// fanout and persists only normalized renderer events.
#[derive(Clone)]
pub struct SessionEventPipeline {
    pub manager: Arc<SessionManager>,
    pub sessions: SessionRepository,
    pub events: EventRepository,
    pub usage: Option<UsageService>,
    pub hub: SubscriptionHub<String, Vec<StreamEnvelope>>,
}

impl SessionEventPipeline {
    pub fn new(
        manager: Arc<SessionManager>,
        sessions: SessionRepository,
        events: EventRepository,
        usage: Option<UsageService>,
        hub: SubscriptionHub<String, Vec<StreamEnvelope>>,
    ) -> Self {
        Self {
            manager,
            sessions,
            events,
            usage,
            hub,
        }
    }

    pub async fn spawn(&self, session_id: impl Into<String>) -> Result<JoinHandle<()>, AppError> {
        let session_id = session_id.into();
        let receiver = self
            .manager
            .subscribe_incoming(&session_id)
            .await
            .map_err(|error| AppError::Upstream(error.to_string()))?
            .ok_or_else(|| {
                AppError::Internal("ACP process has no event subscription".to_owned())
            })?;
        let pipeline = self.clone();
        Ok(tokio::spawn(async move {
            pipeline.run(session_id, receiver).await;
        }))
    }

    pub fn replay(
        &self,
        session_id: &str,
        after_seq: u64,
    ) -> Result<Vec<StreamEnvelope>, AppError> {
        self.events.list_after(session_id, after_seq, 1_000)
    }

    pub fn append_event(
        &self,
        session_id: &str,
        turn_id: Option<String>,
        event: Value,
    ) -> Result<Vec<StreamEnvelope>, AppError> {
        let envelope = self.events.append(AppendEventInput {
            session_id: session_id.to_owned(),
            turn_id,
            event,
            timestamp: now_iso(),
        })?;
        let batch = vec![envelope.clone()];
        self.hub.notify(&session_id.to_owned(), batch);
        Ok(vec![envelope])
    }

    pub fn append_permission_resolved(
        &self,
        session_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<Vec<StreamEnvelope>, AppError> {
        let event = json!({
            "type": "permission.resolved",
            "requestId": request_id,
            "optionId": option_id
        });
        self.append_event(session_id, None, event)
    }

    /// Persists one ACP notification after normalization. This entry point is
    /// also used by deterministic transport tests; the live runner adds the
    /// timeline accumulator around the same normalized event values.
    pub fn ingest_notification(
        &self,
        session_id: &str,
        notification: &crate::acp::RpcNotification,
        turn_id: Option<String>,
    ) -> Result<Vec<StreamEnvelope>, AppError> {
        let inputs = normalize_notification(notification)
            .into_iter()
            .map(|event| AppendEventInput {
                session_id: session_id.to_owned(),
                turn_id: turn_id.clone(),
                event,
                timestamp: now_iso(),
            })
            .collect::<Vec<_>>();
        self.persist_and_publish(session_id, inputs)
    }

    pub fn append_prompt_result(
        &self,
        session_id: &str,
        turn_id: &str,
        response: &Value,
    ) -> Result<Vec<StreamEnvelope>, AppError> {
        let mut events = Vec::new();
        if let (Some(usage), Some(repository)) = (
            crate::acp::parse_prompt_usage(response),
            self.usage.as_ref(),
        ) {
            let snapshot = repository.record_tokens(super::usage::RecordTokensInput {
                session_id: session_id.to_owned(),
                turn_id: turn_id.to_owned(),
                observation: usage,
                occurred_at: now_iso(),
            })?;
            if let Some(snapshot) = snapshot {
                events.push(json!({ "type": "usage.updated", "snapshot": snapshot }));
            }
        }
        let stop_reason = response
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn");
        events.push(if stop_reason == "cancelled" {
            json!({ "type": "turn.cancelled", "reason": Value::Null })
        } else {
            json!({ "type": "turn.completed", "stopReason": stop_reason })
        });
        let inputs = events
            .into_iter()
            .map(|event| AppendEventInput {
                session_id: session_id.to_owned(),
                turn_id: Some(turn_id.to_owned()),
                event,
                timestamp: now_iso(),
            })
            .collect::<Vec<_>>();
        self.persist_and_publish(session_id, inputs)
    }

    async fn run(
        &self,
        session_id: String,
        mut receiver: tokio::sync::broadcast::Receiver<RpcInbound>,
    ) {
        let mut accumulator = TimelineAccumulator::default();
        let mut tick = time::interval(Duration::from_millis(
            crate::constants::EVENT_BUFFER_WINDOW_MS,
        ));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        tick.tick().await;
        loop {
            tokio::select! {
                message = receiver.recv() => match message {
                    Ok(RpcInbound::Notification(notification)) => {
                        if notification.params.get("update").and_then(|value| value.get("sessionUpdate")).and_then(Value::as_str) == Some("usage_update") {
                            if let Some(usage) = notification.params.get("update").and_then(crate::acp::parse_usage_update) {
                                if let Some(repository) = &self.usage {
                                    if let Ok(snapshot) = repository.record_context(RecordContextInput { session_id: session_id.clone(), observation: usage, occurred_at: now_iso() }) {
                                        let _ = self.persist_and_publish(&session_id, vec![AppendEventInput { session_id: session_id.clone(), turn_id: None, event: json!({"type":"usage.updated","snapshot":snapshot}), timestamp: now_iso() }]);
                                    }
                                }
                            }
                        } else {
                            for event in normalize_notification(&notification) {
                                let input = AppendEventInput { session_id: session_id.clone(), turn_id: notification.params.get("turnId").and_then(Value::as_str).map(ToOwned::to_owned), event, timestamp: now_iso() };
                                for batch in accumulator.push(input) { let _ = self.persist_and_publish(&session_id, batch); }
                            }
                        }
                    }
                    Ok(RpcInbound::Request(request)) => {
                        if let Some(event) = normalize_permission_request(&request) {
                            for batch in accumulator.push(AppendEventInput { session_id: session_id.clone(), turn_id: None, event, timestamp: now_iso() }) { let _ = self.persist_and_publish(&session_id, batch); }
                        }
                    }
                    Ok(RpcInbound::Closed(reason)) => {
                        if let Some(batch) = accumulator.flush() { let _ = self.persist_and_publish(&session_id, batch); }
                        let reason = match reason { RpcError::Closed => "ACP transport closed".to_owned(), other => other.to_string() };
                        let event = json!({ "type": "process.disconnected", "reason": reason, "exitCode": Value::Null });
                        let _ = self.persist_and_publish(&session_id, vec![AppendEventInput { session_id: session_id.clone(), turn_id: None, event, timestamp: now_iso() }]);
                        let _ = self.sessions.update(&session_id, super::contracts::SessionUpdate { status: Some(super::contracts::SessionStatus::Disconnected), updated_at: now_iso(), ..Default::default() });
                        if let Ok(connection) = self.events.database().connection() {
                            let _ = connection.execute("INSERT INTO settings (key, value_json, version, updated_at) VALUES (?1, 'true', 1, ?2) ON CONFLICT(key) DO UPDATE SET value_json = 'true', version = version + 1, updated_at = excluded.updated_at", rusqlite::params![format!("session-reconnected:{session_id}"), now_iso()]);
                        }
                        break;
                    }
                    Ok(RpcInbound::Response(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let event = json!({ "type": "process.disconnected", "reason": "ACP event subscriber lagged", "exitCode": Value::Null });
                        let _ = self.persist_and_publish(&session_id, vec![AppendEventInput { session_id: session_id.clone(), turn_id: None, event, timestamp: now_iso() }]);
                        let _ = self.sessions.update(&session_id, super::contracts::SessionUpdate { status: Some(super::contracts::SessionStatus::Disconnected), updated_at: now_iso(), ..Default::default() });
                        if let Ok(connection) = self.events.database().connection() {
                            let _ = connection.execute("INSERT INTO settings (key, value_json, version, updated_at) VALUES (?1, 'true', 1, ?2) ON CONFLICT(key) DO UPDATE SET value_json = 'true', version = version + 1, updated_at = excluded.updated_at", rusqlite::params![format!("session-reconnected:{session_id}"), now_iso()]);
                        }
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                _ = tick.tick() => if let Some(batch) = accumulator.flush_if_due() { let _ = self.persist_and_publish(&session_id, batch); },
            }
        }
    }

    fn persist_and_publish(
        &self,
        session_id: &str,
        inputs: Vec<AppendEventInput>,
    ) -> Result<Vec<StreamEnvelope>, AppError> {
        if inputs.is_empty() {
            return Ok(Vec::new());
        }
        let envelopes = self.events.append_batch(&inputs)?;
        self.hub.notify(&session_id.to_owned(), envelopes.clone());
        Ok(envelopes)
    }
}

pub(crate) fn now_iso() -> String {
    // Keep timestamps RFC3339-compatible without pulling a second clock/date
    // dependency into this vertical slice.  The civil-date conversion is the
    // well-known proleptic Gregorian decomposition of Unix days.
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        day_seconds / 3_600,
        (day_seconds % 3_600) / 60,
        day_seconds % 60,
        duration.subsec_millis()
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let shifted = days_since_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    (year + if month <= 2 { 1 } else { 0 }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::RpcNotification;
    use crate::db::DbPool;

    fn fixture() -> (SessionRepository, EventRepository, String) {
        let db = DbPool::open_in_memory().unwrap();
        let connection = db.connection().unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        tx.execute("INSERT INTO project_roots (id, project_id, kind, path, real_path, label, sort_order, created_at, updated_at) VALUES ('r','p','primary','/tmp','/tmp','tmp',0,'now','now')", []).unwrap();
        tx.execute("INSERT INTO projects (id,name,primary_root_id,root_revision,root_fingerprint,archived,created_at,updated_at) VALUES ('p','p','r',1,?1,0,'now','now')", ["a".repeat(64)]).unwrap();
        tx.execute("INSERT INTO sessions (id,provider,project_id,last_root_revision,last_root_fingerprint,title,status,created_at,updated_at) VALUES ('s','gemini-cli','p',1,?1,'Neue Session','idle','now','now')", ["a".repeat(64)]).unwrap();
        tx.commit().unwrap();
        drop(connection);
        (
            SessionRepository::new(db.clone()),
            EventRepository::new(db),
            "s".to_owned(),
        )
    }

    #[test]
    fn normalized_notification_is_durable_and_sequence_replayable() {
        let (sessions, events, session_id) = fixture();
        let pipeline = SessionEventPipeline::new(
            Arc::new(SessionManager::new()),
            sessions,
            events.clone(),
            None,
            SubscriptionHub::new(),
        );
        let envelopes = pipeline.ingest_notification(&session_id, &RpcNotification {
            jsonrpc: "2.0".to_owned(), method: "session/update".to_owned(),
            params: json!({"update":{"sessionUpdate":"agent_message_chunk","messageId":"m","content":{"text":"hello"}}}),
        }, Some("turn".to_owned())).unwrap();
        assert_eq!(envelopes[0].seq, 1);
        assert_eq!(envelopes[0].event["type"], "message.assistant.delta");
        assert_eq!(events.list_after(&session_id, 0, 10).unwrap().len(), 1);
    }
}
