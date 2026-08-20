import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectRootValidationError,
  ProjectService,
  resolveProjectRootSet,
  type ProjectRuntimeCoordinator,
} from "../../src/main/projects";
import {
  openSqliteDatabase,
  ProjectRepository,
  SessionRepository,
  StorageConflictError,
} from "../../src/main/storage";

const temporaryDirectories: string[] = [];
const now = "2026-08-20T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("project root resolution", () => {
  it("canonicalizes existing directories and creates an ordered fingerprint", async () => {
    const { primary, additional } = await createRootFixture();
    const first = await resolveProjectRootSet({
      primaryRootPath: primary,
      additionalRootPaths: additional,
    });
    const second = await resolveProjectRootSet({
      primaryRootPath: primary,
      additionalRootPaths: additional,
    });

    expect(first.primaryRoot.realPath).toBe(await realPath(primary));
    expect(first.additionalRoots).toHaveLength(2);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("rejects duplicate and nested roots", async () => {
    const base = await makeTempDirectory();
    const primary = path.join(base, "primary");
    const nested = path.join(primary, "nested");
    await mkdir(nested, { recursive: true });

    await expect(
      resolveProjectRootSet({
        primaryRootPath: primary,
        additionalRootPaths: [primary],
      }),
    ).rejects.toMatchObject({ code: "duplicate_root" });
    await expect(
      resolveProjectRootSet({
        primaryRootPath: primary,
        additionalRootPaths: [nested],
      }),
    ).rejects.toMatchObject({ code: "overlapping_root" });
  });

  it("rejects relative paths and more than five additions before disk access", async () => {
    await expect(
      resolveProjectRootSet({ primaryRootPath: "relative/project" }),
    ).rejects.toMatchObject({ code: "root_path_not_absolute" });
    await expect(
      resolveProjectRootSet({
        primaryRootPath: "/does/not/matter",
        additionalRootPaths: Array.from({ length: 6 }, (_, index) => `/x/${index}`),
      }),
    ).rejects.toMatchObject({ code: "too_many_additional_roots" });
  });
});

describe("ProjectService", () => {
  it("creates a project with exactly one primary root and current access", async () => {
    const { primary, additional } = await createRootFixture();
    const database = openSqliteDatabase(":memory:");
    try {
      const service = new ProjectService(new ProjectRepository(database), {
        now: () => new Date(now),
      });
      const project = await service.create({
        clientRequestId: randomUUID(),
        name: "Desktop",
        primaryRootPath: primary,
        additionalRootPaths: additional,
      });

      expect(project.rootRevision).toBe(1);
      expect(project.roots.map((root) => root.kind)).toEqual([
        "primary",
        "additional",
        "additional",
      ]);
      expect(project.primaryRootId).toBe(project.roots[0]?.id);

      const access = await service.getCurrentAccess(project.id);
      expect(access.primaryRoot.realPath).toBe(await realPath(primary));
      expect(access.additionalRoots.map((root) => root.realPath)).toEqual(
        await Promise.all(additional.map(realPath)),
      );
    } finally {
      database.close();
    }
  });

  it("increments root revision atomically and marks existing sessions", async () => {
    const { primary, additional } = await createRootFixture();
    const replacement = path.join(await makeTempDirectory(), "replacement");
    await mkdir(replacement);
    const calls: string[] = [];
    const coordinator: ProjectRuntimeCoordinator = {
      assertProjectIdle(projectId) {
        calls.push(`idle:${projectId}`);
      },
      stopProjectProcesses(projectId) {
        calls.push(`stop:${projectId}`);
      },
    };
    const database = openSqliteDatabase(":memory:");
    try {
      const projects = new ProjectRepository(database);
      const service = new ProjectService(projects, {
        now: () => new Date(now),
        runtimeCoordinator: coordinator,
      });
      const project = await service.create({
        clientRequestId: randomUUID(),
        name: "Desktop",
        primaryRootPath: primary,
        additionalRootPaths: additional,
      });
      const sessions = new SessionRepository(database);
      const sessionId = randomUUID();
      sessions.create(
        {
          id: sessionId,
          provider: "gemini-cli",
          providerSessionId: randomUUID(),
          projectId: project.id,
          lastRootRevision: project.rootRevision,
          lastRootFingerprint: project.rootFingerprint,
          title: "Session",
          status: "idle",
          model: null,
          mode: null,
          pinned: false,
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
        project.roots,
      );

      const updated = await service.setAdditionalRoots({
        clientRequestId: randomUUID(),
        projectId: project.id,
        expectedRootRevision: 1,
        additionalRootPaths: [replacement],
      });

      expect(updated.rootRevision).toBe(2);
      expect(updated.roots).toHaveLength(2);
      expect(calls).toEqual([`idle:${project.id}`, `stop:${project.id}`]);
      expect(sessions.getById(sessionId).status).toBe("roots_changed");
      expect(sessions.getById(sessionId).lastRootRevision).toBe(1);
      expect(
        sessions.getRootSnapshot(sessionId)?.roots.map((root) => root.realPath),
      ).toEqual(project.roots.map((root) => root.realPath));
      expect(
        (await service.getCurrentAccess(project.id)).additionalRoots.map(
          (root) => root.realPath,
        ),
      ).toEqual([await realPath(replacement)]);
      await expect(
        service.setAdditionalRoots({
          clientRequestId: randomUUID(),
          projectId: project.id,
          expectedRootRevision: 1,
          additionalRootPaths: [],
        }),
      ).rejects.toBeInstanceOf(StorageConflictError);
    } finally {
      database.close();
    }
  });

  it("does not increment the revision for the same effective root set", async () => {
    const { primary, additional } = await createRootFixture();
    const database = openSqliteDatabase(":memory:");
    try {
      const service = new ProjectService(new ProjectRepository(database));
      const project = await service.create({
        clientRequestId: randomUUID(),
        name: "Desktop",
        primaryRootPath: primary,
        additionalRootPaths: additional,
      });
      const unchanged = await service.setAdditionalRoots({
        clientRequestId: randomUUID(),
        projectId: project.id,
        expectedRootRevision: 1,
        additionalRootPaths: additional,
      });
      expect(unchanged.rootRevision).toBe(1);
    } finally {
      database.close();
    }
  });

  it("detects when a selected symlink is retargeted", async () => {
    if (process.platform === "win32") return;
    const base = await makeTempDirectory();
    const original = path.join(base, "original");
    const replacement = path.join(base, "replacement");
    const selected = path.join(base, "selected");
    await mkdir(original);
    await mkdir(replacement);
    await symlink(original, selected, "dir");
    const database = openSqliteDatabase(":memory:");
    try {
      const service = new ProjectService(new ProjectRepository(database));
      const project = await service.create({
        clientRequestId: randomUUID(),
        name: "Linked",
        primaryRootPath: selected,
        additionalRootPaths: [],
      });
      await unlink(selected);
      await symlink(replacement, selected, "dir");

      await expect(service.getCurrentAccess(project.id)).rejects.toBeInstanceOf(
        ProjectRootValidationError,
      );
    } finally {
      database.close();
    }
  });

  it("revalidates a persisted root that was removed before a session reload", async () => {
    const { primary } = await createRootFixture();
    const database = openSqliteDatabase(":memory:");
    try {
      const project = await new ProjectService(new ProjectRepository(database)).create({
        clientRequestId: randomUUID(),
        name: "Removed root",
        primaryRootPath: primary,
        additionalRootPaths: [],
      });
      await rm(primary, { recursive: true });
      // A fresh service instance reads the persisted roots like a relaunched app.
      const relaunchedService = new ProjectService(new ProjectRepository(database));

      await expect(relaunchedService.getCurrentAccess(project.id)).rejects.toMatchObject({
        code: "root_not_found",
        rootPath: primary,
      });
    } finally {
      database.close();
    }
  });

  it("rejects a persisted root whose read/traverse permission was revoked", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { primary } = await createRootFixture();
    const database = openSqliteDatabase(":memory:");
    try {
      const project = await new ProjectService(new ProjectRepository(database)).create({
        clientRequestId: randomUUID(),
        name: "Permission revoked",
        primaryRootPath: primary,
        additionalRootPaths: [],
      });
      await chmod(primary, 0o000);
      const relaunchedService = new ProjectService(new ProjectRepository(database));

      await expect(relaunchedService.getCurrentAccess(project.id)).rejects.toMatchObject({
        code: "root_not_accessible",
        rootPath: primary,
      });
    } finally {
      await chmod(primary, 0o700).catch(() => undefined);
      database.close();
    }
  });

  it("reauthorizes exactly one persisted root after a simulated app restart", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { primary } = await createRootFixture();
    const database = openSqliteDatabase(":memory:");
    try {
      const project = await new ProjectService(new ProjectRepository(database)).create({
        clientRequestId: randomUUID(),
        name: "TCC recovery",
        primaryRootPath: primary,
        additionalRootPaths: [],
      });
      await chmod(primary, 0o000);
      const relaunchedService = new ProjectService(new ProjectRepository(database));
      await expect(relaunchedService.getCurrentAccess(project.id)).rejects.toMatchObject({
        code: "root_not_accessible",
      });

      // Restoring the mode models the access granted by the native directory
      // picker. The service must still bind that grant to the persisted root ID.
      await chmod(primary, 0o700);
      const root = project.roots[0]!;
      await expect(
        relaunchedService.reauthorizeRootSelection({
          projectId: project.id,
          rootId: root.id,
          selectedPath: primary,
        }),
      ).resolves.toEqual(root);
      await expect(relaunchedService.getCurrentAccess(project.id)).resolves.toMatchObject({
        primaryRoot: { id: root.id, realPath: root.realPath },
      });
    } finally {
      await chmod(primary, 0o700).catch(() => undefined);
      database.close();
    }
  });

  it("rejects reauthorization when the selected canonical path differs", async () => {
    const { primary, additional } = await createRootFixture();
    const database = openSqliteDatabase(":memory:");
    try {
      const service = new ProjectService(new ProjectRepository(database));
      const project = await service.create({
        clientRequestId: randomUUID(),
        name: "Exact recovery",
        primaryRootPath: primary,
        additionalRootPaths: [],
      });

      await expect(
        service.reauthorizeRootSelection({
          projectId: project.id,
          rootId: project.primaryRootId,
          selectedPath: additional[0]!,
        }),
      ).rejects.toMatchObject({
        code: "root_reauthorization_mismatch",
        rootPath: additional[0],
      });
    } finally {
      database.close();
    }
  });

  it("accepts a selected alias only when it resolves to the stored canonical root", async () => {
    if (process.platform === "win32") return;
    const { primary } = await createRootFixture();
    const alias = path.join(await makeTempDirectory(), "selected-root");
    await symlink(primary, alias, "dir");
    const database = openSqliteDatabase(":memory:");
    try {
      const service = new ProjectService(new ProjectRepository(database));
      const project = await service.create({
        clientRequestId: randomUUID(),
        name: "Canonical recovery",
        primaryRootPath: primary,
        additionalRootPaths: [],
      });

      await expect(
        service.reauthorizeRootSelection({
          projectId: project.id,
          rootId: project.primaryRootId,
          selectedPath: alias,
        }),
      ).resolves.toMatchObject({ id: project.primaryRootId, realPath: await realPath(primary) });
    } finally {
      database.close();
    }
  });

  it("deletes app metadata without deleting project folders", async () => {
    const { primary } = await createRootFixture();
    const database = openSqliteDatabase(":memory:");
    try {
      const repository = new ProjectRepository(database);
      const service = new ProjectService(repository);
      const project = await service.create({
        clientRequestId: randomUUID(),
        name: "Disposable metadata",
        primaryRootPath: primary,
        additionalRootPaths: [],
      });
      service.delete({ clientRequestId: randomUUID(), projectId: project.id });
      expect(repository.findById(project.id)).toBeNull();
      expect((await stat(primary)).isDirectory()).toBe(true);
    } finally {
      database.close();
    }
  });
});

async function createRootFixture(): Promise<{
  primary: string;
  additional: string[];
}> {
  const base = await makeTempDirectory();
  const primary = path.join(base, "primary");
  const additional = [path.join(base, "frontend"), path.join(base, "shared")];
  await Promise.all([primary, ...additional].map((directory) => mkdir(directory)));
  return { primary, additional };
}

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gem-ui-projects-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function realPath(value: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(value);
}
