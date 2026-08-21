import {
  AgentEventSchema,
  EntityIdSchema,
  IsoTimestampSchema,
  migrateLegacyUsageEvent,
  StreamEnvelopeSchema,
  type AgentEvent,
  type StreamEnvelope,
} from "../../../shared";
import type { SqliteDatabase } from "../database";
import { StorageCorruptionError } from "../errors";

type EventRow = {
  session_id: string;
  seq: number;
  turn_id: string | null;
  event_type: string;
  payload_json: string;
  created_at: string;
};

export type AppendEventInput = {
  sessionId: string;
  turnId: string | null;
  event: AgentEvent;
  timestamp: string;
};

export class EventRepository {
  constructor(private readonly database: SqliteDatabase) {}

  append(input: AppendEventInput): StreamEnvelope {
    return this.database.transaction(() => this.appendInsideTransaction(input))();
  }

  appendBatch(inputs: readonly AppendEventInput[]): StreamEnvelope[] {
    if (inputs.length === 0) return [];
    if (inputs.length > 1_000) {
      throw new RangeError("An event batch may contain at most 1000 events");
    }

    return this.database.transaction(() =>
      inputs.map((input) => this.appendInsideTransaction(input)),
    )();
  }

  listAfter(sessionId: string, afterSeq: number, limit = 1_000): StreamEnvelope[] {
    EntityIdSchema.parse(sessionId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new RangeError("afterSeq must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("limit must be between 1 and 1000");
    }

    const rows = this.database
      .prepare(
        `SELECT session_id, seq, turn_id, event_type, payload_json, created_at
         FROM events
         WHERE session_id = ? AND seq > ?
         ORDER BY seq
         LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit) as EventRow[];
    return rows.map(parseEventRow);
  }

  latestSequence(sessionId: string): number {
    const row = this.database
      .prepare("SELECT MAX(seq) AS seq FROM events WHERE session_id = ?")
      .get(sessionId) as { seq: number | null };
    return row.seq ?? 0;
  }

  searchByContent(projectId: string, query: string): Array<{ sessionId: string; snippet: string }> {
    EntityIdSchema.parse(projectId);
    const trimmed = query.trim();
    if (!trimmed) return [];

    const searchPattern = `%${trimmed}%`;
    const rows = this.database
      .prepare(
        `SELECT e.session_id, e.payload_json
         FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE s.project_id = ? AND e.payload_json LIKE ?
         ORDER BY e.created_at DESC`,
      )
      .all(projectId, searchPattern) as Array<{ session_id: string; payload_json: string }>;

    const resultMap = new Map<string, string>();
    const lowerQuery = trimmed.toLowerCase();

    for (const row of rows) {
      if (resultMap.has(row.session_id)) continue;
      try {
        const event = JSON.parse(row.payload_json) as Record<string, unknown>;
        let text = "";
        if (typeof event.text === "string") {
          text = event.text;
        } else if (typeof event.delta === "string") {
          text = event.delta;
        } else if (typeof event.title === "string") {
          text = event.title;
        } else if (typeof event.error === "string") {
          text = event.error;
        }
        const idx = text.toLowerCase().indexOf(lowerQuery);
        if (idx !== -1) {
          const start = Math.max(0, idx - 25);
          const end = Math.min(text.length, idx + trimmed.length + 35);
          const prefix = start > 0 ? "…" : "";
          const suffix = end < text.length ? "…" : "";
          const snippet = `${prefix}${text.slice(start, end).replaceAll("\n", " ").trim()}${suffix}`;
          resultMap.set(row.session_id, snippet);
        }
      } catch {
        // ignore parse error
      }
    }

    return Array.from(resultMap.entries()).map(([sessionId, snippet]) => ({
      sessionId,
      snippet,
    }));
  }

  private appendInsideTransaction(input: AppendEventInput): StreamEnvelope {
    const sessionId = EntityIdSchema.parse(input.sessionId);
    const turnId = input.turnId === null ? null : EntityIdSchema.parse(input.turnId);
    const event = AgentEventSchema.parse(input.event);
    const timestamp = IsoTimestampSchema.parse(input.timestamp);
    const seq = this.latestSequence(sessionId) + 1;

    this.database
      .prepare(
        `INSERT INTO events (
           session_id, seq, turn_id, event_type, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        seq,
        turnId,
        event.type,
        JSON.stringify(event),
        timestamp,
      );

    return StreamEnvelopeSchema.parse({
      seq,
      sessionId,
      turnId,
      event,
      timestamp,
    });
  }
}

function parseEventRow(row: EventRow): StreamEnvelope {
  try {
    // Rows written before the usage snapshot contract are read-compatible: they
    // are lifted into a snapshot that is explicitly marked as legacy.
    const event = AgentEventSchema.parse(
      migrateLegacyUsageEvent(JSON.parse(row.payload_json)),
    );
    if (event.type !== row.event_type) {
      throw new Error("event_type does not match the serialized event");
    }
    return StreamEnvelopeSchema.parse({
      seq: row.seq,
      sessionId: row.session_id,
      turnId: row.turn_id,
      event,
      timestamp: row.created_at,
    });
  } catch (error) {
    throw new StorageCorruptionError("event", { cause: error });
  }
}
