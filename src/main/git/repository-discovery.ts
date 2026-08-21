import { realpath } from "node:fs/promises";
import path from "node:path";

import type { ProjectAccess, ProjectRoot } from "../../shared/contracts";
import { runGitCommand } from "./git-command-runner";

export type ReadyRepositoryContext = {
  state: "ready";
  identity: string;
  rootIds: string[];
  displayName: string;
  worktreeLabel: string;
  worktreePath: string;
  gitDir: string;
  gitCommonDir: string;
};

export type UnavailableRepositoryContext = {
  state: "not_git" | "outside_authority" | "error";
  identity: string;
  rootIds: string[];
  displayName: string;
  worktreeLabel: string;
  message: string;
};

export type DiscoveredRepositoryContext =
  | ReadyRepositoryContext
  | UnavailableRepositoryContext;

export async function discoverProjectRepositories(input: {
  access: ProjectAccess;
  binaryPath: string;
  signal?: AbortSignal;
}): Promise<DiscoveredRepositoryContext[]> {
  const roots = [input.access.primaryRoot, ...input.access.additionalRoots];
  const discovered = await Promise.all(
    roots.map((root) => discoverRoot(root, input.binaryPath, input.signal)),
  );
  const deduplicated: DiscoveredRepositoryContext[] = [];
  const readyByIdentity = new Map<string, ReadyRepositoryContext>();

  for (const context of discovered) {
    if (context.state !== "ready") {
      deduplicated.push(context);
      continue;
    }
    const existing = readyByIdentity.get(context.identity);
    if (existing) {
      existing.rootIds.push(...context.rootIds);
      continue;
    }
    readyByIdentity.set(context.identity, context);
    deduplicated.push(context);
  }

  return deduplicated;
}

async function discoverRoot(
  root: ProjectRoot,
  binaryPath: string,
  signal?: AbortSignal,
): Promise<DiscoveredRepositoryContext> {
  const fallback = {
    rootIds: [root.id],
    displayName: root.label,
    worktreeLabel: root.label,
  };
  try {
    const inside = await readRevParse(
      binaryPath,
      root.realPath,
      ["--is-inside-work-tree"],
      signal,
      true,
    );
    if (inside === null || inside !== "true") {
      return {
        ...fallback,
        state: "not_git",
        identity: `not_git:${root.id}`,
        message: "Dieser Projektordner ist kein Git-Worktree.",
      };
    }
    const bare = await readRevParse(
      binaryPath,
      root.realPath,
      ["--is-bare-repository"],
      signal,
    );
    if (bare === "true") {
      return {
        ...fallback,
        state: "not_git",
        identity: `bare:${root.id}`,
        message: "Bare Git-Repositories werden im Diff-Viewer nicht unterstützt.",
      };
    }

    const [reportedTopLevel, reportedGitDir, reportedCommonDir] =
      await Promise.all([
        readRevParse(
          binaryPath,
          root.realPath,
          ["--path-format=absolute", "--show-toplevel"],
          signal,
        ),
        readRevParse(
          binaryPath,
          root.realPath,
          ["--path-format=absolute", "--absolute-git-dir"],
          signal,
        ),
        readRevParse(
          binaryPath,
          root.realPath,
          ["--path-format=absolute", "--git-common-dir"],
          signal,
        ),
      ]);
    if (!reportedTopLevel || !reportedGitDir || !reportedCommonDir) {
      throw new Error("Git repository discovery returned no path");
    }

    const worktreePath = path.normalize(await realpath(reportedTopLevel));
    if (!isWithin(root.realPath, worktreePath)) {
      return {
        ...fallback,
        state: "outside_authority",
        identity: `outside:${root.id}`,
        message:
          "Der ausgewählte Ordner liegt in einem größeren Git-Repository. Füge den Repository-Hauptordner als Projektroot hinzu, um alle Änderungen sicher anzuzeigen.",
      };
    }
    const gitDir = path.normalize(await realpath(reportedGitDir));
    const gitCommonDir = path.normalize(await realpath(reportedCommonDir));
    return {
      state: "ready",
      identity: `${comparisonKey(worktreePath)}\0${comparisonKey(gitDir)}`,
      rootIds: [root.id],
      displayName: path.basename(worktreePath) || root.label,
      worktreeLabel: path.basename(worktreePath) || root.label,
      worktreePath,
      gitDir,
      gitCommonDir,
    };
  } catch {
    return {
      ...fallback,
      state: "error",
      identity: `error:${root.id}`,
      message: "Der Git-Kontext dieses Projektordners konnte nicht geprüft werden.",
    };
  }
}

async function readRevParse(
  binaryPath: string,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  allowFailure = false,
): Promise<string | null> {
  const result = await runGitCommand({
    binaryPath,
    args: ["-C", cwd, "rev-parse", ...args],
    cwd,
    signal,
    readOnly: true,
    timeoutMs: 5_000,
    maxStdoutBytes: 128 * 1024,
    maxStderrBytes: 128 * 1024,
  });
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.aborted ||
    result.tooLarge
  ) {
    if (allowFailure) return null;
    throw new Error("git rev-parse failed");
  }
  return removeOneLineEnding(result.stdout.toString("utf8"));
}

function removeOneLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function isWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function comparisonKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}
