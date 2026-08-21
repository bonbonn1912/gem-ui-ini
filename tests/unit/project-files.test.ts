import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectFileService } from "../../src/main/project-files";
import { ProjectService } from "../../src/main/projects";
import { openSqliteDatabase, ProjectRepository } from "../../src/main/storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("ProjectFileService", () => {
  it("rankt Dateinamen vor Pfadtreffern und durchsucht alle Projektordner", async () => {
    const fixture = await createFixture();
    const database = openSqliteDatabase(":memory:");
    try {
      const projects = new ProjectService(new ProjectRepository(database));
      const project = await projects.create({
        clientRequestId: randomUUID(),
        name: "Mehrere Repositories",
        primaryRootPath: fixture.primary,
        additionalRootPaths: [fixture.additional],
      });
      const service = new ProjectFileService(projects);

      const result = await service.search({
        projectId: project.id,
        expectedRootRevision: project.rootRevision,
        query: "auth",
        limit: 10,
      });

      expect(result.entries[0]).toMatchObject({
        rootId: project.roots[0]!.id,
        relativePath: "src/auth.ts",
        displayName: "auth.ts",
        contextEligible: true,
      });
      expect(result.entries.some((entry) =>
        entry.rootId === project.roots[1]!.id && entry.relativePath === "packages/auth-client.ts"
      )).toBe(true);
      expect(result.entries).toHaveLength(3);
    } finally {
      database.close();
    }
  });

  it("liest ausgewählte Dateien frisch als Promptkontext und dokumentiert ihren Projektroot", async () => {
    const fixture = await createFixture();
    const database = openSqliteDatabase(":memory:");
    try {
      const projects = new ProjectService(new ProjectRepository(database));
      const project = await projects.create({
        clientRequestId: randomUUID(),
        name: "Kontext",
        primaryRootPath: fixture.primary,
        additionalRootPaths: [fixture.additional],
      });
      const service = new ProjectFileService(projects);
      await writeFile(path.join(fixture.primary, "src", "auth.ts"), "export const current = 'frisch';\n");

      const context = await service.buildPromptContext({
        projectId: project.id,
        expectedRootRevision: project.rootRevision,
        references: [{ rootId: project.roots[0]!.id, relativePath: "src/auth.ts" }],
      });

      expect(context.snapshots).toEqual([expect.objectContaining({
        rootId: project.roots[0]!.id,
        rootLabel: path.basename(fixture.primary),
        relativePath: "src/auth.ts",
      })]);
      expect(context.parts.map((part) => part.type === "text" ? part.text : "").join("\n"))
        .toContain("export const current = 'frisch';");
    } finally {
      database.close();
    }
  });

  it("verhindert Pfadtraversal und Symlink-Ausbrüche beim Promptversand", async () => {
    if (process.platform === "win32") return;
    const fixture = await createFixture();
    const outside = path.join(await makeTempDirectory(), "secret.ts");
    await writeFile(outside, "export const secret = true;\n");
    await symlink(outside, path.join(fixture.primary, "escape.ts"));
    const database = openSqliteDatabase(":memory:");
    try {
      const projects = new ProjectService(new ProjectRepository(database));
      const project = await projects.create({
        clientRequestId: randomUUID(),
        name: "Sicherer Kontext",
        primaryRootPath: fixture.primary,
        additionalRootPaths: [],
      });
      const service = new ProjectFileService(projects);

      await expect(service.buildPromptContext({
        projectId: project.id,
        expectedRootRevision: project.rootRevision,
        references: [{ rootId: project.primaryRootId, relativePath: "../secret.ts" }],
      })).rejects.toThrow();
      await expect(service.buildPromptContext({
        projectId: project.id,
        expectedRootRevision: project.rootRevision,
        references: [{ rootId: project.primaryRootId, relativePath: "escape.ts" }],
      })).rejects.toThrow(/außerhalb|Symlink/);
    } finally {
      database.close();
    }
  });
});

async function createFixture(): Promise<{ primary: string; additional: string }> {
  const base = await makeTempDirectory();
  const primary = path.join(base, "backend");
  const additional = path.join(base, "frontend");
  await mkdir(path.join(primary, "src"), { recursive: true });
  await mkdir(path.join(additional, "packages"), { recursive: true });
  await writeFile(path.join(primary, "src", "auth.ts"), "export const auth = true;\n");
  await writeFile(path.join(primary, "src", "auth-helper.ts"), "export const helper = true;\n");
  await writeFile(path.join(additional, "packages", "auth-client.ts"), "export const client = true;\n");
  await mkdir(path.join(primary, "node_modules", "auth-package"), { recursive: true });
  await writeFile(path.join(primary, "node_modules", "auth-package", "index.js"), "ignored\n");
  return { primary, additional };
}

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gem-ui-project-files-"));
  temporaryDirectories.push(directory);
  return directory;
}
