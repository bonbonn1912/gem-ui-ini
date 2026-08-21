import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectService } from "../../src/main/projects";
import {
  ContextAttachmentRepository,
  ProjectRepository,
  SessionRepository,
  TodoRepository,
  openSqliteDatabase,
  type SqliteDatabase,
} from "../../src/main/storage";
import { TodoService } from "../../src/main/todos";
import type { ContextAttachmentService } from "../../src/main/context-attachments";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-21T09:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Todo storage", () => {
  it("keeps todos on the project and orders open ones before finished ones", async () => {
    const fixture = await createFixture();
    try {
      fixture.todos.create({
        id: randomUUID(),
        projectId: fixture.project.id,
        title: "Login reparieren",
        description: "Der Redirect nach dem Login verliert die Session.",
        createdAt: timestamp,
      });
      const second = fixture.todos.create({
        id: randomUUID(),
        projectId: fixture.project.id,
        title: "Changelog schreiben",
        description: "",
        createdAt: timestamp,
      });

      fixture.todos.update({ todoId: second.id, done: true, updatedAt: timestamp });

      const list = fixture.todos.list(fixture.project.id);
      expect(list.todos.map((todo) => todo.title)).toEqual([
        "Login reparieren",
        "Changelog schreiben",
      ]);
      expect(list.openCount).toBe(1);
      expect(list.doneCount).toBe(1);
      expect(list.todos[1]?.completedAt).toBe(timestamp);
    } finally {
      fixture.database.close();
    }
  });

  it("keeps the moment a todo was finished when it is edited again", async () => {
    const fixture = await createFixture();
    try {
      const todo = fixture.todos.create({
        id: randomUUID(),
        projectId: fixture.project.id,
        title: "Changelog schreiben",
        description: "",
        createdAt: timestamp,
      });
      fixture.todos.update({ todoId: todo.id, done: true, updatedAt: timestamp });
      const edited = fixture.todos.update({
        todoId: todo.id,
        title: "Changelog schreiben und prüfen",
        updatedAt: "2026-08-22T09:00:00.000Z",
      });

      expect(edited.done).toBe(true);
      expect(edited.completedAt).toBe(timestamp);
      expect(edited.updatedAt).toBe("2026-08-22T09:00:00.000Z");

      const reopened = fixture.todos.update({
        todoId: todo.id,
        done: false,
        updatedAt: "2026-08-23T09:00:00.000Z",
      });
      expect(reopened.completedAt).toBeNull();
    } finally {
      fixture.database.close();
    }
  });

  it("deleting a todo drops only the link, not the project attachment", async () => {
    const fixture = await createFixture();
    try {
      const todo = fixture.todos.create({
        id: randomUUID(),
        projectId: fixture.project.id,
        title: "Konzept prüfen",
        description: "",
        createdAt: timestamp,
      });
      const attachment = insertAttachment(fixture, "Konzept.txt");
      fixture.todos.linkAttachment(todo.id, attachment.id, timestamp);

      expect(fixture.todos.get(todo.id).attachments.map((item) => item.title)).toEqual([
        "Konzept.txt",
      ]);

      fixture.todos.delete(todo.id);

      const stillThere = fixture.attachments.list(fixture.project.id, null);
      expect(stillThere.projectAttachments.map((item) => item.title)).toEqual(["Konzept.txt"]);
      const links = fixture.database
        .prepare("SELECT COUNT(*) AS count FROM todo_attachment_links")
        .get() as { count: number };
      expect(links.count).toBe(0);
    } finally {
      fixture.database.close();
    }
  });

  it("removing the attachment itself removes it from every todo", async () => {
    const fixture = await createFixture();
    try {
      const todo = fixture.todos.create({
        id: randomUUID(),
        projectId: fixture.project.id,
        title: "Konzept prüfen",
        description: "",
        createdAt: timestamp,
      });
      const attachment = insertAttachment(fixture, "Konzept.txt");
      fixture.todos.linkAttachment(todo.id, attachment.id, timestamp);

      fixture.attachments.remove(attachment.id);

      expect(fixture.todos.get(todo.id).attachments).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });
});

describe("TodoService", () => {
  it("hands the todo to a session and selects its attachments there", async () => {
    const fixture = await createFixture();
    try {
      const service = new TodoService(
        fixture.todos,
        fixture.attachmentService,
        fixture.projectService,
        fixture.sessions,
      );
      const created = service.create({
        clientRequestId: randomUUID(),
        projectId: fixture.project.id,
        title: "Login reparieren",
        description: "Der Redirect verliert die Session.",
      });
      const todoId = created.todos[0]!.id;
      const attachment = insertAttachment(fixture, "Konzept.txt");
      fixture.todos.linkAttachment(todoId, attachment.id, timestamp);
      const sessionId = createSession(fixture);

      const draft = service.prepareForSession({
        clientRequestId: randomUUID(),
        todoId,
        sessionId,
      });

      expect(draft.text).toBe("Login reparieren\n\nDer Redirect verliert die Session.");
      expect(draft.attachmentIds).toEqual([attachment.id]);
      const selected = draft.contextAttachments.projectAttachments
        .filter((item) => item.includedInContext)
        .map((item) => item.title);
      expect(selected).toEqual(["Konzept.txt"]);

      service.dispose();
    } finally {
      fixture.database.close();
    }
  });

  it("sends only the title when the todo has no description", async () => {
    const fixture = await createFixture();
    try {
      const service = new TodoService(
        fixture.todos,
        fixture.attachmentService,
        fixture.projectService,
        fixture.sessions,
      );
      const created = service.create({
        clientRequestId: randomUUID(),
        projectId: fixture.project.id,
        title: "Changelog schreiben",
        description: "   ",
      });
      const draft = service.prepareForSession({
        clientRequestId: randomUUID(),
        todoId: created.todos[0]!.id,
        sessionId: createSession(fixture),
      });

      expect(draft.text).toBe("Changelog schreiben");
      expect(draft.attachmentIds).toEqual([]);
      service.dispose();
    } finally {
      fixture.database.close();
    }
  });

  it("refuses a session that belongs to a different project", async () => {
    const fixture = await createFixture();
    const other = await createFixture(fixture.database);
    try {
      const service = new TodoService(
        fixture.todos,
        fixture.attachmentService,
        fixture.projectService,
        fixture.sessions,
      );
      const created = service.create({
        clientRequestId: randomUUID(),
        projectId: fixture.project.id,
        title: "Login reparieren",
        description: "",
      });

      expect(() =>
        service.prepareForSession({
          clientRequestId: randomUUID(),
          todoId: created.todos[0]!.id,
          sessionId: createSession(other),
        }),
      ).toThrow(/gehört nicht zum Projekt/);
      service.dispose();
    } finally {
      fixture.database.close();
    }
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/**
 * The real attachment service needs Electron's session for link previews, so
 * the parts a todo actually uses are backed by the real repository instead.
 */
function attachmentServiceStub(
  repository: ContextAttachmentRepository,
): ContextAttachmentService {
  const listeners = new Set<(projectId: string) => void>();
  return {
    subscribe(listener: (projectId: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    list: (input: { projectId: string; sessionId: string | null }) =>
      repository.list(input.projectId, input.sessionId ?? null),
    setInclusion: (input: {
      sessionId: string;
      attachmentIds: string[];
      included: boolean;
    }) => {
      const first = repository.getInternal(input.attachmentIds[0]!);
      repository.setInclusion(
        input.sessionId,
        input.attachmentIds,
        input.included,
        timestamp,
      );
      return repository.list(first.projectId, input.sessionId);
    },
    getStored: (attachmentId: string) => repository.getInternal(attachmentId),
  } as unknown as ContextAttachmentService;
}

async function createFixture(existing?: SqliteDatabase) {
  const rootDirectory = await makeTempDirectory();
  const primary = path.join(rootDirectory, "primary");
  await mkdir(primary);
  const database = existing ?? openSqliteDatabase(":memory:");
  const projectRepository = new ProjectRepository(database);
  const projectService = new ProjectService(projectRepository, {
    now: () => new Date(timestamp),
  });
  const project = await projectService.create({
    clientRequestId: randomUUID(),
    name: `Todos ${path.basename(rootDirectory)}`,
    primaryRootPath: primary,
    additionalRootPaths: [],
  });
  const attachments = new ContextAttachmentRepository(database);
  return {
    database,
    project,
    projectService,
    attachments,
    attachmentService: attachmentServiceStub(attachments),
    sessions: new SessionRepository(database),
    todos: new TodoRepository(database, attachments),
  };
}

function insertAttachment(fixture: Fixture, title: string) {
  const sha256 = randomUUID().replaceAll("-", "").padEnd(64, "0");
  return fixture.attachments.insertFile({
    id: randomUUID(),
    projectId: fixture.project.id,
    scope: "project",
    sessionId: null,
    title,
    displayName: title,
    mimeType: "text/plain",
    size: 12,
    sha256,
    storageDir: "/internal/blobs/aa",
    fileName: sha256,
    defaultInclude: false,
    createdAt: timestamp,
  });
}

function createSession(fixture: Fixture): string {
  const sessionId = randomUUID();
  fixture.sessions.create({
    id: sessionId,
    provider: "gemini-cli",
    providerSessionId: null,
    projectId: fixture.project.id,
    lastRootRevision: fixture.project.rootRevision,
    lastRootFingerprint: fixture.project.rootFingerprint,
    title: "Arbeitssession",
    status: "idle",
    model: null,
    mode: null,
    pinned: false,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return sessionId;
}

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gem-ui-todos-"));
  temporaryDirectories.push(directory);
  return directory;
}
