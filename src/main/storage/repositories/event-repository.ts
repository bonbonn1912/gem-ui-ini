import { EventBlobRepository } from "./event-blob-repository";
import { TimelineSnapshotRepository, type TimelinePageCursor } from "./timeline-snapshot-repository";
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

type FlexibleStatement = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};
const prepareFlexible = (database: SqliteDatabase, sql: string): FlexibleStatement =>
  database.prepare(sql) as unknown as FlexibleStatement;

export type AppendEventInput = {
  sessionId: string;
  turnId: string | null;
  event: AgentEvent;
  timestamp: string;
};

export class EventRepository {
  readonly #database: SqliteDatabase;
  readonly #statements = new Map<string, FlexibleStatement>();
  private statement(sql: string): FlexibleStatement {
    let value = this.#statements.get(sql);
    if (!value) { value = prepareFlexible(this.#database, sql); this.#statements.set(sql,value); }
    return value;
  }
  readonly #insertEvent: FlexibleStatement;
  readonly #latestSeq: FlexibleStatement;
  readonly #upsertMessage: FlexibleStatement;
  readonly #insertMessageFragment: FlexibleStatement;
  readonly #messageFragments: FlexibleStatement;
  readonly #existingMessage: FlexibleStatement;
  readonly #deleteFtsMessage: FlexibleStatement;
  readonly #insertFtsMessage: FlexibleStatement;
  #backfillScheduled = false;
  #disposed = false;
  readonly #timeline: TimelineSnapshotRepository;
  readonly #blobs: EventBlobRepository;

  constructor(database: SqliteDatabase) {
    this.#database = database;
    this.#timeline = new TimelineSnapshotRepository(database);
    this.#blobs = new EventBlobRepository(database);
    this.#insertEvent = prepareFlexible(database,
      `INSERT INTO events (session_id, seq, turn_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.#latestSeq = prepareFlexible(database, "SELECT MAX(seq) AS seq FROM events WHERE session_id = ?");
    this.#upsertMessage = prepareFlexible(database,
      `INSERT INTO message_search(session_id, message_id, role, text, last_seq, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, message_id) DO UPDATE SET
         role = excluded.role,
         text = excluded.text,
         last_seq = excluded.last_seq,
         updated_at = excluded.updated_at`,
    );
    this.#insertMessageFragment = prepareFlexible(database,
      "INSERT OR IGNORE INTO message_search_fragments(session_id, message_id, seq, delta) VALUES (?, ?, ?, ?)",
    );
    this.#messageFragments = prepareFlexible(database,
      "SELECT delta FROM message_search_fragments WHERE session_id = ? AND message_id = ? ORDER BY seq",
    );
    this.#existingMessage = prepareFlexible(database,
      "SELECT text, last_seq FROM message_search WHERE session_id = ? AND message_id = ?",
    );
    this.#deleteFtsMessage = prepareFlexible(database, "DELETE FROM message_search_fts WHERE rowid = (SELECT rowid FROM message_search WHERE session_id = ? AND message_id = ?)");
    this.#insertFtsMessage = prepareFlexible(database, "INSERT INTO message_search_fts(rowid,session_id,message_id,text) SELECT rowid,session_id,message_id,? FROM message_search WHERE session_id=? AND message_id=?");

  }

  getBlob(sessionId: string, blobId: string) { return this.#blobs.get(sessionId, blobId); }

  startBackgroundWork(): void { this.#scheduleBackfill(); }
  dispose(): void { this.#disposed = true; }

  timelinePage(input: { sessionId: string; throughSeq?: number; before?: TimelinePageCursor | null; limit?: number }) {
    const throughSeq = input.throughSeq ?? this.latestSequence(input.sessionId);
    const progress = this.statement("SELECT last_seq FROM timeline_progress WHERE session_id=?").get(input.sessionId) as { last_seq: number } | undefined;
    if ((progress?.last_seq ?? 0) < throughSeq) return { throughSeq, items: [], nextBefore: null, hasMore: false, complete: false };
    return { ...this.#timeline.page({ ...input, throughSeq }), complete: true };
  }

  backfillTimeline(limit = 200): boolean {
    const session = this.statement(`SELECT s.id, COALESCE(p.last_seq,0) AS last_seq FROM sessions s
      LEFT JOIN timeline_progress p ON p.session_id=s.id
      WHERE COALESCE(p.last_seq,0) < COALESCE((SELECT MAX(seq) FROM events e WHERE e.session_id=s.id),0)
      ORDER BY s.id LIMIT 1`).get() as { id: string; last_seq: number } | undefined;
    if (!session) return true;
    const events = this.listAfter(session.id, session.last_seq, limit);
    this.#database.transaction(() => { for (const event of events) this.projectTimeline(event); })();
    return false;
  }

  private projectTimeline(event: StreamEnvelope): void {
    const progress = this.statement("SELECT last_seq FROM timeline_progress WHERE session_id=?").get(event.sessionId) as { last_seq: number } | undefined;
    if ((progress?.last_seq ?? 0) !== event.seq - 1) return;
    this.#timeline.apply(event);
    this.statement(`INSERT INTO timeline_progress(session_id,last_seq) VALUES (?,?)
      ON CONFLICT(session_id) DO UPDATE SET last_seq=excluded.last_seq`).run(event.sessionId, event.seq);
  }

  append(input: AppendEventInput): StreamEnvelope {
    return this.appendBatch([input])[0];
  }

  appendBatch(inputs: readonly AppendEventInput[]): StreamEnvelope[] {
    if (inputs.length === 0) return [];
    if (inputs.length > 1_000) {
      throw new RangeError("An event batch may contain at most 1000 events");
    }

    return this.#database.transaction(() => {
      const nextBySession = new Map<string, number>();
      return inputs.map((input) => {
        const sessionId = EntityIdSchema.parse(input.sessionId);
        let next = nextBySession.get(sessionId);
        if (next === undefined) {
          next = this.latestSequence(sessionId);
        }
        next += 1;
        nextBySession.set(sessionId, next);
        return this.appendInsideTransaction(input, next);
      });
    })();
  }

  listAfter(sessionId: string, afterSeq: number, limit = 1_000): StreamEnvelope[] {
    EntityIdSchema.parse(sessionId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new RangeError("afterSeq must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("limit must be between 1 and 1000");
    }

    const rows = this
      .statement(
        `SELECT session_id, seq, turn_id, event_type, payload_json, created_at
         FROM events
         WHERE session_id = ? AND seq > ?
         ORDER BY seq
         LIMIT ?`,
      )
      .all(sessionId, afterSeq, limit) as EventRow[];
    return rows.map(parseEventRow);
  }

  listThrough(sessionId: string, afterSeq: number, throughSeq: number, limit = 200): StreamEnvelope[] {
    EntityIdSchema.parse(sessionId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(throughSeq) || throughSeq < afterSeq) {
      throw new RangeError("Invalid replay cursor");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("limit must be between 1 and 500");
    const rows = this.statement(
      `SELECT session_id, seq, turn_id, event_type, payload_json, created_at FROM events
       WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
    ).all(sessionId, afterSeq, throughSeq, limit) as EventRow[];
    const result: StreamEnvelope[] = [];
    let bytes = 0;
    const maxPageBytes = 2 * 1024 * 1024;
    for (const row of rows) {
      const parsed = parseEventRow(row);
      const rowBytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
      if (result.length > 0 && bytes + rowBytes > maxPageBytes) break;
      result.push(parsed);
      bytes += rowBytes;
    }
    return result;
  }

  latestSequence(sessionId: string): number {
    const row = this.#latestSeq.get(sessionId) as { seq: number | null };
    return row.seq ?? 0;
  }

  hasMessageHistory(sessionId: string): boolean {
    EntityIdSchema.parse(sessionId);
    const row = this.statement(
      `SELECT EXISTS(SELECT 1 FROM events
         WHERE session_id = ? AND event_type IN ('message.user', 'message.assistant.delta')) AS found`,
    ).get(sessionId) as { found: number };
    return row.found === 1;
  }

  async recentMessages(sessionId: string, limit: number): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
    EntityIdSchema.parse(sessionId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("limit must be between 1 and 200");
    // Read backwards in bounded pages, including the beginning of the oldest
    // selected message. Never cut a message merely because a page ended.
    const statement = this.statement(`SELECT seq,event_type,payload_json FROM events
      WHERE session_id=? AND seq<? AND event_type IN ('message.user','message.assistant.delta')
      ORDER BY seq DESC LIMIT 500`);
    let before = this.latestSequence(sessionId) + 1;
    const messages = new Map<string, { role: "user" | "assistant"; text: string }>();
    let characters = 0;
    for (;;) {
      const rows = statement.all(sessionId, before) as Array<{seq:number;event_type:string;payload_json:string}>;
      if (!rows.length) break;
      let finished = false;
      for (const row of rows) {
        before = row.seq;
        const event = JSON.parse(row.payload_json) as { messageId:string; text?:string; delta?:string };
        const previous = messages.get(event.messageId);
        if (!previous && (messages.size >= limit || characters >= 24_000)) { finished = true; break; }
        const role = row.event_type === "message.user" ? "user" as const : "assistant" as const;
        const fragment = (role === "user" ? event.text : event.delta) ?? "";
        const text = role === "user" ? fragment : fragment + (previous?.text ?? "");
        // A single oversized latest message retains its tail; total memory is
        // bounded even when that message spans many thousands of deltas.
        const retained = text.slice(-24_001);
        characters += retained.length - (previous?.text.length ?? 0);
        messages.set(event.messageId, { role, text: retained });
      }
      if (finished || rows.length < 500) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#disposed) throw new Error("Storage is closing");
    }
    return [...messages.values()].reverse();
  }

  /** Index at most `eventLimit` old events; callers may resume on the next idle/search turn. */
  backfillMessageSearch(eventLimit = 500): { processed: number; complete: boolean } {
    if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > 5_000) {
      throw new RangeError("eventLimit must be between 1 and 5000");
    }
    const state = this.statement(
      "SELECT last_session_id, last_seq, complete FROM message_search_backfill WHERE id = 1",
    ).get() as { last_session_id: string; last_seq: number; complete: number };
    if (state.complete) return { processed: 0, complete: true };
    const rows = this.statement(
      `SELECT session_id, seq, event_type, payload_json, created_at FROM events
       WHERE (session_id > ? OR (session_id = ? AND seq > ?))
       ORDER BY session_id, seq LIMIT ?`,
    ).all(state.last_session_id, state.last_session_id, state.last_seq, eventLimit) as Array<{
      session_id: string; seq: number; event_type: string; payload_json: string; created_at: string;
    }>;
    this.#database.transaction(() => {
      for (const row of rows) {
        this.indexSearchEvent(row.session_id, row.seq, row.event_type, row.payload_json, row.created_at);
      }
      const last = rows.at(-1);
      if (last) {
        this.statement(
          "UPDATE message_search_backfill SET last_session_id = ?, last_seq = ? WHERE id = 1",
        ).run(last.session_id, last.seq);
      }
      if (rows.length < eventLimit) {
        this.statement("UPDATE message_search_backfill SET complete = 1 WHERE id = 1").run();
      }
    })();
    return { processed: rows.length, complete: rows.length < eventLimit };
  }

  searchByContent(projectId: string, query: string): Array<{ sessionId: string; snippet: string }> {
    EntityIdSchema.parse(projectId);
    const trimmed = query.trim();
    if (!trimmed) return [];

    this.#scheduleBackfill();
    const escaped = trimmed.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    // Trigram FTS indexes literal substrings, including phrases spanning old
    // streaming fragments. Shorter queries use an escaped literal scan.
    const useFts = [...trimmed].length >= 3;
    const rows = useFts
      ? this.statement(`SELECT m.session_id,m.message_id,m.text FROM message_search_fts f
          JOIN message_search m ON m.rowid=f.rowid JOIN sessions s ON s.id=m.session_id
          WHERE message_search_fts MATCH ? AND s.project_id=? ORDER BY m.updated_at DESC LIMIT 500`)
          .all('"' + trimmed.replaceAll('"', '""') + '"', projectId) as Array<{session_id:string;message_id:string;text:string}>
      : this.statement(`SELECT m.session_id,m.message_id,m.text FROM message_search m
          JOIN sessions s ON s.id=m.session_id WHERE s.project_id=? AND m.text LIKE ? ESCAPE '\\'
          ORDER BY m.updated_at DESC LIMIT 500`)
          .all(projectId, `%${escaped}%`) as Array<{session_id:string;message_id:string;text:string}>;

    const resultMap = new Map<string, string>();
    const lowerQuery = trimmed.toLocaleLowerCase();

    for (const row of rows) {
      if (resultMap.has(row.session_id)) continue;
      const idx = row.text.toLocaleLowerCase().indexOf(lowerQuery);
      if (idx !== -1) {
        const start = Math.max(0, idx - 25);
        const end = Math.min(row.text.length, idx + trimmed.length + 35);
        const prefix = start > 0 ? "…" : "";
        const suffix = end < row.text.length ? "…" : "";
        const snippet = `${prefix}${row.text.slice(start, end).replaceAll("\n", " ").trim()}${suffix}`;
        resultMap.set(row.session_id, snippet);
      }
    }

    return Array.from(resultMap.entries()).map(([sessionId, snippet]) => ({
      sessionId,
      snippet,
    }));
  }

  private appendInsideTransaction(input: AppendEventInput, seq: number): StreamEnvelope {
    const sessionId = EntityIdSchema.parse(input.sessionId);
    const turnId = input.turnId === null ? null : EntityIdSchema.parse(input.turnId);
    const event = AgentEventSchema.parse(this.#blobs.externalize(sessionId, AgentEventSchema.parse(input.event)));
    const timestamp = IsoTimestampSchema.parse(input.timestamp);
    const payload = JSON.stringify(event);
    this.#insertEvent.run(
        sessionId,
        seq,
        turnId,
        event.type,
        payload,
        timestamp,
      );
    this.indexSearchEvent(sessionId, seq, event.type, payload, timestamp);

    const envelope = StreamEnvelopeSchema.parse({ seq, sessionId, turnId, event, timestamp });
    this.projectTimeline(envelope);
    return envelope;
  }

  private indexSearchEvent(sessionId: string, seq: number, eventType: string, payloadJson: string, timestamp: string): void {
    if (eventType !== "message.user" && eventType !== "message.assistant.delta") return;
    {
      const event = JSON.parse(payloadJson) as { messageId?: unknown; text?: unknown; delta?: unknown };
      if (typeof event.messageId !== "string") return;
      const role = eventType === "message.user" ? "user" : "assistant";
      const text = role === "user" ? event.text : event.delta;
      if (typeof text !== "string") return;
      let materialized = text;
      if (role === "assistant") {
        const existing = this.#existingMessage.get(sessionId, event.messageId) as { text: string; last_seq: number } | undefined;
        const inserted = this.#insertMessageFragment.run(sessionId, event.messageId, seq, text) as { changes: number };
        if (!inserted.changes && existing) return;
        materialized = existing && seq > existing.last_seq
          ? existing.text + text
          : (this.#messageFragments.all(sessionId, event.messageId) as Array<{ delta: string }>).map((fragment) => fragment.delta).join("");
      }
      const previous = this.#existingMessage.get(sessionId, event.messageId) as { last_seq: number } | undefined;
      this.#upsertMessage.run(sessionId, event.messageId, role, materialized, Math.max(seq, previous?.last_seq ?? 0), timestamp);
      this.#deleteFtsMessage.run(sessionId, event.messageId);
      this.#insertFtsMessage.run(materialized, sessionId, event.messageId);
    }
  }

  #scheduleBackfill(): void {
    if (this.#backfillScheduled || this.#disposed || !this.#database.open) return;
    this.#backfillScheduled = true;
    setImmediate(() => {
      this.#backfillScheduled = false;
      if (this.#disposed || !this.#database.open) return;
      try {
        const result = this.backfillMessageSearch(500);
        const timelineComplete = this.backfillTimeline();
        if (!result.complete || !timelineComplete) this.#scheduleBackfill();
      } catch {
        // The persisted cursor is committed only with the indexing chunk, so
        // the next process start can safely retry after a transient DB error.
      }
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
