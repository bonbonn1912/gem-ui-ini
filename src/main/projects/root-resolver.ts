import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { MAX_ADDITIONAL_ROOTS } from "../../shared";
import { ProjectRootValidationError } from "./errors";

export type ResolvedRoot = {
  path: string;
  realPath: string;
  label: string;
};

export type ResolvedProjectRootSet = {
  primaryRoot: ResolvedRoot;
  additionalRoots: ResolvedRoot[];
  fingerprint: string;
};

export async function resolveProjectRootSet(input: {
  primaryRootPath: string;
  additionalRootPaths?: readonly string[];
}): Promise<ResolvedProjectRootSet> {
  const additionalPaths = input.additionalRootPaths ?? [];
  if (additionalPaths.length > MAX_ADDITIONAL_ROOTS) {
    throw new ProjectRootValidationError(
      "too_many_additional_roots",
      `At most ${MAX_ADDITIONAL_ROOTS} additional roots are supported`,
    );
  }

  const primaryRoot = await resolveRoot(input.primaryRootPath);
  const additionalRoots = await Promise.all(additionalPaths.map(resolveRoot));
  const roots = [primaryRoot, ...additionalRoots];
  assertNoDuplicateOrOverlappingRoots(roots);

  return {
    primaryRoot,
    additionalRoots,
    fingerprint: computeRootFingerprint(
      primaryRoot.realPath,
      additionalRoots.map((root) => root.realPath),
    ),
  };
}

export async function verifyStoredProjectRootSet(input: {
  primaryRoot: Pick<ResolvedRoot, "path" | "realPath" | "label">;
  additionalRoots: ReadonlyArray<
    Pick<ResolvedRoot, "path" | "realPath" | "label">
  >;
  expectedFingerprint: string;
}): Promise<ResolvedProjectRootSet> {
  const resolved = await resolveProjectRootSet({
    primaryRootPath: input.primaryRoot.path,
    additionalRootPaths: input.additionalRoots.map((root) => root.path),
  });
  const storedRoots = [input.primaryRoot, ...input.additionalRoots];
  const resolvedRoots = [resolved.primaryRoot, ...resolved.additionalRoots];

  for (const [index, root] of resolvedRoots.entries()) {
    const stored = storedRoots[index];
    if (!stored || !canonicalPathsEqual(stored.realPath, root.realPath)) {
      throw new ProjectRootValidationError(
        "root_changed_on_disk",
        `Project root now resolves to a different location: ${stored?.path ?? root.path}`,
        stored?.path ?? root.path,
      );
    }
  }

  if (resolved.fingerprint !== input.expectedFingerprint) {
    throw new ProjectRootValidationError(
      "root_changed_on_disk",
      "The current project root fingerprint differs from the stored authority",
    );
  }

  return resolved;
}

export function computeRootFingerprint(
  primaryRealPath: string,
  additionalRealPaths: readonly string[],
): string {
  const serialized = JSON.stringify({
    version: 1,
    primary: primaryRealPath,
    additional: [...additionalRealPaths],
  });
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function canonicalPathsEqual(left: string, right: string): boolean {
  return comparisonKey(left) === comparisonKey(right);
}

async function resolveRoot(candidate: string): Promise<ResolvedRoot> {
  if (!path.isAbsolute(candidate)) {
    throw new ProjectRootValidationError(
      "root_path_not_absolute",
      `Project roots must be absolute paths: ${candidate}`,
      candidate,
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = path.normalize(await realpath(candidate));
  } catch (error) {
    if (isPermissionError(error)) {
      throw inaccessibleRootError(candidate, error);
    }
    throw new ProjectRootValidationError(
      "root_not_found",
      `Der Projektordner existiert nicht mehr oder wurde verschoben: ${candidate}`,
      candidate,
      { cause: error },
    );
  }

  let metadata;
  try {
    metadata = await stat(canonicalPath);
  } catch (error) {
    if (isPermissionError(error)) {
      throw inaccessibleRootError(candidate, error);
    }
    throw new ProjectRootValidationError(
      "root_not_found",
      `Der Projektordner ist nicht mehr erreichbar: ${candidate}`,
      candidate,
      { cause: error },
    );
  }
  if (!metadata.isDirectory()) {
    throw new ProjectRootValidationError(
      "root_not_directory",
      `Project root is not a directory: ${candidate}`,
      candidate,
    );
  }
  try {
    // realpath/stat alone are insufficient on macOS: a persisted directory can
    // still be unusable as a child-process cwd after its permission grant or an
    // ancestor's traverse permission changed. Check the capabilities Gemini
    // needs before any session process is created or loaded.
    await access(canonicalPath, fsConstants.R_OK | fsConstants.X_OK);
  } catch (error) {
    if (isPermissionError(error)) {
      throw inaccessibleRootError(candidate, error);
    }
    throw new ProjectRootValidationError(
      "root_not_found",
      `Der Projektordner ist nicht mehr erreichbar: ${candidate}`,
      candidate,
      { cause: error },
    );
  }

  return {
    path: path.normalize(candidate),
    realPath: canonicalPath,
    label: path.basename(canonicalPath) || canonicalPath,
  };
}

function inaccessibleRootError(
  candidate: string,
  cause: unknown,
): ProjectRootValidationError {
  return new ProjectRootValidationError(
    "root_not_accessible",
    `GeminUI hat keinen Zugriff auf den Projektordner: ${candidate}. Bitte erteile den Ordnerzugriff erneut oder wähle den Ordner neu aus.`,
    candidate,
    { cause },
  );
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

function assertNoDuplicateOrOverlappingRoots(
  roots: readonly ResolvedRoot[],
): void {
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    const left = roots[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const right = roots[rightIndex];
      if (!right) continue;
      if (comparisonKey(left.realPath) === comparisonKey(right.realPath)) {
        throw new ProjectRootValidationError(
          "duplicate_root",
          `The same directory was selected more than once: ${right.path}`,
          right.path,
        );
      }

      if (
        isDescendant(left.realPath, right.realPath) ||
        isDescendant(right.realPath, left.realPath)
      ) {
        throw new ProjectRootValidationError(
          "overlapping_root",
          `Nested project roots are redundant: ${left.path} and ${right.path}`,
          right.path,
        );
      }
    }
  }
}

function isDescendant(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function comparisonKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}
