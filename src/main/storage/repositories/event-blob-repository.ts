import { createHash } from "node:crypto";

import { JsonValueSchema, type AgentEvent, type JsonValue } from "../../../shared";
import type { SqliteDatabase } from "../database";

const EXTERNALIZE_AT_BYTES = 64 * 1024;
const LARGE_MEDIA_MIME = /^(?:image|audio|video)\//i;
const EXTERNAL_FIELDS = new Set([
  "rawInput", "rawOutput", "arguments", "result", "update", "content", "contentBlocks",
]);

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonTextMedia(value: JsonValue): boolean {
  if (!isRecord(value)) return false;
  const mime = value.mimeType ?? value.mime_type ?? value.type;
  const mimeText = typeof mime === "string" ? mime : "";
  if (LARGE_MEDIA_MIME.test(mimeText)) return true;
  // ACP content blocks commonly carry encoded image/audio bytes in `data`.
  return (mimeText === "image" || mimeText === "audio") && typeof value.data === "string";
}

function utf8Bytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Stores large event payloads separately while leaving compact text deltas inline. */
export class EventBlobRepository {
  readonly #database: SqliteDatabase;
  readonly #insert: { run(id: string, sessionId: string, payload: string): unknown };

  constructor(database: SqliteDatabase) {
    this.#database = database;
    this.#insert = database.prepare(
      "INSERT OR IGNORE INTO event_blobs(id, session_id, payload_json) VALUES (?, ?, ?)",
    );
  }

  externalize(sessionId: string, event: AgentEvent): AgentEvent {
    const parsed = JSON.parse(JSON.stringify(event)) as Record<string, JsonValue>;
    let changed = false;
    for (const [field, value] of Object.entries(parsed)) {
      if (!EXTERNAL_FIELDS.has(field) || value === null) continue;
      if (Array.isArray(value)) {
        const blocks = value.map((block) => {
          const bytes = utf8Bytes(block);
          if (bytes <= EXTERNALIZE_AT_BYTES && !isNonTextMedia(block)) return block;
          changed = true;
          return this.#store(sessionId, block, bytes);
        });
        if (blocks.some((block, index) => block !== value[index])) parsed[field] = blocks;
      } else {
        const bytes = utf8Bytes(value);
        if (bytes > EXTERNALIZE_AT_BYTES || isNonTextMedia(value)) {
          parsed[field] = this.#store(sessionId, value, bytes);
          changed = true;
        }
      }
    }
    return (changed ? parsed : event) as AgentEvent;
  }

  get(sessionId: string, id: string): JsonValue | null {
    const row = this.#database.prepare(
      "SELECT payload_json FROM event_blobs WHERE session_id = ? AND id = ?",
    ).get(sessionId, id) as { payload_json: string } | undefined;
    if (!row) return null;
    return JsonValueSchema.parse(JSON.parse(row.payload_json));
  }

  #store(sessionId: string, payload: JsonValue, bytes: number): JsonValue {
    const payloadJson = JSON.stringify(payload);
    const digest = createHash("sha256").update(sessionId).update("\0").update(payloadJson).digest("hex");
    const id = digest;
    this.#insert.run(id, sessionId, payloadJson);
    return { $blob: id, bytes };
  }
}
