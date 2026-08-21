import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import path from "node:path";

import {
  GitFileDiffSchema,
  GitProjectStatusSchema,
  MAX_GIT_CHANGES,
  MAX_GIT_DIFF_LINES,
  type GetGitFileDiffInput,
  type GetGitProjectStatusInput,
  type GitArea,
  type GitFileChange,
  type GitFileDiff,
  type GitDiffLine,
  type GitProjectStatus,
  type GitRepositorySummary,
  type ProjectAccess,
} from "../../shared/contracts";
import type { GeminiCapabilityService } from "../capability-service";
import type { ProjectService } from "../projects";
import {
  discoverProjectRepositories,
  type DiscoveredRepositoryContext,
  type ReadyRepositoryContext,
} from "./repository-discovery";
import {
  GIT_DIFF_OUTPUT_LIMIT,
  GIT_STATUS_OUTPUT_LIMIT,
  runGitCommand,
} from "./git-command-runner";
import {
  parsePorcelainV2,
  type ParsedGitStatusEntry,
} from "./porcelain-v2-parser";
import {
  DiffLineLimitError,
  parseUnifiedDiff,
  type ParsedUnifiedDiff,
} from "./unified-diff-parser";

type FileSnapshot = {
  key: string;
  createdAt: number;
  projectId: string;
  rootRevision: number;
  repositoryId: string;
  repositoryIdentity: string;
  entry: ParsedGitStatusEntry;
};

const SNAPSHOT_TTL_MS = 5 * 60_000;

export class GitService {
  readonly #projects: ProjectService;
  readonly #capabilities: GeminiCapabilityService;
  readonly #repositoryIds = new Map<string, string>();
  readonly #fileSnapshots = new Map<string, FileSnapshot>();
  readonly #fileSnapshotIds = new Map<string, string>();

  constructor(
    projects: ProjectService,
    capabilities: GeminiCapabilityService,
  ) {
    this.#projects = projects;
    this.#capabilities = capabilities;
  }

  async listProjectRepositories(input: GetGitProjectStatusInput) {
    const status = await this.getProjectStatus(input);
    return {
      projectId: status.projectId,
      rootRevision: status.rootRevision,
      repositories: status.repositories,
    };
  }

  async getProjectStatus(
    input: GetGitProjectStatusInput,
    signal?: AbortSignal,
  ): Promise<GitProjectStatus> {
    this.#pruneSnapshots();
    const access = await this.#projects.getCurrentAccess(input.projectId);
    assertRootRevision(access, input.expectedRootRevision);
    const binaryPath = this.#capabilities.gitBinaryPath;
    if (!binaryPath) return this.#unavailableStatus(access);

    const contexts = await discoverProjectRepositories({
      access,
      binaryPath,
      signal,
    });
    const repositories: GitRepositorySummary[] = [];
    const changes: GitFileChange[] = [];

    for (const context of contexts) {
      const repositoryId = this.#repositoryId(context.identity);
      if (context.state !== "ready") {
        repositories.push({
          repositoryId,
          rootIds: context.rootIds,
          displayName: context.displayName,
          worktreeLabel: context.worktreeLabel,
          branch: null,
          headOid: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          state: context.state,
          message: context.message,
        });
        continue;
      }

      const parsed = await this.#readStatus(binaryPath, context, signal);
      if (!parsed) {
        repositories.push({
          repositoryId,
          rootIds: context.rootIds,
          displayName: context.displayName,
          worktreeLabel: context.worktreeLabel,
          branch: null,
          headOid: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          state: "error",
          message: "Der Git-Status ist zu groß oder konnte nicht vollständig gelesen werden.",
        });
        continue;
      }
      if (changes.length + parsed.entries.length > MAX_GIT_CHANGES) {
        repositories.push({
          repositoryId,
          rootIds: context.rootIds,
          displayName: context.displayName,
          worktreeLabel: context.worktreeLabel,
          branch: parsed.branch.head,
          headOid: parsed.branch.oid,
          upstream: parsed.branch.upstream,
          ahead: parsed.branch.ahead,
          behind: parsed.branch.behind,
          state: "error",
          message: "Dieses Projekt enthält zu viele Änderungen für eine sichere Anzeige.",
        });
        continue;
      }

      repositories.push({
        repositoryId,
        rootIds: context.rootIds,
        displayName: context.displayName,
        worktreeLabel: context.worktreeLabel,
        branch: parsed.branch.head,
        headOid: parsed.branch.oid,
        upstream: parsed.branch.upstream,
        ahead: parsed.branch.ahead,
        behind: parsed.branch.behind,
        state: "ready",
        message: null,
      });
      const repositoryChanges = await Promise.all(parsed.entries.map(async (entry) => {
        const fileId = await this.#fileIdForSnapshot(
          access,
          repositoryId,
          context,
          entry,
        );
        return {
          fileId,
          repositoryId,
          path: entry.path,
          previousPath: entry.previousPath,
          indexStatus: entry.indexStatus,
          worktreeStatus: entry.worktreeStatus,
          conflict: entry.conflict,
          untracked: entry.untracked,
          submodule: entry.submodule,
          renameScore: entry.renameScore,
        } satisfies GitFileChange;
      }));
      changes.push(...repositoryChanges);
    }

    return GitProjectStatusSchema.parse({
      projectId: access.projectId,
      rootRevision: access.rootRevision,
      refreshedAt: new Date().toISOString(),
      repositories,
      changes,
    });
  }

  async getFileDiff(
    input: GetGitFileDiffInput,
    signal?: AbortSignal,
  ): Promise<GitFileDiff> {
    this.#pruneSnapshots();
    const snapshot = this.#fileSnapshots.get(input.fileId);
    if (
      !snapshot ||
      snapshot.projectId !== input.projectId ||
      snapshot.rootRevision !== input.expectedRootRevision ||
      snapshot.repositoryId !== input.repositoryId
    ) {
      throw new Error("Der Änderungsstand ist nicht mehr aktuell. Bitte lade die Änderungen neu.");
    }
    assertAreaAvailable(snapshot.entry, input.area);

    const access = await this.#projects.getCurrentAccess(input.projectId);
    assertRootRevision(access, input.expectedRootRevision);
    const binaryPath = this.#capabilities.gitBinaryPath;
    if (!binaryPath) {
      return this.#specialDiff(input, snapshot.entry, "unavailable", "Git ist nicht verfügbar.");
    }
    const contexts = await discoverProjectRepositories({ access, binaryPath, signal });
    const context = contexts.find(
      (candidate): candidate is ReadyRepositoryContext =>
        candidate.state === "ready" &&
        candidate.identity === snapshot.repositoryIdentity,
    );
    if (!context) {
      throw new Error("Das Git-Repository ist nicht mehr innerhalb der freigegebenen Projektordner verfügbar.");
    }
    if (snapshot.entry.conflict) {
      return this.#specialDiff(
        input,
        snapshot.entry,
        "conflict",
        "Diese Datei enthält einen Merge-Konflikt. Ein normaler Textdiff ist hier nicht eindeutig.",
      );
    }
    if (snapshot.entry.submodule) {
      return this.#specialDiff(
        input,
        snapshot.entry,
        "submodule",
        "Das Submodule wird als Commit-Änderung angezeigt; sein eigener Inhalt gehört nicht zu diesem Viewer.",
      );
    }
    if (snapshot.entry.untracked) {
      return this.#readUntrackedDiff(input, snapshot.entry, context);
    }

    const result = await runGitCommand({
      binaryPath,
      args: buildDiffArgs(context.worktreePath, snapshot.entry, input.area),
      cwd: context.worktreePath,
      signal,
      readOnly: true,
      timeoutMs: 15_000,
      maxStdoutBytes: GIT_DIFF_OUTPUT_LIMIT,
    });
    if (result.tooLarge) {
      return this.#specialDiff(
        input,
        snapshot.entry,
        "too_large",
        "Der Diff ist größer als 5 MiB und wird deshalb nicht teilweise angezeigt.",
      );
    }
    if (result.aborted) {
      throw new Error("Der Diff-Aufruf wurde abgebrochen.");
    }
    if (result.timedOut || result.exitCode !== 0) {
      return this.#specialDiff(
        input,
        snapshot.entry,
        "error",
        "Der Git-Diff konnte nicht vollständig erzeugt werden.",
      );
    }
    if (result.stdout.length === 0) {
      return this.#specialDiff(
        input,
        snapshot.entry,
        "unavailable",
        "Für den aktuellen Dateistand ist kein Diff mehr vorhanden. Lade die Änderungen neu.",
      );
    }

    try {
      return this.#parsedDiff(
        input,
        snapshot.entry,
        parseUnifiedDiff(result.stdout),
      );
    } catch (error) {
      if (error instanceof DiffLineLimitError) {
        return this.#specialDiff(
          input,
          snapshot.entry,
          "too_large",
          "Der Diff enthält zu viele Zeilen und wird deshalb nicht teilweise angezeigt.",
        );
      }
      return this.#specialDiff(
        input,
        snapshot.entry,
        "error",
        "Der vollständige Git-Diff konnte nicht sicher geparst werden.",
      );
    }
  }

  #repositoryId(identity: string): string {
    const existing = this.#repositoryIds.get(identity);
    if (existing) return existing;
    const created = randomUUID();
    this.#repositoryIds.set(identity, created);
    return created;
  }

  async #fileIdForSnapshot(
    access: ProjectAccess,
    repositoryId: string,
    context: ReadyRepositoryContext,
    entry: ParsedGitStatusEntry,
  ): Promise<string> {
    const worktreeSignature =
      entry.worktreeStatus !== "." || entry.untracked || entry.conflict
        ? await fileMetadataSignature(context.worktreePath, entry.path)
        : null;
    const key = createHash("sha256").update(JSON.stringify({
      projectId: access.projectId,
      rootRevision: access.rootRevision,
      repositoryId,
      entry,
      worktreeSignature,
    })).digest("hex");
    const existingId = this.#fileSnapshotIds.get(key);
    const existing = existingId ? this.#fileSnapshots.get(existingId) : undefined;
    if (existingId && existing) {
      existing.createdAt = Date.now();
      existing.entry = entry;
      return existingId;
    }

    const fileId = randomUUID();
    this.#fileSnapshotIds.set(key, fileId);
    this.#fileSnapshots.set(fileId, {
      key,
      createdAt: Date.now(),
      projectId: access.projectId,
      rootRevision: access.rootRevision,
      repositoryId,
      repositoryIdentity: context.identity,
      entry,
    });
    return fileId;
  }

  async #readStatus(
    binaryPath: string,
    context: ReadyRepositoryContext,
    signal?: AbortSignal,
  ) {
    const result = await runGitCommand({
      binaryPath,
      args: [
        "--literal-pathspecs",
        "-c",
        "color.ui=false",
        "-c",
        "core.quotepath=false",
        "-C",
        context.worktreePath,
        "status",
        "--porcelain=v2",
        "-z",
        "--branch",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
      cwd: context.worktreePath,
      signal,
      readOnly: true,
      timeoutMs: 10_000,
      maxStdoutBytes: GIT_STATUS_OUTPUT_LIMIT,
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.aborted ||
      result.tooLarge
    ) return null;
    try {
      return parsePorcelainV2(result.stdout);
    } catch {
      return null;
    }
  }

  async #readUntrackedDiff(
    input: GetGitFileDiffInput,
    entry: ParsedGitStatusEntry,
    context: ReadyRepositoryContext,
  ): Promise<GitFileDiff> {
    const absolutePath = resolveRepositoryPath(context.worktreePath, entry.path);
    try {
      const metadata = await lstat(absolutePath);
      let bytes: Buffer;
      let mode: string;
      if (metadata.isSymbolicLink()) {
        bytes = Buffer.from(await readlink(absolutePath), "utf8");
        mode = "120000";
      } else if (metadata.isFile()) {
        if (metadata.size > GIT_DIFF_OUTPUT_LIMIT) {
          return this.#specialDiff(
            input,
            entry,
            "too_large",
            "Die unversionierte Datei ist größer als 5 MiB.",
          );
        }
        const noFollow = fsConstants.O_NOFOLLOW ?? 0;
        const handle = await open(absolutePath, fsConstants.O_RDONLY | noFollow);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.size > GIT_DIFF_OUTPUT_LIMIT) {
            return this.#specialDiff(
              input,
              entry,
              "too_large",
              "Die unversionierte Datei ist zu groß oder kein regulärer Textinhalt.",
            );
          }
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        mode = metadata.mode & 0o111 ? "100755" : "100644";
      } else {
        return this.#specialDiff(
          input,
          entry,
          "unavailable",
          "Dieser unversionierte Dateityp kann nicht als Textdiff angezeigt werden.",
        );
      }

      if (looksBinary(bytes)) {
        return this.#specialDiff(
          input,
          entry,
          "binary",
          "Binärdatei – es gibt keinen darstellbaren Textdiff.",
          [`new file mode ${mode}`],
        );
      }
      return this.#parsedDiff(
        input,
        entry,
        createUntrackedParsedDiff(bytes, mode),
      );
    } catch (error) {
      if (error instanceof DiffLineLimitError) {
        return this.#specialDiff(
          input,
          entry,
          "too_large",
          "Die unversionierte Datei enthält zu viele oder zu lange Zeilen.",
        );
      }
      return this.#specialDiff(
        input,
        entry,
        "error",
        "Die unversionierte Datei konnte nicht sicher gelesen werden.",
      );
    }
  }

  #parsedDiff(
    input: GetGitFileDiffInput,
    entry: ParsedGitStatusEntry,
    parsed: ParsedUnifiedDiff,
  ): GitFileDiff {
    if (parsed.binary) {
      return this.#specialDiff(
        input,
        entry,
        "binary",
        "Binärdatei – es gibt keinen darstellbaren Textdiff.",
        parsed.metadata,
      );
    }
    return GitFileDiffSchema.parse({
      snapshotId: randomUUID(),
      repositoryId: input.repositoryId,
      fileId: input.fileId,
      area: input.area,
      path: entry.path,
      previousPath: entry.previousPath,
      state: "text",
      message: null,
      additions: parsed.additions,
      deletions: parsed.deletions,
      metadata: parsed.metadata,
      hunks: parsed.hunks,
    });
  }

  #specialDiff(
    input: GetGitFileDiffInput,
    entry: ParsedGitStatusEntry,
    state: Exclude<GitFileDiff["state"], "text">,
    message: string,
    metadata: string[] = [],
  ): GitFileDiff {
    return GitFileDiffSchema.parse({
      snapshotId: randomUUID(),
      repositoryId: input.repositoryId,
      fileId: input.fileId,
      area: input.area,
      path: entry.path,
      previousPath: entry.previousPath,
      state,
      message,
      additions: 0,
      deletions: 0,
      metadata,
      hunks: [],
    });
  }

  #unavailableStatus(access: ProjectAccess): GitProjectStatus {
    const roots = [access.primaryRoot, ...access.additionalRoots];
    return GitProjectStatusSchema.parse({
      projectId: access.projectId,
      rootRevision: access.rootRevision,
      refreshedAt: new Date().toISOString(),
      repositories: roots.map((root) => ({
        repositoryId: this.#repositoryId(`unavailable:${root.id}`),
        rootIds: [root.id],
        displayName: root.label,
        worktreeLabel: root.label,
        branch: null,
        headOid: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        state: "unavailable" as const,
        message: "Git wurde nicht gefunden. Chat und Gemini funktionieren weiterhin.",
      })),
      changes: [],
    });
  }

  #pruneSnapshots(): void {
    const cutoff = Date.now() - SNAPSHOT_TTL_MS;
    for (const [fileId, snapshot] of this.#fileSnapshots) {
      if (snapshot.createdAt < cutoff) {
        this.#fileSnapshots.delete(fileId);
        if (this.#fileSnapshotIds.get(snapshot.key) === fileId) {
          this.#fileSnapshotIds.delete(snapshot.key);
        }
      }
    }
  }
}

function assertRootRevision(access: ProjectAccess, expected: number): void {
  if (access.rootRevision !== expected) {
    throw new Error("Die Projektordner wurden geändert. Lade die Änderungen für die aktuelle Root-Liste neu.");
  }
}

function assertAreaAvailable(entry: ParsedGitStatusEntry, area: GitArea): void {
  const available = area === "staged"
    ? entry.indexStatus !== "." && !entry.untracked
    : entry.worktreeStatus !== "." || entry.untracked || entry.conflict;
  if (!available) {
    throw new Error("Die angeforderte Diff-Ansicht gehört nicht zu diesem Dateistand.");
  }
}

function buildDiffArgs(
  worktreePath: string,
  entry: ParsedGitStatusEntry,
  area: GitArea,
): string[] {
  const paths = Array.from(
    new Set([entry.previousPath, entry.path].filter((value): value is string => Boolean(value))),
  );
  return [
    "--literal-pathspecs",
    "-c",
    "color.ui=false",
    "-c",
    "core.quotepath=false",
    "-C",
    worktreePath,
    "diff",
    ...(area === "staged" ? ["--cached"] : []),
    "--patch",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=3",
    "--find-renames",
    "--",
    ...paths,
  ];
}

function resolveRepositoryPath(worktreePath: string, gitPath: string): string {
  if (path.posix.isAbsolute(gitPath) || gitPath.includes("\0")) {
    throw new Error("Git returned an unsafe path");
  }
  const absolute = path.resolve(worktreePath, ...gitPath.split("/"));
  const relative = path.relative(worktreePath, absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Git returned a path outside the worktree");
  }
  return absolute;
}

async function fileMetadataSignature(
  worktreePath: string,
  gitPath: string,
): Promise<string> {
  try {
    const metadata = await lstat(resolveRepositoryPath(worktreePath, gitPath));
    return [
      metadata.size,
      metadata.mtimeMs,
      metadata.mode,
      metadata.isSymbolicLink() ? "link" : metadata.isFile() ? "file" : "other",
    ].join(":");
  } catch {
    return "missing";
  }
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  if (sample.includes(0)) return true;
  const decoded = bytes.toString("utf8");
  return !Buffer.from(decoded, "utf8").equals(bytes);
}

function createUntrackedParsedDiff(bytes: Buffer, mode: string): ParsedUnifiedDiff {
  const text = bytes.toString("utf8");
  const hasTrailingNewline = text.endsWith("\n");
  const sourceLines = text.split("\n");
  if (hasTrailingNewline) sourceLines.pop();
  if (sourceLines.length === 1 && sourceLines[0] === "" && bytes.length === 0) {
    sourceLines.length = 0;
  }
  if (
    sourceLines.length > MAX_GIT_DIFF_LINES ||
    sourceLines.some((line) => line.length > 131_072)
  ) {
    throw new DiffLineLimitError();
  }
  const lines: GitDiffLine[] = sourceLines.map((line, index) => ({
    kind: "addition" as const,
    content: line.endsWith("\r") ? line.slice(0, -1) : line,
    oldLine: null,
    newLine: index + 1,
  }));
  if (!hasTrailingNewline && bytes.length > 0) {
    lines.push({
      kind: "no_newline" as const,
      content: "No newline at end of file",
      oldLine: null,
      newLine: null,
    });
  }
  return {
    binary: false,
    additions: sourceLines.length,
    deletions: 0,
    metadata: [`new file mode ${mode}`],
    hunks: sourceLines.length === 0
      ? []
      : [{
          hunkId: createHash("sha256")
            .update(`untracked\0${bytes.length}\0${sourceLines.length}`, "utf8")
            .digest("hex"),
          header: `@@ -0,0 +1,${sourceLines.length} @@`,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: sourceLines.length,
          lines,
        }],
  };
}
