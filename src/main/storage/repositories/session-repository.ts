import { z } from "zod";

import {
  AppSessionSchema,
  DisplayNameSchema,
  EntityIdSchema,
  FileSystemPathSchema,
  IsoTimestampSchema,
  ProjectRootKindSchema,
  RootFingerprintSchema,
  RootRevisionSchema,
  type AppSession,
  type ProjectRoot,
  type SessionOption,
  type SessionStatus,
} from "../../../shared";
import type { SqliteDatabase } from "../database";
import {
  StorageCorruptionError,
  StorageNotFoundError,
} from "../errors";

/**
 * Der Auditeintrag ist eine Projektion: Aufrufer reichen ganze `ProjectRoot`
 * aus `ProjectAccess` durch, die zusätzlich `id`, `projectId`, `createdAt` und
 * `updatedAt` tragen. Das Schema ist deshalb bewusst *nicht* strikt — Zod
 * entfernt die überzähligen Felder, statt den Aufruf mit `unrecognized_keys`
 * abzulehnen. Ein striktes Schema hat hier den ersten Prompt jeder noch nicht
 * gestarteten Session scheitern lassen.
 */
const SessionRootAuditEntrySchema = z
  .object({
    kind: ProjectRootKindSchema,
    path: FileSystemPathSchema,
    realPath: FileSystemPathSchema,
    label: DisplayNameSchema,
    sortOrder: z.int().min(0).max(5),
  })
  .superRefine((root, context) => {
    if (
      (root.kind === "primary" && root.sortOrder !== 0) ||
      (root.kind === "additional" && root.sortOrder === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sortOrder"],
        message: "Root kind and sortOrder do not match",
      });
    }
  });

type SessionRow = {
  id: string;
  provider: "gemini-cli";
  provider_session_id: string | null;
  project_id: string;
  last_root_revision: number;
  last_root_fingerprint: string;
  title: string;
  status: SessionStatus;
  model: string | null;
  mode: string | null;
  available_models_json: string;
  available_modes_json: string;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
};

type SessionRootRow = {
  session_id: string;
  root_revision: number;
  root_fingerprint: string;
  kind: "primary" | "additional";
  path: string;
  real_path: string;
  label: string;
  sort_order: number;
  captured_at: string;
};

export type SessionRootAuditSnapshot = {
  sessionId: string;
  rootRevision: number;
  rootFingerprint: string;
  capturedAt: string;
  roots: Array<
    Pick<ProjectRoot, "kind" | "path" | "realPath" | "label" | "sortOrder">
  >;
};

export type SessionUpdate = {
  providerSessionId?: string | null;
  lastRootRevision?: number;
  lastRootFingerprint?: string;
  title?: string;
  status?: SessionStatus;
  model?: string | null;
  mode?: string | null;
  availableModels?: readonly SessionOption[];
  availableModes?: readonly SessionOption[];
  pinned?: boolean;
  archived?: boolean;
  updatedAt: string;
};

export class SessionRepository {
  constructor(private readonly database: SqliteDatabase) {}

  create(
    // Schema input, not AppSession: fields with defaults (the cached picker
    // lists) may be omitted by a caller that has nothing to say about them.
    session: z.input<typeof AppSessionSchema>,
    rootSnapshot?: readonly ProjectRoot[],
  ): AppSession {
    const parsed = AppSessionSchema.parse(session);

    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO sessions (
             id, provider, provider_session_id, project_id,
             last_root_revision, last_root_fingerprint, title, status,
             model, mode, available_models_json, available_modes_json,
             pinned, archived, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.provider,
          parsed.providerSessionId,
          parsed.projectId,
          parsed.lastRootRevision,
          parsed.lastRootFingerprint,
          parsed.title,
          parsed.status,
          parsed.model,
          parsed.mode,
          JSON.stringify(parsed.availableModels),
          JSON.stringify(parsed.availableModes),
          parsed.pinned ? 1 : 0,
          parsed.archived ? 1 : 0,
          parsed.createdAt,
          parsed.updatedAt,
        );

      if (rootSnapshot) {
        this.insertRootSnapshot({
          sessionId: parsed.id,
          rootRevision: parsed.lastRootRevision,
          rootFingerprint: parsed.lastRootFingerprint,
          roots: rootSnapshot,
          capturedAt: parsed.createdAt,
        });
      }
    })();

    return this.getById(parsed.id);
  }

  getById(sessionId: string): AppSession {
    const row = this.database
      .prepare(
        `SELECT id, provider, provider_session_id, project_id,
                last_root_revision, last_root_fingerprint, title, status,
                model, mode, available_models_json, available_modes_json,
                pinned, archived, created_at, updated_at
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) throw new StorageNotFoundError("Session", sessionId);
    return parseSession(row);
  }

  findById(sessionId: string): AppSession | null {
    try {
      return this.getById(sessionId);
    } catch (error) {
      if (error instanceof StorageNotFoundError) return null;
      throw error;
    }
  }

  listByProject(projectId: string, includeArchived = false): AppSession[] {
    const rows = this.database
      .prepare(
        `SELECT id, provider, provider_session_id, project_id,
                last_root_revision, last_root_fingerprint, title, status,
                model, mode, available_models_json, available_modes_json,
                pinned, archived, created_at, updated_at
         FROM sessions
         WHERE project_id = ? AND (archived = 0 OR ? = 1)
         ORDER BY pinned DESC, updated_at DESC`,
      )
      .all(projectId, includeArchived ? 1 : 0) as SessionRow[];
    return rows.map(parseSession);
  }

  update(sessionId: string, update: SessionUpdate): AppSession {
    const existing = this.getById(sessionId);
    const next = AppSessionSchema.parse({
      ...existing,
      providerSessionId:
        update.providerSessionId === undefined
          ? existing.providerSessionId
          : update.providerSessionId,
      lastRootRevision: update.lastRootRevision ?? existing.lastRootRevision,
      lastRootFingerprint:
        update.lastRootFingerprint ?? existing.lastRootFingerprint,
      title: update.title ?? existing.title,
      status: update.status ?? existing.status,
      model: update.model === undefined ? existing.model : update.model,
      mode: update.mode === undefined ? existing.mode : update.mode,
      // An update that says nothing about the pickers keeps the cached lists:
      // a status change must never wipe what the agent last offered.
      availableModels: update.availableModels ?? existing.availableModels,
      availableModes: update.availableModes ?? existing.availableModes,
      pinned: update.pinned ?? existing.pinned,
      archived: update.archived ?? existing.archived,
      updatedAt: update.updatedAt,
    });

    this.database
      .prepare(
        `UPDATE sessions SET
           provider_session_id = ?, last_root_revision = ?,
           last_root_fingerprint = ?, title = ?, status = ?, model = ?,
           mode = ?, available_models_json = ?, available_modes_json = ?,
           pinned = ?, archived = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.providerSessionId,
        next.lastRootRevision,
        next.lastRootFingerprint,
        next.title,
        next.status,
        next.model,
        next.mode,
        JSON.stringify(next.availableModels),
        JSON.stringify(next.availableModes),
        next.pinned ? 1 : 0,
        next.archived ? 1 : 0,
        next.updatedAt,
        sessionId,
      );

    return this.getById(sessionId);
  }

  recordRootSnapshot(snapshot: SessionRootAuditSnapshot): void {
    const sessionId = EntityIdSchema.parse(snapshot.sessionId);
    const revision = RootRevisionSchema.parse(snapshot.rootRevision);
    const fingerprint = RootFingerprintSchema.parse(snapshot.rootFingerprint);
    const capturedAt = IsoTimestampSchema.parse(snapshot.capturedAt);
    const roots = snapshot.roots.map((root) =>
      SessionRootAuditEntrySchema.parse(root),
    );

    this.database.transaction(() => {
      this.database
        .prepare(
          "DELETE FROM session_roots WHERE session_id = ? AND root_revision = ?",
        )
        .run(sessionId, revision);
      this.insertRootSnapshot({
        ...snapshot,
        sessionId,
        rootRevision: revision,
        rootFingerprint: fingerprint,
        roots,
        capturedAt,
      });
    })();
  }

  getRootSnapshot(
    sessionId: string,
    rootRevision?: number,
  ): SessionRootAuditSnapshot | null {
    const revision =
      rootRevision ??
      (
        this.database
          .prepare(
            `SELECT MAX(root_revision) AS revision
             FROM session_roots WHERE session_id = ?`,
          )
          .get(sessionId) as { revision: number | null }
      ).revision;
    if (revision === null) return null;

    const rows = this.database
      .prepare(
        `SELECT session_id, root_revision, root_fingerprint, kind, path,
                real_path, label, sort_order, captured_at
         FROM session_roots
         WHERE session_id = ? AND root_revision = ?
         ORDER BY sort_order`,
      )
      .all(sessionId, revision) as SessionRootRow[];
    if (rows.length === 0) return null;

    const first = rows[0];
    if (!first) return null;
    return {
      sessionId,
      rootRevision: RootRevisionSchema.parse(first.root_revision),
      rootFingerprint: RootFingerprintSchema.parse(first.root_fingerprint),
      capturedAt: first.captured_at,
      roots: rows.map((row) => ({
        kind: row.kind,
        path: row.path,
        realPath: row.real_path,
        label: row.label,
        sortOrder: row.sort_order,
      })),
    };
  }

  delete(sessionId: string): void {
    const result = this.database
      .prepare("DELETE FROM sessions WHERE id = ?")
      .run(sessionId);
    if (result.changes !== 1) {
      throw new StorageNotFoundError("Session", sessionId);
    }
  }

  private insertRootSnapshot(snapshot: {
    sessionId: string;
    rootRevision: number;
    rootFingerprint: string;
    roots: readonly Pick<
      ProjectRoot,
      "kind" | "path" | "realPath" | "label" | "sortOrder"
    >[];
    capturedAt: string;
  }): void {
    const insert = this.database.prepare(
      `INSERT INTO session_roots (
         session_id, root_revision, root_fingerprint, kind, path,
         real_path, label, sort_order, captured_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const root of snapshot.roots) {
      insert.run(
        snapshot.sessionId,
        snapshot.rootRevision,
        snapshot.rootFingerprint,
        root.kind,
        root.path,
        root.realPath,
        root.label,
        root.sortOrder,
        snapshot.capturedAt,
      );
    }
  }
}

function parseSession(row: SessionRow): AppSession {
  try {
    return AppSessionSchema.parse({
      id: row.id,
      provider: row.provider,
      providerSessionId: row.provider_session_id,
      projectId: row.project_id,
      lastRootRevision: row.last_root_revision,
      lastRootFingerprint: row.last_root_fingerprint,
      title: row.title,
      status: row.status,
      model: row.model,
      mode: row.mode,
      availableModels: JSON.parse(row.available_models_json),
      availableModes: JSON.parse(row.available_modes_json),
      pinned: row.pinned === 1,
      archived: row.archived === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (error) {
    throw new StorageCorruptionError("session", { cause: error });
  }
}
