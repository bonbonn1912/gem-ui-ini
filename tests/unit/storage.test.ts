import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectService } from "../../src/main/projects";
import {
  AttachmentRepository,
  ClientRequestRepository,
  EventRepository,
  getAppDatabasePath,
  getLatestSchemaVersion,
  openAppDatabase,
  openSqliteDatabase,
  ProjectRepository,
  SessionRepository,
  SettingsRepository,
  StorageConflictError,
} from "../../src/main/storage";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-20T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("SQLite setup and migrations", () => {
  it("enables foreign keys and applies every migration", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      const versions = database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      expect(versions.map(({ version }) => version)).toEqual([1, 2, 3, 4]);
      expect(getLatestSchemaVersion()).toBe(4);
      const clientRequests = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'client_requests'",
        )
        .get();
      expect(clientRequests).toBeTruthy();
    } finally {
      database.close();
    }
  });

  it("places the database under Electron userData and uses WAL on disk", async () => {
    const userData = await makeTempDirectory();
    const database = openAppDatabase(userData);
    try {
      const databasePath = getAppDatabasePath(userData);
      await expect(access(databasePath)).resolves.toBeUndefined();
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      database.close();
    }
  });

  it("enforces the primary-root foreign-key invariant in SQLite", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      expect(() =>
        database.transaction(() => {
          database
            .prepare(
              `INSERT INTO projects (
                 id, name, primary_root_id, root_revision, root_fingerprint,
                 archived, created_at, updated_at
               ) VALUES (?, ?, ?, 1, ?, 0, ?, ?)`,
            )
            .run(
              randomUUID(),
              "Broken",
              randomUUID(),
              "a".repeat(64),
              timestamp,
              timestamp,
            );
        })(),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      database.close();
    }
  });
});

describe("repositories", () => {
  it("persists sessions, historical root audit and sequenced events", async () => {
    const fixture = await createProjectFixture();
    try {
      const sessions = new SessionRepository(fixture.database);
      const sessionId = randomUUID();
      sessions.create(
        {
          id: sessionId,
          provider: "gemini-cli",
          providerSessionId: randomUUID(),
          projectId: fixture.project.id,
          lastRootRevision: fixture.project.rootRevision,
          lastRootFingerprint: fixture.project.rootFingerprint,
          title: "Audit session",
          status: "idle",
          model: null,
          mode: null,
          pinned: false,
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        fixture.project.roots,
      );
      const snapshot = sessions.getRootSnapshot(sessionId);
      expect(snapshot?.roots.map((root) => root.realPath)).toEqual(
        fixture.project.roots.map((root) => root.realPath),
      );

      const events = new EventRepository(fixture.database);
      const messageId = randomUUID();
      const first = events.append({
        sessionId,
        turnId: null,
        timestamp,
        event: {
          type: "message.assistant.delta",
          messageId,
          delta: "A",
        },
      });
      const second = events.append({
        sessionId,
        turnId: null,
        timestamp,
        event: {
          type: "message.assistant.delta",
          messageId,
          delta: "B",
        },
      });

      expect([first.seq, second.seq]).toEqual([1, 2]);
      expect(events.latestSequence(sessionId)).toBe(2);
      expect(events.listAfter(sessionId, 1)).toEqual([second]);
    } finally {
      fixture.database.close();
    }
  });

  it("persists a capability-checked project approval-mode default", async () => {
    const fixture = await createProjectFixture();
    try {
      expect(fixture.project).toMatchObject({
        approvalModeId: null,
        approvalModeState: "gemini_default",
      });
      const updated = fixture.projects.setApprovalMode(
        fixture.project.id,
        "advertised-mode",
        "available",
        timestamp,
      );
      expect(updated).toMatchObject({
        approvalModeId: "advertised-mode",
        approvalModeState: "available",
      });
      expect(
        fixture.projects.setApprovalMode(
          fixture.project.id,
          "advertised-mode",
          "unavailable",
          timestamp,
        ),
      ).toMatchObject({ approvalModeState: "unavailable" });
      expect(
        fixture.projects.setApprovalMode(
          fixture.project.id,
          null,
          "gemini_default",
          timestamp,
        ),
      ).toMatchObject({
        approvalModeId: null,
        approvalModeState: "gemini_default",
      });
    } finally {
      fixture.database.close();
    }
  });

  it("persists staged attachments without exposing storage paths in DTOs", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      const attachments = new AttachmentRepository(database);
      const id = randomUUID();
      attachments.save({
        id,
        sessionId: null,
        displayName: "capture.png",
        mimeType: "image/png",
        size: 128,
        sha256: "b".repeat(64),
        storagePath: "/private/app-data/attachments/capture.png",
        createdAt: timestamp,
      });
      const stored = attachments.find(id);
      expect(stored?.status).toBe("staged");
      expect(stored?.storagePath).toContain("app-data");
      const { storagePath: _privatePath, ...publicDto } = stored!;
      expect(publicDto).not.toHaveProperty("storagePath");
    } finally {
      database.close();
    }
  });

  it("stores typed Gemini and Git binary settings", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      const settings = new SettingsRepository(database);
      settings.setGeminiBinaryPath("/opt/gemini/bin/gemini", timestamp);
      expect(settings.getGeminiSettings()).toEqual({
        binaryPath: "/opt/gemini/bin/gemini",
        updatedAt: timestamp,
      });
      settings.setGitBinaryPath("/usr/bin/git", timestamp);
      expect(settings.getGitSettings()).toEqual({
        binaryPath: "/usr/bin/git",
        updatedAt: timestamp,
      });
      settings.set("ui", { theme: "system" }, { version: 2, updatedAt: timestamp });
      expect(settings.get("ui")).toMatchObject({
        value: { theme: "system" },
        version: 2,
      });
    } finally {
      database.close();
    }
  });

  it("atomically reserves and replays idempotent client requests", () => {
    const database = openSqliteDatabase(":memory:");
    try {
      const requests = new ClientRequestRepository(database);
      const clientRequestId = randomUUID();
      expect(
        requests.reserve({ clientRequestId, operation: "sessions.sendPrompt", createdAt: timestamp }),
      ).toEqual({ acquired: true });
      expect(
        requests.reserve({ clientRequestId, operation: "sessions.sendPrompt", createdAt: timestamp }),
      ).toMatchObject({ acquired: false, existing: { state: "pending" } });

      const completed = requests.save({
        clientRequestId,
        operation: "sessions.sendPrompt",
        result: { turnId: randomUUID() },
        createdAt: timestamp,
      });
      expect(completed.state).toBe("completed");
      expect(
        requests.reserve({ clientRequestId, operation: "sessions.sendPrompt" }),
      ).toMatchObject({ acquired: false, existing: { state: "completed" } });
      expect(() =>
        requests.reserve({ clientRequestId, operation: "projects.delete" }),
      ).toThrow(StorageConflictError);

      const abandonedRequestId = randomUUID();
      requests.reserve({
        clientRequestId: abandonedRequestId,
        operation: "sessions.sendPrompt",
      });
      expect(requests.clearPending()).toBe(1);
      expect(requests.get(abandonedRequestId)).toBeNull();
    } finally {
      database.close();
    }
  });

  it("cascades app records when metadata is deleted", async () => {
    const fixture = await createProjectFixture();
    try {
      const sessions = new SessionRepository(fixture.database);
      const sessionId = randomUUID();
      sessions.create({
        id: sessionId,
        provider: "gemini-cli",
        providerSessionId: null,
        projectId: fixture.project.id,
        lastRootRevision: 1,
        lastRootFingerprint: fixture.project.rootFingerprint,
        title: "Disposable",
        status: "idle",
        model: null,
        mode: null,
        pinned: false,
        archived: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      fixture.projects.delete(fixture.project.id);
      expect(sessions.findById(sessionId)).toBeNull();
    } finally {
      fixture.database.close();
    }
  });
});

async function createProjectFixture() {
  const rootDirectory = await makeTempDirectory();
  const primary = path.join(rootDirectory, "primary");
  const additional = path.join(rootDirectory, "additional");
  await mkdir(primary);
  await mkdir(additional);
  const database = openSqliteDatabase(":memory:");
  const projects = new ProjectRepository(database);
  const project = await new ProjectService(projects, {
    now: () => new Date(timestamp),
  }).create({
    clientRequestId: randomUUID(),
    name: "Storage fixture",
    primaryRootPath: primary,
    additionalRootPaths: [additional],
  });
  return { database, projects, project };
}

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gem-ui-storage-"));
  temporaryDirectories.push(directory);
  return directory;
}
