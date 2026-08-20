import {
  AttachmentSchema,
  AttachmentStatusSchema,
  EntityIdSchema,
  FileSystemPathSchema,
  type Attachment,
  type AttachmentStatus,
  type ImageMimeType,
} from "../../../shared";
import type { SqliteDatabase } from "../database";
import { StorageCorruptionError } from "../errors";

type AttachmentRow = {
  id: string;
  session_id: string | null;
  turn_id: string | null;
  display_name: string;
  mime_type: ImageMimeType;
  size: number;
  sha256: string;
  storage_path: string;
  status: AttachmentStatus;
  created_at: string;
};

export type StoredAttachment = Attachment & {
  storagePath: string;
};

export type SaveAttachmentInput = Omit<
  StoredAttachment,
  "turnId" | "status"
> & {
  turnId?: string | null;
  status?: AttachmentStatus;
};

export class AttachmentRepository {
  constructor(private readonly database: SqliteDatabase) {}

  save(input: SaveAttachmentInput): void {
    const { storagePath: inputStoragePath, ...publicFields } = input;
    const attachment = AttachmentSchema.parse({
      ...publicFields,
      turnId: input.turnId ?? null,
      status: input.status ?? "staged",
    });
    const storagePath = FileSystemPathSchema.parse(inputStoragePath);

    this.database
      .prepare(
        `INSERT INTO attachments (
           id, session_id, turn_id, display_name, mime_type, size, sha256,
           storage_path, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attachment.id,
        attachment.sessionId,
        attachment.turnId,
        attachment.displayName,
        attachment.mimeType,
        attachment.size,
        attachment.sha256,
        storagePath,
        attachment.status,
        attachment.createdAt,
      );
  }

  find(id: string): StoredAttachment | null {
    const row = this.database
      .prepare(
        `SELECT id, session_id, turn_id, display_name, mime_type, size,
                sha256, storage_path, status, created_at
         FROM attachments WHERE id = ?`,
      )
      .get(id) as AttachmentRow | undefined;
    return row ? parseAttachment(row) : null;
  }

  listBySession(sessionId: string): StoredAttachment[] {
    EntityIdSchema.parse(sessionId);
    const rows = this.database
      .prepare(
        `SELECT id, session_id, turn_id, display_name, mime_type, size,
                sha256, storage_path, status, created_at
         FROM attachments
         WHERE session_id = ?
         ORDER BY created_at`,
      )
      .all(sessionId) as AttachmentRow[];
    return rows.map(parseAttachment);
  }

  markSent(id: string, sessionId: string, turnId: string): StoredAttachment {
    EntityIdSchema.parse(id);
    EntityIdSchema.parse(sessionId);
    EntityIdSchema.parse(turnId);
    const result = this.database
      .prepare(
        `UPDATE attachments
         SET session_id = ?, turn_id = ?, status = 'sent'
         WHERE id = ? AND status = 'staged'`,
      )
      .run(sessionId, turnId, id);
    if (result.changes !== 1) {
      throw new Error(`Attachment ${id} is missing or is no longer staged`);
    }
    const attachment = this.find(id);
    if (!attachment) throw new Error(`Attachment ${id} disappeared after update`);
    return attachment;
  }

  remove(id: string): void {
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
  }
}

function parseAttachment(row: AttachmentRow): StoredAttachment {
  try {
    return {
      ...AttachmentSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        displayName: row.display_name,
        mimeType: row.mime_type,
        size: row.size,
        sha256: row.sha256,
        status: AttachmentStatusSchema.parse(row.status),
        createdAt: row.created_at,
      }),
      storagePath: FileSystemPathSchema.parse(row.storage_path),
    };
  } catch (error) {
    throw new StorageCorruptionError("attachment", { cause: error });
  }
}
