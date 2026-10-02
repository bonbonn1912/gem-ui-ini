import type { SqliteDatabase } from "../database";
import type { StreamEnvelope } from "../../../shared";

/** A renderer-ready timeline row. Kept as JSON at the storage boundary so the
 * main process does not depend on renderer modules. */
export type MaterializedTimelineItem = {
  id: string;
  kind: "message" | "thought" | "tool" | "permission" | "notice" | "plan";
  turnId: string | null;
  timestamp: string;
  seq: number;
  [key: string]: unknown;
};

export type TimelinePageCursor = { seq: number; itemId: string };
export type TimelineSnapshotPage = {
  throughSeq: number;
  items: MaterializedTimelineItem[];
  nextBefore: TimelinePageCursor | null;
  hasMore: boolean;
  state: TimelineSnapshotState;
};

export type TimelineSnapshotState = {
  phase: "idle" | "running" | "awaiting_permission" | "cancelling" | "error" | "disconnected";
  activeTurnId: string | null;
  usage: unknown | null;
  modes: string[];
  models: string[];
  currentModeId: string | null;
  configOptions: unknown[];
  capabilities: { images: boolean };
  commands: Array<{ name: string; description?: string | null }>;
  sessionInfo: { title?: string | null; updatedAt?: string | null };
  error: string | null;
  providerSessions: Array<{ providerSessionId: string; startedAt: string; transferredContext: boolean }>;
};

type VersionRow = {
  item_id: string;
  valid_from_seq: number;
  order_seq: number;
  last_seq: number;
  kind: MaterializedTimelineItem["kind"];
  payload_json: string;
};
type CurrentItem = { row: VersionRow; item: MaterializedTimelineItem };

const MAX_PAGE_ITEMS = 200;

/**
 * Incremental timeline projection. Text deltas live in a separate append-only
 * table so each stream update does not copy the whole accumulated message into
 * another SQLite version row. Metadata versions are retained so older pages
 * can be read at the subscription's fixed watermark while streaming continues.
 */
export class TimelineSnapshotRepository {
  readonly #database: SqliteDatabase;
  readonly #statements = new Map<string, { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] }>();
  private statement(sql: string) {
    let value = this.#statements.get(sql);
    if (!value) {
      value = this.#database.prepare(sql) as unknown as NonNullable<typeof value>;
      this.#statements.set(sql, value);
    }
    return value;
  }

  constructor(database: SqliteDatabase) {
    this.#database = database;
  }

  apply(envelope: StreamEnvelope): void {
    const { event } = envelope;
    const current = (itemId: string): CurrentItem | undefined => {
      const row = this.statement(
        `SELECT item_id, valid_from_seq, order_seq, last_seq, kind, payload_json
         FROM timeline_item_versions WHERE session_id = ? AND item_id = ? AND valid_to_seq IS NULL`,
      ).get(envelope.sessionId, itemId) as VersionRow | undefined;
      return row ? { row, item: JSON.parse(row.payload_json) as MaterializedTimelineItem } : undefined;
    };
    const text = (itemId: string, value: string) => {
      this.statement(
        `INSERT OR IGNORE INTO timeline_item_fragments(session_id,item_id,seq,text)
         VALUES (?,?,?,?)`,
      ).run(envelope.sessionId, itemId, envelope.seq, value);
    };
    const put = (item: MaterializedTimelineItem, orderSeq = envelope.seq) => {
      const payload: MaterializedTimelineItem = { ...item, seq: envelope.seq };
      // The actual text is represented by immutable fragments, never repeated
      // in each metadata version as an assistant/thought stream grows.
      if (payload.kind === "message" || payload.kind === "thought") payload.text = "";
      const previous = this.statement(
        `SELECT order_seq FROM timeline_item_versions
         WHERE session_id=? AND item_id=? AND valid_to_seq IS NULL`,
      ).get(envelope.sessionId, item.id) as { order_seq: number } | undefined;
      this.statement(
        `UPDATE timeline_item_versions SET valid_to_seq = ?
         WHERE session_id = ? AND item_id = ? AND valid_to_seq IS NULL`,
      ).run(envelope.seq, envelope.sessionId, item.id);
      this.statement(
        `INSERT INTO timeline_item_versions
         (session_id,item_id,valid_from_seq,valid_to_seq,order_seq,last_seq,kind,payload_json)
         VALUES (?,?,?,NULL,?,?,?,?)`,
      ).run(envelope.sessionId, item.id, envelope.seq, previous?.order_seq ?? orderSeq, envelope.seq, item.kind, JSON.stringify(payload));
    };
    const base = { turnId: envelope.turnId, timestamp: envelope.timestamp };
    const eventText = (value: unknown): string => typeof value === "string" ? value : "";

    switch (event.type) {
      case "message.user": {
        const id = `user:${event.messageId}`;
        const item: MaterializedTimelineItem = {
          id, kind: "message", role: "user", text: "", ...base,
          attachments: event.attachmentIds.map((attachmentId, index) => ({ id: attachmentId, name: `Bild ${index + 1}` })),
          contextAttachments: event.contextAttachments,
          projectFiles: event.projectFiles,
          externalContexts: event.externalContexts,
          seq: envelope.seq,
        };
        text(id, eventText(event.text));
        put(item);
        break;
      }
      case "message.assistant.delta":
      case "message.thought.delta": {
        const kind = event.type === "message.thought.delta" ? "thought" : "message";
        const id = `${kind === "thought" ? "thought" : "assistant"}:${event.messageId}`;
        const previous = current(id);
        const item: MaterializedTimelineItem = previous?.item ?? {
          id, kind, ...(kind === "message" ? { role: "assistant" } : {}), text: "",
          ...(kind === "message" ? { attachments: [], contextAttachments: [], projectFiles: [] } : { streaming: true }),
          ...base, seq: envelope.seq,
        };
        text(id, eventText(event.delta));
        put({ ...item, contentBlocks: [...(Array.isArray(item.contentBlocks) ? item.contentBlocks : []), ...(event.contentBlocks ?? [])], streaming: true, timestamp: item.timestamp, turnId: item.turnId }, previous?.row.order_seq ?? envelope.seq);
        break;
      }
      case "tool.started":
      case "tool.updated":
      case "tool.completed":
      case "tool.failed": {
        const id = `tool:${event.toolCallId}`;
        const previous = current(id);
        const status = event.type === "tool.completed" ? "completed" : event.type === "tool.failed" ? "failed" : "running";
        const payload = event as unknown as Record<string, unknown>;
        const item: MaterializedTimelineItem = {
          ...(previous?.item ?? { id, kind: "tool", toolCallId: event.toolCallId, title: "Werkzeug", ...base }),
          status,
          title: payload.title ?? previous?.item.title ?? "Werkzeug",
          toolKind: payload.kind ?? previous?.item.toolKind,
          input: payload.input ?? payload.rawInput ?? payload.arguments ?? previous?.item.input,
          output: payload.output ?? payload.rawOutput ?? payload.result ?? payload.update ?? payload.content ?? previous?.item.output,
          content: payload.content ?? previous?.item.content,
          rawInput: payload.rawInput ?? previous?.item.rawInput,
          rawOutput: payload.rawOutput ?? previous?.item.rawOutput,
          diff: payload.diff ?? previous?.item.diff,
          locations: payload.locations ?? previous?.item.locations,
          error: payload.error && typeof payload.error === "object" ? (payload.error as {message?:string}).message : previous?.item.error,
          seq: envelope.seq,
        };
        put(item, previous?.row.order_seq ?? envelope.seq);
        break;
      }
      case "permission.requested":
        put({ id: `permission:${event.requestId}`, kind: "permission", requestId: event.requestId,
          toolCallId: event.toolCallId, title: event.title, options: event.options, status: "pending", ...base, seq: envelope.seq });
        break;
      case "permission.resolved": {
        const id = `permission:${event.requestId}`;
        const previous = current(id);
        if (previous) {
          const options = Array.isArray(previous.item.options) ? previous.item.options as Array<{ optionId: string; kind?: string | null }> : [];
          const selected = options.find((option) => option.optionId === event.optionId);
          put({ ...previous.item, status: selected?.kind?.startsWith("allow") ? "allowed" : "rejected", selectedOptionId: event.optionId }, previous.row.order_seq);
        }
        break;
      }
      case "usage.updated": {
        const lastTurn = event.snapshot.lastTurn;
        if (lastTurn) {
          const rows = this.statement(
            `SELECT item_id,valid_from_seq,order_seq,last_seq,kind,payload_json FROM timeline_item_versions
             WHERE session_id=? AND valid_to_seq IS NULL AND kind='message'
               AND json_extract(payload_json,'$.role')='assistant'
               AND (json_extract(payload_json,'$.turnId')=? OR
                 (json_extract(payload_json,'$.turnId') IS NULL AND json_extract(payload_json,'$.turnUsage') IS NULL))`,
          ).all(envelope.sessionId, lastTurn.turnId) as VersionRow[];
          for (const row of rows) {
            const item = JSON.parse(row.payload_json) as MaterializedTimelineItem & { role?: string };
            put({ ...item, model: lastTurn.byModel[0]?.model ?? item.model,
              turnUsage: { tokens: lastTurn.tokens, byModel: lastTurn.byModel } }, row.order_seq);
          }
        }
        break;
      }
      case "turn.completed":
      case "turn.cancelled": {
        const rows = this.statement(
          `SELECT item_id,valid_from_seq,order_seq,last_seq,kind,payload_json FROM timeline_item_versions
           WHERE session_id=? AND valid_to_seq IS NULL AND json_extract(payload_json, '$.turnId') = ?`,
        ).all(envelope.sessionId, envelope.turnId) as VersionRow[];
        for (const row of rows) {
          const item = JSON.parse(row.payload_json) as MaterializedTimelineItem;
          if (item.kind === "message" && item.role === "assistant" && item.streaming || item.kind === "thought" && item.streaming) {
            put({ ...item, streaming: false }, row.order_seq);
          }
        }
        if (event.type === "turn.cancelled") put({ id: `cancelled:${envelope.seq}`, kind: "notice", tone: "neutral", text: event.reason ?? "Antwort wurde gestoppt.", ...base, seq: envelope.seq });
        break;
      }
      case "turn.failed":
        {
          const rows = this.statement(
            `SELECT item_id,valid_from_seq,order_seq,last_seq,kind,payload_json FROM timeline_item_versions
             WHERE session_id=? AND valid_to_seq IS NULL AND json_extract(payload_json, '$.turnId') = ?`,
          ).all(envelope.sessionId, envelope.turnId) as VersionRow[];
          for (const row of rows) {
            const item = JSON.parse(row.payload_json) as MaterializedTimelineItem;
            if ((item.kind === "message" && item.role === "assistant" || item.kind === "thought") && item.streaming) {
              put({ ...item, streaming: false }, row.order_seq);
            }
          }
          const detail = event.error.details ? JSON.stringify(event.error.details, null, 2) : undefined;
          const afterAnswer = event.severity === "warning";
          put({ id: `failed:${envelope.seq}`, kind: "notice", tone: afterAnswer ? "warning" : "error",
            text: afterAnswer
              ? `Gemini hat den Turn mit einer Fehlermeldung abgeschlossen; die Antwort oben ist vollständig angekommen. ${event.error.message}`
              : event.error.message,
            ...(detail ? { detail } : {}), ...base, seq: envelope.seq });
        }
        break;
      case "process.disconnected":
        put({ id: `disconnected:${envelope.seq}`, kind: "notice", tone: "error", text: event.reason || "Die Verbindung zu Gemini CLI wurde getrennt.", detail: event.reason, ...base, seq: envelope.seq });
        break;
      case "plan.updated":
        put({ id: `plan:${(event.plan as { id?: string; planId?: string })?.planId ?? (event.plan as { id?: string })?.id ?? envelope.turnId ?? envelope.seq}`, kind: "plan", plan: event.plan, planId: ((event.plan as { id?: string; planId?: string })?.planId ?? (event.plan as { id?: string })?.id ?? null), ...base, seq: envelope.seq });
        break;
      case "plan.removed": {
        const id = `plan:${event.planId}`;
        const previous = current(id);
        if (previous) put({ ...previous.item, removed: true }, previous.row.order_seq);
        break;
      }
      default:
        break;
    }
  }

  page(input: { sessionId: string; throughSeq: number; before?: TimelinePageCursor | null; limit?: number }): TimelineSnapshotPage {
    const { sessionId, throughSeq } = input;
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) throw new RangeError("throughSeq must be non-negative");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_ITEMS) throw new RangeError(`limit must be between 1 and ${MAX_PAGE_ITEMS}`);
    const before = input.before;
        const beforeSql = before ? "AND (order_seq < ? OR (order_seq = ? AND item_id < ?))" : "";
    const params: Array<string | number> = [sessionId, throughSeq, throughSeq];
    if (before) params.push(before.seq, before.seq, before.itemId);
    params.push(limit + 1);
    const rows = this.statement(
      `SELECT item_id, valid_from_seq, order_seq, last_seq, kind, payload_json
       FROM timeline_item_versions
       WHERE session_id=? AND valid_from_seq<=? AND (valid_to_seq IS NULL OR valid_to_seq>?)
         AND COALESCE(json_extract(payload_json,'$.removed'),0)=0 ${beforeSql}
       ORDER BY order_seq DESC,item_id DESC LIMIT ?`,
    ).all(...params) as VersionRow[];
    const fragmentRows = this.statement(
      `SELECT text FROM timeline_item_fragments WHERE session_id=? AND item_id=? AND seq<=? ORDER BY seq`,
    );
    const items: MaterializedTimelineItem[] = [];
    let bytes = 0;
    for (const row of rows.slice(0,limit)) {
      const item = JSON.parse(row.payload_json) as MaterializedTimelineItem;
      item.orderSeq = row.order_seq;
      if (item.kind === "message" || item.kind === "thought") {
        const fragments = fragmentRows.all(sessionId,row.item_id,throughSeq) as Array<{text:string}>;
        item.text = fragments.map((fragment) => fragment.text).join("");
      }
      const size = Buffer.byteLength(JSON.stringify(item),"utf8");
      if (items.length && bytes + size > 2 * 1024 * 1024) break;
      items.push(item); bytes += size;
    }
    const hasMore = rows.length > items.length;
    const oldest = rows[items.length - 1];
    items.reverse();
    return {
      throughSeq,
      items,
      nextBefore: hasMore && oldest ? { seq: oldest.order_seq, itemId: oldest.item_id } : null,
      hasMore,
      state: this.state(sessionId, throughSeq),
    };
  }

  state(sessionId: string, throughSeq: number): TimelineSnapshotState {
    const latest = (types: string[]) => {
      const placeholders = types.map(() => "?").join(",");
      return this.statement(
        `SELECT seq,turn_id,event_type,payload_json,created_at FROM events
         WHERE session_id=? AND seq<=? AND event_type IN (${placeholders})
         ORDER BY seq DESC LIMIT 1`,
      ).get(sessionId, throughSeq, ...types) as {
        seq: number; turn_id: string | null; event_type: string; payload_json: string; created_at: string;
      } | undefined;
    };
    const decode = (row: ReturnType<typeof latest>) => row ? JSON.parse(row.payload_json) as Record<string, unknown> : undefined;
    const readyRow = latest(["session.ready"]);
    const ready = decode(readyRow);
    const modeRow = latest(["mode.updated"]);
    const mode = decode(modeRow);
    const configRow = latest(["config.updated"]);
    const config = decode(configRow);
    const commands = decode(latest(["commands.updated"]));
    const info = decode(latest(["session.info.updated"]));
    const usageRow = latest(["usage.updated"]);
    let usage: unknown | null = null;
    if (usageRow) {
      try {
        const parsed = JSON.parse(usageRow.payload_json) as Record<string, unknown>;
        usage = parsed.snapshot ?? parsed;
      } catch { /* Corrupt event replay remains responsible for reporting the row. */ }
    }

    const lifecycle = latest([
      "session.started", "session.ready", "message.user", "turn.completed",
      "turn.cancelled", "turn.failed", "process.disconnected",
    ]);
    let phase: TimelineSnapshotState["phase"] = "idle";
    let activeTurnId: string | null = null;
    let error: string | null = null;
    if (lifecycle) {
      const payload = decode(lifecycle) ?? {};
      switch (lifecycle.event_type) {
        case "session.started":
        case "message.user":
          phase = "running";
          activeTurnId = lifecycle.turn_id;
          break;
        case "turn.failed": {
          const detail = payload.error as { message?: unknown } | undefined;
          error = typeof detail?.message === "string" ? detail.message : "Der Turn ist fehlgeschlagen.";
          phase = payload.severity === "warning" ? "idle" : "error";
          break;
        }
        case "process.disconnected":
          phase = "disconnected";
          error = typeof payload.reason === "string" ? payload.reason : "Die Verbindung zu Gemini CLI wurde getrennt.";
          break;
        default:
          phase = "idle";
      }
    }

    const sessionEventRows = this.statement(
      `SELECT seq,created_at,payload_json FROM events
       WHERE session_id=? AND seq<=? AND event_type IN ('session.started','session.ready')
       ORDER BY seq DESC LIMIT 100`,
    ).all(sessionId, throughSeq) as Array<{ seq: number; created_at: string; payload_json: string }>;
    const priorUserSeq = (seq: number) => (this.statement(
      "SELECT 1 AS found FROM events WHERE session_id=? AND seq<? AND event_type='message.user' LIMIT 1",
    ).get(sessionId, seq) as { found: number } | undefined) !== undefined;
    const providerSessions = sessionEventRows.reverse().flatMap((row, index) => {
      const payload = JSON.parse(row.payload_json) as { providerSessionId?: unknown };
      if (typeof payload.providerSessionId !== "string" || !payload.providerSessionId) return [];
      return [{
        providerSessionId: payload.providerSessionId,
        startedAt: row.created_at,
        transferredContext: index > 0 || priorUserSeq(row.seq),
      }];
    }).filter((entry, index, entries) => entries.findIndex((candidate) => candidate.providerSessionId === entry.providerSessionId) === index);

    return {
      phase,
      activeTurnId,
      usage,
      modes: Array.isArray(ready?.modes) ? ready.modes.filter((value): value is string => typeof value === "string") : [],
      models: Array.isArray(ready?.models) ? ready.models.filter((value): value is string => typeof value === "string") : [],
      currentModeId: (modeRow?.seq ?? 0) > (readyRow?.seq ?? 0) && typeof mode?.currentModeId === "string" ? mode.currentModeId : typeof ready?.currentModeId === "string" ? ready.currentModeId : null,
      configOptions: (configRow?.seq ?? 0) > (readyRow?.seq ?? 0) && Array.isArray(config?.configOptions)
        ? config.configOptions : Array.isArray(ready?.configOptions) ? ready.configOptions : [],
      capabilities: { images: (ready?.capabilities as {images?:boolean} | undefined)?.images === true },
      commands: Array.isArray(commands?.commands) ? commands.commands as TimelineSnapshotState["commands"] : [],
      sessionInfo: {
        ...(typeof info?.title === "string" || info?.title === null ? { title: info.title as string | null } : {}),
        ...(typeof info?.updatedAt === "string" || info?.updatedAt === null ? { updatedAt: info.updatedAt as string | null } : {}),
      },
      error,
      providerSessions,
    };
  }
}
