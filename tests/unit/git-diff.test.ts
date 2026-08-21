import { randomUUID } from "node:crypto";
import { access as fsAccess, chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProjectAccess } from "../../src/shared";
import type { GeminiCapabilityService } from "../../src/main/capability-service";
import {
  GitService,
  discoverProjectRepositories,
  parseGitVersion,
  parsePorcelainV2,
  parseUnifiedDiff,
  probeGitBinary,
  runGitCommand,
} from "../../src/main/git";
import type { ProjectService } from "../../src/main/projects";

const hashA = "a".repeat(40);
const hashB = "b".repeat(40);

describe("Git parsers and bounded runner", () => {
  it("parses porcelain v2 branch, ordinary, rename, conflict and untracked records", () => {
    const input = [
      `# branch.oid ${hashA}`,
      "# branch.head feature/diff",
      "# branch.upstream origin/feature/diff",
      "# branch.ab +3 -2",
      `1 MM N... 100644 100644 100644 ${hashA} ${hashB} src/a file.ts`,
      `2 R. N... 100644 100644 100644 ${hashA} ${hashB} R087 src/new name.ts`,
      "src/old name.ts",
      `u UU N... 100644 100644 100644 100644 ${hashA} ${hashA} ${hashB} conflicted.ts`,
      "? weird\tunicode-ä.txt",
      "",
    ].join("\0");

    const status = parsePorcelainV2(input);
    expect(status.branch).toEqual({
      oid: hashA,
      head: "feature/diff",
      upstream: "origin/feature/diff",
      ahead: 3,
      behind: 2,
    });
    expect(status.entries).toMatchObject([
      { path: "src/a file.ts", indexStatus: "M", worktreeStatus: "M" },
      { path: "src/new name.ts", previousPath: "src/old name.ts", renameScore: 87 },
      { path: "conflicted.ts", conflict: true },
      { path: "weird\tunicode-ä.txt", untracked: true },
    ]);
  });

  it("parses unified hunks, line numbers and no-newline markers", () => {
    const diff = parseUnifiedDiff([
      "diff --git a/demo.txt b/demo.txt",
      `index ${hashA.slice(0, 7)}..${hashB.slice(0, 7)} 100644`,
      "--- a/demo.txt",
      "+++ b/demo.txt",
      "@@ -1,2 +1,3 @@ title",
      " same",
      "-old",
      "+new",
      "+extra",
      "\\ No newline at end of file",
      "",
    ].join("\n"));
    expect(diff).toMatchObject({ binary: false, additions: 2, deletions: 1 });
    expect(diff.hunks[0]?.lines).toMatchObject([
      { kind: "context", oldLine: 1, newLine: 1, content: "same" },
      { kind: "deletion", oldLine: 2, newLine: null, content: "old" },
      { kind: "addition", oldLine: null, newLine: 2, content: "new" },
      { kind: "addition", oldLine: null, newLine: 3, content: "extra" },
      { kind: "no_newline", oldLine: null, newLine: null },
    ]);
  });

  it("fails closed rather than returning truncated process output", async () => {
    const result = await runGitCommand({
      binaryPath: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096))"],
      maxStdoutBytes: 128,
    });
    expect(result.tooLarge).toBe(true);
    expect(result.stdout).toHaveLength(0);
  });

  it("parses native Git versions", () => {
    expect(parseGitVersion("git version 2.50.1 (Apple Git-155)")).toBe("2.50.1");
  });
});

describe("GitService integration", () => {
  let repository = "";
  let binaryPath = "";
  let access: ProjectAccess;

  beforeAll(async () => {
    const probe = await probeGitBinary();
    if (!probe.ok) throw new Error("Git is required for this integration test");
    binaryPath = probe.binaryPath;
    repository = await realpath(
      await mkdtemp(path.join(tmpdir(), "geminui-git-viewer-")),
    );
    await git(["init"]);
    await git(["config", "user.name", "GeminUI Test"]);
    await git(["config", "user.email", "geminui@example.invalid"]);
    await writeFile(path.join(repository, "tracked.txt"), "first\nsecond\n");
    await git(["add", "--", "tracked.txt"]);
    await git(["commit", "-m", "initial"]);

    const projectId = randomUUID();
    const rootId = randomUUID();
    const timestamp = "2026-08-21T10:00:00.000Z";
    access = {
      projectId,
      rootRevision: 1,
      rootFingerprint: "c".repeat(64),
      primaryRoot: {
        id: rootId,
        projectId,
        kind: "primary",
        path: repository,
        realPath: repository,
        label: path.basename(repository),
        sortOrder: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      additionalRoots: [],
    };
  });

  afterAll(async () => {
    if (repository) await rm(repository, { recursive: true, force: true });
  });

  it("reads unstaged, untracked and staged text diffs through opaque file ids", async () => {
    await writeFile(path.join(repository, "tracked.txt"), "first\nchanged\n");
    await writeFile(path.join(repository, "untracked ä.txt"), "hello\nworld");
    const service = createService(access, binaryPath);

    const status = await service.getProjectStatus({
      projectId: access.projectId,
      expectedRootRevision: 1,
    });
    expect(status.repositories).toMatchObject([{ state: "ready" }]);
    expect(status.changes.map((change) => change.path)).toEqual([
      "tracked.txt",
      "untracked ä.txt",
    ]);

    const tracked = status.changes.find((change) => change.path === "tracked.txt")!;
    const repeatedStatus = await service.getProjectStatus({
      projectId: access.projectId,
      expectedRootRevision: 1,
    });
    expect(repeatedStatus.changes.find((change) => change.path === "tracked.txt")?.fileId)
      .toBe(tracked.fileId);
    const trackedDiff = await service.getFileDiff({
      projectId: access.projectId,
      expectedRootRevision: 1,
      repositoryId: tracked.repositoryId,
      fileId: tracked.fileId,
      area: "unstaged",
    });
    expect(trackedDiff).toMatchObject({ state: "text", additions: 1, deletions: 1 });
    expect(trackedDiff.hunks[0]?.lines.some((line) => line.content === "changed")).toBe(true);

    const untracked = status.changes.find((change) => change.untracked)!;
    const untrackedDiff = await service.getFileDiff({
      projectId: access.projectId,
      expectedRootRevision: 1,
      repositoryId: untracked.repositoryId,
      fileId: untracked.fileId,
      area: "unstaged",
    });
    expect(untrackedDiff).toMatchObject({ state: "text", additions: 2, deletions: 0 });
    expect(untrackedDiff.hunks[0]?.lines.at(-1)?.kind).toBe("no_newline");

    await git(["add", "--", "tracked.txt"]);
    const stagedStatus = await service.getProjectStatus({
      projectId: access.projectId,
      expectedRootRevision: 1,
    });
    const staged = stagedStatus.changes.find((change) => change.path === "tracked.txt")!;
    const stagedDiff = await service.getFileDiff({
      projectId: access.projectId,
      expectedRootRevision: 1,
      repositoryId: staged.repositoryId,
      fileId: staged.fileId,
      area: "staged",
    });
    expect(stagedDiff).toMatchObject({ state: "text", additions: 1, deletions: 1 });

    await writeFile(path.join(repository, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await git(["add", "--", "image.bin"]);
    await git(["commit", "-m", "add binary"]);
    await writeFile(path.join(repository, "image.bin"), Buffer.from([0, 1, 9, 3]));
    const binaryStatus = await service.getProjectStatus({
      projectId: access.projectId,
      expectedRootRevision: 1,
    });
    const binary = binaryStatus.changes.find((change) => change.path === "image.bin")!;
    const binaryDiff = await service.getFileDiff({
      projectId: access.projectId,
      expectedRootRevision: 1,
      repositoryId: binary.repositoryId,
      fileId: binary.fileId,
      area: "unstaged",
    });
    expect(binaryDiff.state).toBe("binary");
  });

  it("shows staged content in a repository without a first commit", async () => {
    const unbornRepository = await realpath(
      await mkdtemp(path.join(tmpdir(), "geminui-git-unborn-")),
    );
    try {
      await runIn(unbornRepository, ["init"]);
      await writeFile(path.join(unbornRepository, "first.txt"), "first commit\n");
      await runIn(unbornRepository, ["add", "--", "first.txt"]);
      const unbornAccess: ProjectAccess = {
        ...access,
        projectId: randomUUID(),
        primaryRoot: {
          ...access.primaryRoot,
          id: randomUUID(),
          projectId: "placeholder",
          path: unbornRepository,
          realPath: unbornRepository,
          label: path.basename(unbornRepository),
        },
      };
      unbornAccess.primaryRoot.projectId = unbornAccess.projectId;
      const service = createService(unbornAccess, binaryPath);
      const status = await service.getProjectStatus({
        projectId: unbornAccess.projectId,
        expectedRootRevision: 1,
      });
      expect(status.repositories[0]).toMatchObject({ state: "ready", headOid: null });
      const file = status.changes.find((change) => change.path === "first.txt")!;
      const diff = await service.getFileDiff({
        projectId: unbornAccess.projectId,
        expectedRootRevision: 1,
        repositoryId: file.repositoryId,
        fileId: file.fileId,
        area: "staged",
      });
      expect(diff).toMatchObject({ state: "text", additions: 1, deletions: 0 });
    } finally {
      await rm(unbornRepository, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("does not follow an untracked symlink outside the worktree", async () => {
    const outside = path.join(path.dirname(repository), `${path.basename(repository)}-secret.txt`);
    const linkTarget = path.join(repository, "outside-link.txt");
    await writeFile(outside, "TOP SECRET CONTENT");
    try {
      await symlink(outside, linkTarget);
      const service = createService(access, binaryPath);
      const status = await service.getProjectStatus({
        projectId: access.projectId,
        expectedRootRevision: 1,
      });
      const link = status.changes.find((change) => change.path === "outside-link.txt")!;
      const diff = await service.getFileDiff({
        projectId: access.projectId,
        expectedRootRevision: 1,
        repositoryId: link.repositoryId,
        fileId: link.fileId,
        area: "unstaged",
      });
      expect(diff.state).toBe("text");
      expect(diff.hunks[0]?.lines[0]?.content).toBe(outside);
      expect(diff.hunks.flatMap((hunk) => hunk.lines).some((line) => line.content.includes("TOP SECRET"))).toBe(false);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it.runIf(process.platform !== "win32")("disables configured external diff and textconv commands", async () => {
    const marker = path.join(repository, "external-diff-was-run");
    const script = path.join(repository, "malicious-textconv.mjs");
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "invoked"); process.stdout.write("malicious");`,
    );
    await chmod(script, 0o755);
    await writeFile(path.join(repository, ".gitattributes"), "security.txt diff=evil\n");
    await writeFile(path.join(repository, "security.txt"), "safe\n");
    await git(["add", "--", ".gitattributes", "security.txt"]);
    await git(["commit", "-m", "security fixture"]);
    await git(["config", "diff.external", `${process.execPath} ${script}`]);
    await git(["config", "diff.evil.textconv", `${process.execPath} ${script}`]);
    await writeFile(path.join(repository, "security.txt"), "changed safely\n");

    const service = createService(access, binaryPath);
    const status = await service.getProjectStatus({
      projectId: access.projectId,
      expectedRootRevision: 1,
    });
    const file = status.changes.find((change) => change.path === "security.txt")!;
    const diff = await service.getFileDiff({
      projectId: access.projectId,
      expectedRootRevision: 1,
      repositoryId: file.repositoryId,
      fileId: file.fileId,
      area: "unstaged",
    });
    expect(diff.state).toBe("text");
    await expect(fsAccess(marker)).rejects.toThrow();
  });

  it("rejects a selected subdirectory whose repository top-level is outside authority", async () => {
    const nested = path.join(repository, "nested");
    await mkdir(nested);
    const nestedAccess: ProjectAccess = {
      ...access,
      primaryRoot: {
        ...access.primaryRoot,
        id: randomUUID(),
        path: nested,
        realPath: nested,
        label: "nested",
      },
    };
    const contexts = await discoverProjectRepositories({
      access: nestedAccess,
      binaryPath,
    });
    expect(contexts).toMatchObject([{
      state: "outside_authority",
      message: expect.stringContaining("Repository-Hauptordner"),
    }]);
  });

  async function git(args: string[]): Promise<void> {
    await runIn(repository, args);
  }

  async function runIn(directory: string, args: string[]): Promise<void> {
    const result = await runGitCommand({
      binaryPath,
      args: ["-C", directory, ...args],
      cwd: directory,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString("utf8") || `git ${args[0]} failed`);
    }
  }
});

function createService(access: ProjectAccess, binaryPath: string): GitService {
  const projects = {
    getCurrentAccess: async (projectId: string) => {
      if (projectId !== access.projectId) throw new Error("unknown project");
      return access;
    },
  } as unknown as ProjectService;
  const capabilities = { gitBinaryPath: binaryPath } as GeminiCapabilityService;
  return new GitService(projects, capabilities);
}
