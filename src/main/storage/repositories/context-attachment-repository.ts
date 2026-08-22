import {
  ContextAttachmentListSchema,
  ContextAttachmentOriginSchema,
  ContextAttachmentSchema,
  MAX_CONTEXT_ATTACHMENTS_PER_SCOPE,
  MAX_CONTEXT_CHARS_PER_ATTACHMENT,
  MAX_CONTEXT_CHARS_TOTAL,
  type ContextAttachment,
  type ContextAttachmentKind,
  type ContextAttachmentList,
  type ContextAttachmentOrigin,
  type ContextAttachmentScope,
  type ExtractionState,
  type LinkPreviewState,
} from "../../../shared";
import type { SqliteDatabase } from "../database";
import { StorageNotFoundError } from "../errors";

type ContextAttachmentRow = {
  id: string;
  project_id: string;
  scope: ContextAttachmentScope;
  session_id: string | null;
  session_key: string;
  kind: ContextAttachmentKind;
  origin: string | null;
  title: string;
  note: string | null;
  dedupe_key: string;
  sort_order: number;
  default_include: number;
  created_at: string;
  updated_at: string;
  effective_included: number;
  display_name: string | null;
  mime_type: string | null;
  file_size: number | null;
  sha256: string | null;
  storage_dir: string | null;
  file_name: string | null;
  extraction_state: ExtractionState | null;
  extracted_chars: number | null;
  page_count: number | null;
  extraction_error: string | null;
  url: string | null;
  host: string | null;
  preview_state: LinkPreviewState | null;
  preview_title: string | null;
  preview_description: string | null;
  preview_site_name: string | null;
  preview_image_file: string | null;
  preview_error: string | null;
  fetched_at: string | null;
};

export type StoredContextAttachment = ContextAttachment & {
  dedupeKey: string;
  defaultInclude: boolean;
  sessionKey: string;
  internalFile: {
    storageDir: string;
    fileName: string;
  } | null;
  internalLink: {
    previewImageFile: string | null;
  } | null;
};

type FileInsert = {
  id: string;
  projectId: string;
  scope: ContextAttachmentScope;
  sessionId: string | null;
  title: string;
  origin?: ContextAttachmentOrigin;
  displayName: string;
  mimeType: string;
  size: number;
  sha256: string;
  storageDir: string;
  fileName: string;
  defaultInclude: boolean;
  createdAt: string;
};

type LinkInsert = {
  id: string;
  projectId: string;
  scope: ContextAttachmentScope;
  sessionId: string | null;
  title: string;
  origin?: ContextAttachmentOrigin;
  url: string;
  normalizedUrl: string;
  host: string;
  defaultInclude: boolean;
  createdAt: string;
};

const SELECT_COLUMNS = `
  SELECT a.id, a.project_id, a.scope, a.session_id, a.session_key,
         a.kind, a.origin, a.title, a.note, a.dedupe_key, a.sort_order,
         a.default_include, a.created_at, a.updated_at,
         COALESCE(sel.included, a.default_include) AS effective_included,
         f.display_name, f.mime_type, f.size AS file_size, f.sha256,
         f.storage_dir, f.file_name, f.extraction_state, f.extracted_chars,
         f.page_count, f.extraction_error,
         l.url, l.host, l.preview_state, l.preview_title,
         l.preview_description, l.preview_site_name, l.preview_image_file,
         l.preview_error, l.fetched_at
  FROM context_attachments a
  LEFT JOIN context_attachment_files f ON f.attachment_id = a.id
  LEFT JOIN context_attachment_links l ON l.attachment_id = a.id
  LEFT JOIN context_attachment_selections sel
    ON sel.attachment_id = a.id AND sel.session_id = ?`;

export class ContextAttachmentRepository {
  constructor(private readonly database: SqliteDatabase) {}

  list(projectId: string, sessionId: string | null): ContextAttachmentList {
    const rows = this.database.prepare(
      `${SELECT_COLUMNS}
       WHERE a.project_id = ?
         AND (a.scope = 'project' OR (? IS NOT NULL AND a.session_id = ?))
       ORDER BY CASE a.scope WHEN 'project' THEN 0 ELSE 1 END, a.sort_order, a.created_at`,
    ).all(sessionId, projectId, sessionId, sessionId) as ContextAttachmentRow[];
    const attachments = rows.map(parseStoredAttachment);
    const projectAttachments = attachments
      .filter((attachment) => attachment.scope === "project")
      .slice(0, MAX_CONTEXT_ATTACHMENTS_PER_SCOPE)
      .map(toPublicAttachment);
    const sessionAttachments = attachments
      .filter((attachment) => attachment.scope === "session")
      .slice(0, MAX_CONTEXT_ATTACHMENTS_PER_SCOPE)
      .map(toPublicAttachment);
    const included = attachments.filter((attachment) => attachment.includedInContext);
    const estimatedTotalTokens = included.reduce(
      (total, attachment) => total + (attachment.estimatedTokens ?? 0),
      0,
    );
    const estimatedChars = included.reduce(
      (total, attachment) => total + estimatedContextChars(attachment),
      0,
    );
    return ContextAttachmentListSchema.parse({
      projectId,
      sessionId,
      projectAttachments,
      sessionAttachments,
      includedCount: included.length,
      estimatedTotalTokens,
      overBudget: estimatedChars > MAX_CONTEXT_CHARS_TOTAL,
    });
  }

  getInternal(attachmentId: string, sessionId: string | null = null): StoredContextAttachment {
    const row = this.database.prepare(
      `${SELECT_COLUMNS} WHERE a.id = ?`,
    ).get(sessionId, attachmentId) as ContextAttachmentRow | undefined;
    if (!row) throw new StorageNotFoundError("Context attachment", attachmentId);
    return parseStoredAttachment(row);
  }

  /**
   * Reads a hand-picked set of attachments, preserving the order of the given
   * ids rather than the storage order. Ids that no longer exist are skipped, so
   * a caller holding a stale list degrades to a shorter one instead of failing.
   */
  listByIds(
    attachmentIds: readonly string[],
    sessionId: string | null = null,
  ): ContextAttachment[] {
    if (attachmentIds.length === 0) return [];
    const placeholders = attachmentIds.map(() => "?").join(", ");
    const rows = this.database.prepare(
      `${SELECT_COLUMNS} WHERE a.id IN (${placeholders})`,
    ).all(sessionId, ...attachmentIds) as ContextAttachmentRow[];
    const byId = new Map(
      rows.map((row) => {
        const attachment = parseStoredAttachment(row);
        return [attachment.id, toPublicAttachment(attachment)];
      }),
    );
    return attachmentIds
      .map((id) => byId.get(id))
      .filter((attachment): attachment is ContextAttachment => attachment !== undefined);
  }

  findDuplicate(
    projectId: string,
    sessionId: string | null,
    dedupeKey: string,
  ): StoredContextAttachment | null {
    const row = this.database.prepare(
      `${SELECT_COLUMNS}
       WHERE a.project_id = ? AND a.session_key = ? AND a.dedupe_key = ?`,
    ).get(sessionId, projectId, sessionId ?? "-", dedupeKey) as
      | ContextAttachmentRow
      | undefined;
    return row ? parseStoredAttachment(row) : null;
  }

  insertFile(input: FileInsert): StoredContextAttachment {
    this.assertScopeCapacity(input.projectId, input.sessionId);
    const sessionKey = input.sessionId ?? "-";
    const sortOrder = this.nextSortOrder(input.projectId, sessionKey);
    this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO context_attachments (
           id, project_id, scope, session_id, session_key, kind, origin, title, note,
           dedupe_key, sort_order, default_include, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'file', ?, ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.projectId,
        input.scope,
        input.sessionId,
        sessionKey,
        input.origin ?? "manual",
        input.title,
        input.sha256,
        sortOrder,
        input.defaultInclude ? 1 : 0,
        input.createdAt,
        input.createdAt,
      );
      this.database.prepare(
        `INSERT INTO context_attachment_files (
           attachment_id, display_name, mime_type, size, sha256,
           storage_dir, file_name, extraction_state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(
        input.id,
        input.displayName,
        input.mimeType,
        input.size,
        input.sha256,
        input.storageDir,
        input.fileName,
      );
      if (input.sessionId) this.writeSelection(input.sessionId, input.id, input.defaultInclude, input.createdAt);
    })();
    return this.getInternal(input.id, input.sessionId);
  }

  insertLink(input: LinkInsert): StoredContextAttachment {
    this.assertScopeCapacity(input.projectId, input.sessionId);
    const sessionKey = input.sessionId ?? "-";
    const sortOrder = this.nextSortOrder(input.projectId, sessionKey);
    this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO context_attachments (
           id, project_id, scope, session_id, session_key, kind, origin, title, note,
           dedupe_key, sort_order, default_include, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'link', ?, ?, NULL, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.projectId,
        input.scope,
        input.sessionId,
        sessionKey,
        input.origin ?? "manual",
        input.title,
        input.normalizedUrl,
        sortOrder,
        input.defaultInclude ? 1 : 0,
        input.createdAt,
        input.createdAt,
      );
      this.database.prepare(
        `INSERT INTO context_attachment_links (
           attachment_id, url, host, preview_state
         ) VALUES (?, ?, ?, 'pending')`,
      ).run(input.id, input.url, input.host);
      if (input.sessionId) this.writeSelection(input.sessionId, input.id, input.defaultInclude, input.createdAt);
    })();
    return this.getInternal(input.id, input.sessionId);
  }

  update(input: {
    attachmentId: string;
    title?: string;
    note?: string | null;
    scope?: ContextAttachmentScope;
    sessionId?: string | null;
    sortOrder?: number;
    updatedAt: string;
  }): StoredContextAttachment {
    const existing = this.getInternal(input.attachmentId);
    const scope = input.scope ?? existing.scope;
    const sessionId = input.sessionId === undefined ? existing.sessionId : input.sessionId;
    if ((scope === "project") !== (sessionId === null)) {
      throw new TypeError("Attachment scope must match sessionId");
    }
    this.database.prepare(
      `UPDATE context_attachments
       SET title = ?, note = ?, scope = ?, session_id = ?, session_key = ?,
           sort_order = ?, default_include = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.title ?? existing.title,
      input.note === undefined ? existing.note : input.note,
      scope,
      sessionId,
      sessionId ?? "-",
      input.sortOrder ?? existing.sortOrder,
      scope === "session" ? 1 : 0,
      input.updatedAt,
      input.attachmentId,
    );
    if (sessionId && sessionId !== existing.sessionId) {
      this.writeSelection(sessionId, input.attachmentId, true, input.updatedAt);
    }
    return this.getInternal(input.attachmentId, sessionId);
  }

  setInclusion(
    sessionId: string,
    attachmentIds: readonly string[],
    included: boolean,
    updatedAt: string,
  ): void {
    this.database.transaction(() => {
      for (const attachmentId of attachmentIds) {
        this.writeSelection(sessionId, attachmentId, included, updatedAt);
      }
    })();
  }

  updateExtraction(input: {
    attachmentId: string;
    state: ExtractionState;
    extractedChars?: number | null;
    pageCount?: number | null;
    error?: string | null;
  }): void {
    const result = this.database.prepare(
      `UPDATE context_attachment_files
       SET extraction_state = ?, extracted_chars = ?, page_count = ?, extraction_error = ?
       WHERE attachment_id = ?`,
    ).run(
      input.state,
      input.extractedChars ?? null,
      input.pageCount ?? null,
      input.error?.slice(0, 500) ?? null,
      input.attachmentId,
    );
    if (result.changes !== 1) throw new StorageNotFoundError("Context attachment file", input.attachmentId);
  }

  updateLinkPreview(input: {
    attachmentId: string;
    state: LinkPreviewState;
    title?: string | null;
    description?: string | null;
    siteName?: string | null;
    imageFile?: string | null;
    error?: string | null;
    fetchedAt?: string | null;
  }): void {
    const result = this.database.prepare(
      `UPDATE context_attachment_links
       SET preview_state = ?, preview_title = ?, preview_description = ?,
           preview_site_name = ?, preview_image_file = ?, preview_error = ?, fetched_at = ?
       WHERE attachment_id = ?`,
    ).run(
      input.state,
      input.title?.slice(0, 300) ?? null,
      input.description?.slice(0, 1_000) ?? null,
      input.siteName?.slice(0, 200) ?? null,
      input.imageFile ?? null,
      input.error?.slice(0, 500) ?? null,
      input.fetchedAt ?? null,
      input.attachmentId,
    );
    if (result.changes !== 1) throw new StorageNotFoundError("Context attachment link", input.attachmentId);
  }

  remove(attachmentId: string): StoredContextAttachment {
    const existing = this.getInternal(attachmentId);
    this.database.prepare("DELETE FROM context_attachments WHERE id = ?").run(attachmentId);
    return existing;
  }

  listForSessionDeletion(sessionId: string): StoredContextAttachment[] {
    const rows = this.database.prepare(
      `${SELECT_COLUMNS} WHERE a.session_id = ?`,
    ).all(sessionId, sessionId) as ContextAttachmentRow[];
    return rows.map(parseStoredAttachment);
  }

  listForProjectDeletion(projectId: string): StoredContextAttachment[] {
    const rows = this.database.prepare(
      `${SELECT_COLUMNS} WHERE a.project_id = ?`,
    ).all(null, projectId) as ContextAttachmentRow[];
    return rows.map(parseStoredAttachment);
  }

  countFileReferences(sha256: string): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM context_attachment_files WHERE sha256 = ?",
    ).get(sha256) as { count: number };
    return row.count;
  }

  referencedHashes(): Set<string> {
    const rows = this.database.prepare(
      "SELECT DISTINCT sha256 FROM context_attachment_files",
    ).all() as Array<{ sha256: string }>;
    return new Set(rows.map((row) => row.sha256));
  }

  private nextSortOrder(projectId: string, sessionKey: string): number {
    const row = this.database.prepare(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS value
       FROM context_attachments WHERE project_id = ? AND session_key = ?`,
    ).get(projectId, sessionKey) as { value: number };
    return row.value;
  }

  private assertScopeCapacity(projectId: string, sessionId: string | null): void {
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count FROM context_attachments
       WHERE project_id = ? AND session_key = ?`,
    ).get(projectId, sessionId ?? "-") as { count: number };
    if (row.count >= MAX_CONTEXT_ATTACHMENTS_PER_SCOPE) {
      throw new Error(`Pro Bereich sind höchstens ${MAX_CONTEXT_ATTACHMENTS_PER_SCOPE} Anhänge möglich.`);
    }
  }

  private writeSelection(
    sessionId: string,
    attachmentId: string,
    included: boolean,
    updatedAt: string,
  ): void {
    this.database.prepare(
      `INSERT INTO context_attachment_selections (session_id, attachment_id, included, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, attachment_id) DO UPDATE SET
         included = excluded.included, updated_at = excluded.updated_at`,
    ).run(sessionId, attachmentId, included ? 1 : 0, updatedAt);
  }
}

function toPublicAttachment(attachment: StoredContextAttachment): ContextAttachment {
  const {
    dedupeKey: _dedupeKey,
    defaultInclude: _defaultInclude,
    sessionKey: _sessionKey,
    internalFile: _internalFile,
    internalLink: _internalLink,
    ...publicAttachment
  } = attachment;
  return publicAttachment;
}

function parseStoredAttachment(row: ContextAttachmentRow): StoredContextAttachment {
  const file = row.kind === "file"
    ? {
        displayName: required(row.display_name),
        mimeType: required(row.mime_type),
        size: requiredNumber(row.file_size),
        sha256: required(row.sha256),
        extractionState: row.extraction_state ?? "failed",
        extractedChars: row.extracted_chars,
        pageCount: row.page_count,
        extractionError: row.extraction_error,
        renderable: isRenderableImage(row.mime_type),
      }
    : null;
  const link = row.kind === "link"
    ? {
        url: required(row.url),
        host: required(row.host),
        previewState: row.preview_state ?? "failed",
        previewTitle: row.preview_title,
        previewDescription: row.preview_description,
        previewSiteName: row.preview_site_name,
        hasPreviewImage: row.preview_image_file !== null,
        previewError: row.preview_error,
        fetchedAt: row.fetched_at,
      }
    : null;
  const attachment = ContextAttachmentSchema.parse({
    id: row.id,
    projectId: row.project_id,
    scope: row.scope,
    sessionId: row.session_id,
    kind: row.kind,
    origin: normalizeOrigin(row.origin),
    title: row.title,
    note: row.note,
    sortOrder: row.sort_order,
    includedInContext: row.effective_included === 1,
    estimatedTokens: estimateTokens(row),
    file,
    link,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return {
    ...attachment,
    dedupeKey: row.dedupe_key,
    defaultInclude: row.default_include === 1,
    sessionKey: row.session_key,
    internalFile: file
      ? { storageDir: required(row.storage_dir), fileName: required(row.file_name) }
      : null,
    internalLink: link ? { previewImageFile: row.preview_image_file } : null,
  };
}

function normalizeOrigin(value: string | null): ContextAttachmentOrigin {
  const parsed = ContextAttachmentOriginSchema.safeParse(value);
  return parsed.success ? parsed.data : "manual";
}

function estimateTokens(row: ContextAttachmentRow): number | null {
  if (row.kind === "file") {
    if (row.extracted_chars === null) return null;
    return Math.ceil(Math.min(row.extracted_chars, MAX_CONTEXT_CHARS_PER_ATTACHMENT) / 4);
  }
  const chars = [row.title, row.url, row.preview_title, row.preview_description, row.preview_site_name]
    .filter((value): value is string => Boolean(value))
    .join("\n").length;
  return Math.ceil(chars / 4);
}

function estimatedContextChars(attachment: StoredContextAttachment): number {
  if (attachment.kind === "file") {
    return Math.min(attachment.file?.extractedChars ?? 0, MAX_CONTEXT_CHARS_PER_ATTACHMENT);
  }
  return (attachment.estimatedTokens ?? 0) * 4;
}

function isRenderableImage(mimeType: string | null): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType ?? "");
}

function required(value: string | null): string {
  if (value === null) throw new Error("Context attachment storage is incomplete");
  return value;
}

function requiredNumber(value: number | null): number {
  if (value === null) throw new Error("Context attachment storage is incomplete");
  return value;
}
