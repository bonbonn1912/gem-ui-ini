//! Idempotent turn usage aggregation and durable snapshots.
//! Restored from the isolated sessions build snapshot.

pub use crate::acp::usage::UsageCost;
use crate::acp::usage::{
    ModelTokenUsage, TokenCounters, TokenUsageSource, TotalKind, UsageContextObservation,
    UsageScope, UsageTokenObservation,
};
use crate::db::DbPool;
use crate::error::AppError;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionUsageCoverage {
    Complete,
    Partial,
    ProviderReported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageSnapshotSource {
    GeminuiAggregate,
    AcpPromptUsage,
    LegacyEvent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextSnapshotSource {
    AcpUsageUpdate,
    LegacyEvent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastTurnUsage {
    pub turn_id: String,
    pub tokens: TokenCounters,
    pub by_model: Vec<ModelTokenUsage>,
    pub source: TokenUsageSource,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionUsage {
    pub tokens: TokenCounters,
    pub coverage: SessionUsageCoverage,
    pub source: UsageSnapshotSource,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextUsage {
    pub used: u64,
    pub size: u64,
    pub source: ContextSnapshotSource,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CostUsage {
    pub amount: f64,
    pub currency: String,
    pub source: ContextSnapshotSource,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageSnapshot {
    pub revision: u64,
    pub last_turn: Option<LastTurnUsage>,
    pub session: Option<SessionUsage>,
    pub context: Option<ContextUsage>,
    pub cost: Option<CostUsage>,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct RecordTokensInput {
    pub session_id: String,
    pub turn_id: String,
    pub observation: UsageTokenObservation,
    pub occurred_at: String,
}

#[derive(Clone, Debug)]
pub struct RecordContextInput {
    pub session_id: String,
    pub observation: UsageContextObservation,
    pub occurred_at: String,
}

#[derive(Clone, Debug)]
pub struct TurnUsageRow {
    pub turn_id: String,
    pub source: TokenUsageSource,
    pub tokens: TokenCounters,
    pub by_model: Vec<ModelTokenUsage>,
    pub observed_at: String,
}

#[derive(Clone)]
pub struct UsageRepository {
    db: DbPool,
}

impl UsageRepository {
    pub fn new(db: DbPool) -> Self {
        Self { db }
    }

    pub fn database(&self) -> DbPool {
        self.db.clone()
    }

    pub fn reserve_turn(&self, session_id: &str, row: &TurnUsageRow) -> Result<bool, AppError> {
        let connection = self.db.connection()?;
        let changed = connection.execute(
            "INSERT INTO turn_usage (session_id, turn_id, source, input_tokens, output_tokens,
             total_tokens, thought_tokens, cached_read_tokens, cached_write_tokens, tool_tokens,
             total_kind, model_usage_json, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
             ?9, ?10, ?11, ?12, ?13) ON CONFLICT (session_id, turn_id) DO NOTHING",
            params![
                session_id,
                row.turn_id,
                source_as_str(row.source),
                row.tokens.input.map(as_i64),
                row.tokens.output.map(as_i64),
                row.tokens.total.map(as_i64),
                row.tokens.thought.map(as_i64),
                row.tokens.cached_read.map(as_i64),
                row.tokens.cached_write.map(as_i64),
                row.tokens.tool.map(as_i64),
                row.tokens.total_kind.map(total_kind_as_str),
                serde_json::to_string(&row.by_model)?,
                row.observed_at,
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn read_snapshot(&self, session_id: &str) -> Result<Option<UsageSnapshot>, AppError> {
        let connection = self.db.connection()?;
        read_snapshot_from(&connection, session_id)
    }

    pub fn write_snapshot(
        &self,
        session_id: &str,
        snapshot: &UsageSnapshot,
    ) -> Result<(), AppError> {
        validate_snapshot(snapshot)?;
        let connection = self.db.connection()?;
        connection.execute(
            "INSERT INTO session_usage (session_id, revision, snapshot_json, updated_at)
             VALUES (?1, ?2, ?3, ?4) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision,
             snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at",
            params![session_id, as_i64(snapshot.revision), serde_json::to_string(snapshot)?, snapshot.updated_at],
        )?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct UsageService {
    repository: UsageRepository,
}

impl UsageService {
    pub fn new(repository: UsageRepository) -> Self {
        Self { repository }
    }

    pub fn get_snapshot(&self, session_id: &str) -> Result<Option<UsageSnapshot>, AppError> {
        self.repository.read_snapshot(session_id)
    }

    /// Records one observation and atomically reserves turn usage, recomputes
    /// the aggregate, and writes the next snapshot. Replays of a turn are a
    /// no-op and return `None` exactly like the former UsageService.
    pub fn record_tokens(
        &self,
        input: RecordTokensInput,
    ) -> Result<Option<UsageSnapshot>, AppError> {
        let mut connection = self.repository.db.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_snapshot_from(&transaction, &input.session_id)?;
        if matches!(input.observation.scope, UsageScope::Turn) {
            let changed = reserve_turn_in(
                &transaction,
                &input.session_id,
                &TurnUsageRow {
                    turn_id: input.turn_id.clone(),
                    source: input.observation.source,
                    tokens: input.observation.tokens.clone(),
                    by_model: input.observation.by_model.clone(),
                    observed_at: input.occurred_at.clone(),
                },
            )?;
            if !changed {
                return Ok(None);
            }
        }
        let aggregate = aggregate_in(&transaction, &input.session_id)?;
        let provider_session = if matches!(input.observation.scope, UsageScope::SessionCumulative) {
            Some(SessionUsage {
                tokens: input.observation.tokens.clone(),
                coverage: SessionUsageCoverage::ProviderReported,
                source: UsageSnapshotSource::AcpPromptUsage,
            })
        } else if previous
            .as_ref()
            .and_then(|snapshot| snapshot.session.as_ref())
            .is_some_and(|session| session.coverage == SessionUsageCoverage::ProviderReported)
        {
            previous
                .as_ref()
                .and_then(|snapshot| snapshot.session.clone())
        } else {
            None
        };
        let unaccounted = has_unaccounted_turns(&transaction, &input.session_id)?;
        let session = provider_session
            .or_else(|| {
                (aggregate.turns > 0).then_some(SessionUsage {
                    tokens: aggregate.tokens,
                    coverage: if unaccounted {
                        SessionUsageCoverage::Partial
                    } else {
                        SessionUsageCoverage::Complete
                    },
                    source: UsageSnapshotSource::GeminuiAggregate,
                })
            })
            .or_else(|| {
                previous
                    .as_ref()
                    .and_then(|snapshot| snapshot.session.clone())
            });
        let next = UsageSnapshot {
            revision: previous
                .as_ref()
                .map_or(1, |snapshot| snapshot.revision.saturating_add(1)),
            last_turn: Some(LastTurnUsage {
                turn_id: input.turn_id,
                tokens: input.observation.tokens,
                by_model: input.observation.by_model,
                source: input.observation.source,
            }),
            session,
            context: previous
                .as_ref()
                .and_then(|snapshot| snapshot.context.clone()),
            cost: previous.as_ref().and_then(|snapshot| snapshot.cost.clone()),
            updated_at: input.occurred_at,
        };
        write_snapshot_in(&transaction, &input.session_id, &next)?;
        transaction.commit()?;
        Ok(Some(next))
    }

    /// Context-window occupancy is orthogonal to consumption and never changes
    /// `last_turn` or `session.tokens`.
    pub fn record_context(&self, input: RecordContextInput) -> Result<UsageSnapshot, AppError> {
        let mut connection = self.repository.db.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous = read_snapshot_from(&transaction, &input.session_id)?;
        let next = UsageSnapshot {
            revision: previous
                .as_ref()
                .map_or(1, |snapshot| snapshot.revision.saturating_add(1)),
            last_turn: previous
                .as_ref()
                .and_then(|snapshot| snapshot.last_turn.clone()),
            session: previous
                .as_ref()
                .and_then(|snapshot| snapshot.session.clone()),
            context: Some(ContextUsage {
                used: input.observation.used,
                size: input.observation.size,
                source: ContextSnapshotSource::AcpUsageUpdate,
            }),
            cost: input
                .observation
                .cost
                .map(|cost| CostUsage {
                    amount: cost.amount,
                    currency: cost.currency,
                    source: ContextSnapshotSource::AcpUsageUpdate,
                })
                .or_else(|| previous.as_ref().and_then(|snapshot| snapshot.cost.clone())),
            updated_at: input.occurred_at,
        };
        write_snapshot_in(&transaction, &input.session_id, &next)?;
        transaction.commit()?;
        Ok(next)
    }

    pub fn invalidate_context(
        &self,
        session_id: &str,
        occurred_at: String,
    ) -> Result<Option<UsageSnapshot>, AppError> {
        let mut connection = self.repository.db.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(previous) = read_snapshot_from(&transaction, session_id)? else {
            return Ok(None);
        };
        if previous.context.is_none() {
            return Ok(None);
        }
        let next = UsageSnapshot {
            revision: previous.revision.saturating_add(1),
            last_turn: previous.last_turn,
            session: previous.session,
            context: None,
            cost: previous.cost,
            updated_at: occurred_at,
        };
        write_snapshot_in(&transaction, session_id, &next)?;
        transaction.commit()?;
        Ok(Some(next))
    }
}

#[derive(Clone, Debug)]
struct Aggregate {
    turns: u64,
    tokens: TokenCounters,
}

fn reserve_turn_in(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    row: &TurnUsageRow,
) -> Result<bool, AppError> {
    let changed = transaction.execute(
        "INSERT INTO turn_usage (session_id, turn_id, source, input_tokens, output_tokens,
         total_tokens, thought_tokens, cached_read_tokens, cached_write_tokens, tool_tokens,
         total_kind, model_usage_json, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
         ?9, ?10, ?11, ?12, ?13) ON CONFLICT (session_id, turn_id) DO NOTHING",
        params![
            session_id,
            row.turn_id,
            source_as_str(row.source),
            row.tokens.input.map(as_i64),
            row.tokens.output.map(as_i64),
            row.tokens.total.map(as_i64),
            row.tokens.thought.map(as_i64),
            row.tokens.cached_read.map(as_i64),
            row.tokens.cached_write.map(as_i64),
            row.tokens.tool.map(as_i64),
            row.tokens.total_kind.map(total_kind_as_str),
            serde_json::to_string(&row.by_model)?,
            row.observed_at,
        ],
    )?;
    Ok(changed == 1)
}

fn aggregate_in(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
) -> Result<Aggregate, AppError> {
    let row = transaction.query_row(
        "SELECT COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(total_tokens),
         SUM(thought_tokens), SUM(cached_read_tokens), SUM(cached_write_tokens), SUM(tool_tokens),
         SUM(CASE WHEN total_kind = 'provider' THEN 1 ELSE 0 END)
         FROM turn_usage WHERE session_id = ?1",
        [session_id],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, i64>(8)?,
            ))
        },
    )?;
    let total = optional_count(row.3)?;
    let provider_totals = row.8.max(0) as u64;
    let turns = row.0.max(0) as u64;
    Ok(Aggregate {
        turns,
        tokens: TokenCounters {
            input: optional_count(row.1)?,
            output: optional_count(row.2)?,
            total,
            thought: optional_count(row.4)?,
            cached_read: optional_count(row.5)?,
            cached_write: optional_count(row.6)?,
            tool: optional_count(row.7)?,
            total_kind: total.map(|_| {
                if provider_totals == turns {
                    TotalKind::Provider
                } else {
                    TotalKind::DerivedInputPlusOutput
                }
            }),
        },
    })
}

fn has_unaccounted_turns(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
) -> Result<bool, AppError> {
    let result: i64 = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM events e WHERE e.session_id = ?1 AND e.event_type = 'turn.completed'
         AND e.turn_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turn_usage t
         WHERE t.session_id = e.session_id AND t.turn_id = e.turn_id))",
        [session_id],
        |row| row.get(0),
    )?;
    Ok(result == 1)
}

fn read_snapshot_from(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<UsageSnapshot>, AppError> {
    let value: Option<(i64, String)> = connection
        .query_row(
            "SELECT revision, snapshot_json FROM session_usage WHERE session_id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((revision, json)) = value else {
        return Ok(None);
    };
    let mut snapshot: UsageSnapshot = serde_json::from_str(&json).map_err(|error| {
        AppError::Internal(format!("stored usage snapshot is invalid: {error}"))
    })?;
    snapshot.revision = revision
        .try_into()
        .map_err(|_| AppError::Internal("stored usage revision is negative".to_owned()))?;
    validate_snapshot(&snapshot).map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(Some(snapshot))
}

fn write_snapshot_in(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    snapshot: &UsageSnapshot,
) -> Result<(), AppError> {
    validate_snapshot(snapshot)?;
    transaction.execute(
        "INSERT INTO session_usage (session_id, revision, snapshot_json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision,
         snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at",
        params![session_id, as_i64(snapshot.revision), serde_json::to_string(snapshot)?, snapshot.updated_at],
    )?;
    Ok(())
}

fn validate_snapshot(snapshot: &UsageSnapshot) -> Result<(), AppError> {
    if snapshot.updated_at.trim().is_empty() {
        return Err(AppError::Validation(
            "usage updatedAt is required".to_owned(),
        ));
    }
    if let Some(context) = &snapshot.context {
        if context.size == 0 {
            return Err(AppError::Validation(
                "usage context window is invalid".to_owned(),
            ));
        }
    }
    if let Some(cost) = &snapshot.cost {
        if !cost.amount.is_finite() || cost.amount < 0.0 || cost.currency.len() != 3 {
            return Err(AppError::Validation("usage cost is invalid".to_owned()));
        }
    }
    Ok(())
}

fn source_as_str(value: TokenUsageSource) -> &'static str {
    match value {
        TokenUsageSource::AcpPromptUsage => "acp_prompt_usage",
        TokenUsageSource::GeminiMetaQuota => "gemini_meta_quota",
    }
}

fn total_kind_as_str(value: TotalKind) -> &'static str {
    match value {
        TotalKind::Provider => "provider",
        TotalKind::DerivedInputPlusOutput => "derived_input_plus_output",
    }
}

fn as_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn optional_count(value: Option<i64>) -> Result<Option<u64>, AppError> {
    value
        .map(|value| {
            u64::try_from(value)
                .map_err(|_| AppError::Internal("stored usage count is negative".to_owned()))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::DbPool;

    fn fixture() -> UsageService {
        let db = DbPool::open_in_memory().unwrap();
        let connection = db.connection().unwrap();
        let tx = connection.unchecked_transaction().unwrap();
        tx.execute("INSERT INTO project_roots (id, project_id, kind, path, real_path, label, sort_order, created_at, updated_at) VALUES ('r', 'p', 'primary', '/tmp', '/tmp', 'tmp', 0, 'now', 'now')", []).unwrap();
        tx.execute("INSERT INTO projects (id, name, primary_root_id, root_revision, root_fingerprint, archived, created_at, updated_at) VALUES ('p', 'p', 'r', 1, ?1, 0, 'now', 'now')", ["a".repeat(64)]).unwrap();
        tx.execute("INSERT INTO sessions (id, provider, project_id, last_root_revision, last_root_fingerprint, title, status, created_at, updated_at) VALUES ('s', 'gemini-cli', 'p', 1, ?1, 's', 'idle', 'now', 'now')", ["a".repeat(64)]).unwrap();
        tx.commit().unwrap();
        drop(connection);
        UsageService::new(UsageRepository::new(db))
    }

    fn turn(input: u64, output: u64) -> UsageTokenObservation {
        UsageTokenObservation {
            kind: "tokens".into(),
            scope: UsageScope::Turn,
            source: TokenUsageSource::GeminiMetaQuota,
            tokens: TokenCounters {
                input: Some(input),
                output: Some(output),
                total: Some(input + output),
                total_kind: Some(TotalKind::DerivedInputPlusOutput),
                ..Default::default()
            },
            by_model: vec![],
        }
    }

    #[test]
    fn aggregates_turns_once_and_restores_snapshot() {
        let service = fixture();
        let first = service
            .record_tokens(RecordTokensInput {
                session_id: "s".into(),
                turn_id: "a".into(),
                observation: turn(100, 20),
                occurred_at: "now".into(),
            })
            .unwrap()
            .unwrap();
        let second = service
            .record_tokens(RecordTokensInput {
                session_id: "s".into(),
                turn_id: "b".into(),
                observation: turn(10, 5),
                occurred_at: "now".into(),
            })
            .unwrap()
            .unwrap();
        assert_eq!(first.session.unwrap().tokens.total, Some(120));
        assert_eq!(second.session.unwrap().tokens.total, Some(135));
        assert!(service
            .record_tokens(RecordTokensInput {
                session_id: "s".into(),
                turn_id: "b".into(),
                observation: turn(10, 5),
                occurred_at: "now".into()
            })
            .unwrap()
            .is_none());
        assert_eq!(
            service
                .get_snapshot("s")
                .unwrap()
                .unwrap()
                .session
                .unwrap()
                .tokens
                .total,
            Some(135)
        );
    }

    #[test]
    fn context_does_not_overwrite_consumption_and_can_be_invalidated() {
        let service = fixture();
        service
            .record_tokens(RecordTokensInput {
                session_id: "s".into(),
                turn_id: "a".into(),
                observation: turn(100, 20),
                occurred_at: "now".into(),
            })
            .unwrap();
        let context = service
            .record_context(RecordContextInput {
                session_id: "s".into(),
                observation: UsageContextObservation {
                    kind: "context".into(),
                    source: "acp_usage_update".into(),
                    used: 10,
                    size: 100,
                    cost: Some(UsageCost {
                        amount: 0.1,
                        currency: "USD".into(),
                    }),
                },
                occurred_at: "now".into(),
            })
            .unwrap();
        assert_eq!(context.session.unwrap().tokens.total, Some(120));
        assert!(service
            .invalidate_context("s", "now".into())
            .unwrap()
            .unwrap()
            .context
            .is_none());
    }

    #[test]
    fn cumulative_provider_value_replaces_aggregate() {
        let service = fixture();
        service
            .record_tokens(RecordTokensInput {
                session_id: "s".into(),
                turn_id: "a".into(),
                observation: turn(100, 20),
                occurred_at: "now".into(),
            })
            .unwrap();
        let snapshot = service
            .record_tokens(RecordTokensInput {
                session_id: "s".into(),
                turn_id: "b".into(),
                observation: UsageTokenObservation {
                    kind: "tokens".into(),
                    scope: UsageScope::SessionCumulative,
                    source: TokenUsageSource::AcpPromptUsage,
                    tokens: TokenCounters {
                        input: Some(150),
                        output: Some(30),
                        total: Some(180),
                        total_kind: Some(TotalKind::Provider),
                        ..Default::default()
                    },
                    by_model: vec![],
                },
                occurred_at: "now".into(),
            })
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.session.unwrap().tokens.total, Some(180));
    }
}
