import {
  UsageSnapshotSchema,
  type ModelTokenUsage,
  type TokenCounters,
  type UsageSnapshot,
} from "../../../shared";
import type { SqliteDatabase } from "../database";
import { StorageCorruptionError } from "../errors";

export type TurnUsageSource = "acp_prompt_usage" | "gemini_meta_quota";

export type TurnUsageRow = {
  readonly turnId: string;
  readonly source: TurnUsageSource;
  readonly tokens: TokenCounters;
  readonly byModel: readonly ModelTokenUsage[];
  readonly observedAt: string;
};

export type StoredUsageSnapshot = {
  readonly revision: number;
  readonly snapshot: UsageSnapshot;
};

type SnapshotRow = { revision: number; snapshot_json: string };

type SumRow = {
  turns: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  thought_tokens: number | null;
  cached_read_tokens: number | null;
  cached_write_tokens: number | null;
  tool_tokens: number | null;
  provider_totals: number;
};

/**
 * Persists per-turn usage and the derived session snapshot.
 *
 * `turn_usage` is the idempotency guard: a turn id may contribute exactly once,
 * no matter how often an observation is retried or replayed. The session totals
 * are always recomputed from those rows, so a repeated observation can never
 * inflate the counters.
 */
export class UsageRepository {
  constructor(private readonly database: SqliteDatabase) {}

  /**
   * Reserves a turn observation. Returns false when this turn was already
   * counted, in which case the caller must not aggregate again.
   */
  reserveTurn(sessionId: string, row: TurnUsageRow): boolean {
    const result = this.database
      .prepare(
        `INSERT INTO turn_usage (
           session_id, turn_id, source, input_tokens, output_tokens, total_tokens,
           thought_tokens, cached_read_tokens, cached_write_tokens, tool_tokens,
           total_kind, model_usage_json, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, turn_id) DO NOTHING`,
      )
      .run(
        sessionId,
        row.turnId,
        row.source,
        row.tokens.input,
        row.tokens.output,
        row.tokens.total,
        row.tokens.thought,
        row.tokens.cachedRead,
        row.tokens.cachedWrite,
        row.tokens.tool,
        row.tokens.totalKind,
        JSON.stringify(row.byModel),
        row.observedAt,
      );
    return result.changes > 0;
  }

  aggregatedTurns(sessionId: string): {
    turns: number;
    tokens: TokenCounters;
    byModel: ModelTokenUsage[];
  } {
    const row = this.database
      .prepare(
        `SELECT
           COUNT(*) AS turns,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(total_tokens) AS total_tokens,
           SUM(thought_tokens) AS thought_tokens,
           SUM(cached_read_tokens) AS cached_read_tokens,
           SUM(cached_write_tokens) AS cached_write_tokens,
           SUM(tool_tokens) AS tool_tokens,
           SUM(CASE WHEN total_kind = 'provider' THEN 1 ELSE 0 END) AS provider_totals
         FROM turn_usage WHERE session_id = ?`,
      )
      .get(sessionId) as SumRow;

    const modelRows = this.database
      .prepare(
        `SELECT model_usage_json FROM turn_usage WHERE session_id = ? AND model_usage_json IS NOT NULL`,
      )
      .all(sessionId) as { model_usage_json: string }[];

    const modelMap = new Map<string, { input: number; output: number }>();
    for (const r of modelRows) {
      try {
        const list = JSON.parse(r.model_usage_json) as ModelTokenUsage[];
        if (Array.isArray(list)) {
          for (const m of list) {
            if (m && typeof m.model === "string") {
              const current = modelMap.get(m.model) ?? { input: 0, output: 0 };
              modelMap.set(m.model, {
                input: current.input + (m.input || 0),
                output: current.output + (m.output || 0),
              });
            }
          }
        }
      } catch {
        // ignore malformed JSON
      }
    }

    const byModel: ModelTokenUsage[] = Array.from(modelMap.entries()).map(
      ([model, counts]) => ({
        model,
        input: counts.input,
        output: counts.output,
      }),
    );

    const total = safeSum(row.total_tokens);
    return {
      turns: row.turns,
      tokens: {
        input: safeSum(row.input_tokens),
        output: safeSum(row.output_tokens),
        total,
        thought: safeSum(row.thought_tokens),
        cachedRead: safeSum(row.cached_read_tokens),
        cachedWrite: safeSum(row.cached_write_tokens),
        tool: safeSum(row.tool_tokens),
        totalKind:
          total === null
            ? null
            : row.provider_totals === row.turns
              ? "provider"
              : "derived_input_plus_output",
      },
      byModel,
    };
  }

  /**
   * True when this session completed a turn that never produced a usage row.
   * Those turns are the reason a session total may only be labelled "partial".
   */
  hasUnaccountedTurns(sessionId: string): boolean {
    const row = this.database
      .prepare(
        `SELECT EXISTS(
           SELECT 1 FROM events e
           WHERE e.session_id = ?
             AND e.event_type = 'turn.completed'
             AND e.turn_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM turn_usage t
               WHERE t.session_id = e.session_id AND t.turn_id = e.turn_id
             )
         ) AS unaccounted`,
      )
      .get(sessionId) as { unaccounted: number };
    return row.unaccounted === 1;
  }

  readSnapshot(sessionId: string): StoredUsageSnapshot | null {
    const row = this.database
      .prepare(
        "SELECT revision, snapshot_json FROM session_usage WHERE session_id = ?",
      )
      .get(sessionId) as SnapshotRow | undefined;
    if (!row) return null;
    try {
      return {
        revision: row.revision,
        snapshot: UsageSnapshotSchema.parse(JSON.parse(row.snapshot_json)),
      };
    } catch (error) {
      throw new StorageCorruptionError("session_usage", { cause: error });
    }
  }

  writeSnapshot(sessionId: string, snapshot: UsageSnapshot): UsageSnapshot {
    const validated = UsageSnapshotSchema.parse(snapshot);
    this.database
      .prepare(
        `INSERT INTO session_usage (session_id, revision, snapshot_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           revision = excluded.revision,
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        sessionId,
        validated.revision,
        JSON.stringify(validated),
        validated.updatedAt,
      );
    return validated;
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }
}

function safeSum(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}
