import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";

import { GeminiIntegrationError } from "../gemini/errors.js";
import type { ProjectAccess } from "../gemini/types.js";
import {
  BoundedTextBuffer,
  environmentSecrets,
} from "./bounded-text-buffer.js";

export const MAX_ADDITIONAL_ROOTS = 5;

export function validateProjectAccess(access: ProjectAccess): void {
  if (!isAbsolute(access.primaryRoot)) {
    throw new GeminiIntegrationError(
      "invalid_project_access",
      "The primary Gemini root must be an absolute path",
      { details: { primaryRoot: access.primaryRoot } },
    );
  }
  if (access.additionalRoots.length > MAX_ADDITIONAL_ROOTS) {
    throw new GeminiIntegrationError(
      "invalid_project_access",
      `At most ${MAX_ADDITIONAL_ROOTS} additional roots are supported`,
    );
  }

  const seen = new Set<string>([access.primaryRoot]);
  for (const root of access.additionalRoots) {
    if (!isAbsolute(root)) {
      throw new GeminiIntegrationError(
        "invalid_project_access",
        "Every additional Gemini root must be an absolute path",
        { details: { root } },
      );
    }
    if (seen.has(root)) {
      throw new GeminiIntegrationError(
        "invalid_project_access",
        "Gemini workspace roots must be unique",
        { details: { root } },
      );
    }
    seen.add(root);
  }
}

export function buildGeminiAcpArgs(access: ProjectAccess): string[] {
  validateProjectAccess(access);
  // Folder selection in GeminUI is the explicit trust decision. Gemini's own
  // terminal trust prompt cannot be answered over ACP and would otherwise
  // block before initialize for a newly selected directory.
  const args = ["--acp", "--skip-trust"];
  for (const root of access.additionalRoots) {
    args.push("--include-directories", root);
  }
  return args;
}

/** Last, synchronous guard against a stale cwd between async root validation and spawn. */
export function assertUsableProjectAccess(access: ProjectAccess): void {
  validateProjectAccess(access);
  assertUsableDirectory(access.primaryRoot, "Hauptordner");
  for (const root of access.additionalRoots) {
    assertUsableDirectory(root, "Zusatzordner");
  }
}

export interface GeminiProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

export interface GeminiProcessHandle {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly exited: Promise<GeminiProcessExit>;
  stderrSnippet(): string;
  onStderr(listener: () => void): () => void;
  terminate(graceMs?: number): Promise<GeminiProcessExit>;
  onExit(listener: (result: GeminiProcessExit) => void): () => void;
}

export interface SpawnGeminiProcessInput {
  readonly binaryPath: string;
  readonly binaryArgs?: readonly string[];
  readonly access: ProjectAccess;
  readonly environment?: NodeJS.ProcessEnv;
  readonly maxStderrBytes?: number;
}

export type GeminiSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & {
    readonly stdio: readonly ["pipe", "pipe", "pipe"];
  },
) => ChildProcessWithoutNullStreams;

const nodeSpawn: GeminiSpawn = (command, args, options) =>
  spawn(command, [...args], options) as ChildProcessWithoutNullStreams;

export class SpawnedGeminiProcess implements GeminiProcessHandle {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly exited: Promise<GeminiProcessExit>;

  private readonly stderrBuffer: BoundedTextBuffer;
  private readonly secrets: readonly string[];
  private readonly exitListeners = new Set<(result: GeminiProcessExit) => void>();
  private readonly stderrListeners = new Set<() => void>();
  private exitResult?: GeminiProcessExit;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    environment: NodeJS.ProcessEnv,
    maxStderrBytes: number,
  ) {
    this.pid = child.pid;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderrBuffer = new BoundedTextBuffer(maxStderrBytes);
    this.secrets = environmentSecrets(environment);
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer.append(chunk);
      for (const listener of this.stderrListeners) listener();
    });

    this.exited = new Promise((resolve) => {
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (exitCode, signal) => {
        const result: GeminiProcessExit = {
          exitCode,
          signal,
          ...(spawnError ? { error: spawnError } : {}),
        };
        this.exitResult = result;
        for (const listener of this.exitListeners) {
          listener(result);
        }
        this.exitListeners.clear();
        this.stderrListeners.clear();
        resolve(result);
      });
    });
  }

  stderrSnippet(): string {
    return this.stderrBuffer.toString(this.secrets);
  }

  onStderr(listener: () => void): () => void {
    if (this.exitResult) return () => undefined;
    this.stderrListeners.add(listener);
    if (this.stderrBuffer.toString().length > 0) {
      queueMicrotask(() => {
        if (this.stderrListeners.has(listener)) listener();
      });
    }
    return () => this.stderrListeners.delete(listener);
  }

  onExit(listener: (result: GeminiProcessExit) => void): () => void {
    if (this.exitResult) {
      queueMicrotask(() => listener(this.exitResult!));
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async terminate(graceMs = 1_500): Promise<GeminiProcessExit> {
    if (this.exitResult) return this.exitResult;

    this.stdin.end();
    this.child.kill("SIGTERM");
    const graceful = await Promise.race([
      this.exited.then((result) => ({ result })),
      delay(graceMs).then(() => ({})),
    ]);
    if ("result" in graceful && graceful.result) {
      return graceful.result;
    }

    this.child.kill("SIGKILL");
    return this.exited;
  }
}

export function spawnGeminiProcess(
  input: SpawnGeminiProcessInput,
  spawnImplementation: GeminiSpawn = nodeSpawn,
): GeminiProcessHandle {
  // Keep this immediately before argument construction/spawn. ProjectService
  // validates persisted roots asynchronously, but a directory can be removed
  // or lose permissions in that small interval.
  assertUsableProjectAccess(input.access);
  const args = [
    ...(input.binaryArgs ?? []),
    ...buildGeminiAcpArgs(input.access),
  ];
  // The npm Gemini launcher otherwise relaunches itself with inherited stdio.
  // That wrapper can swallow early ACP input and signals when it is spawned
  // behind pipes. Running the actual CLI in the first process keeps stdin,
  // stdout and lifecycle ownership deterministic for desktop clients.
  const environment = {
    ...(input.environment ?? process.env),
    GEMINI_CLI_NO_RELAUNCH: "true",
  };
  const child = spawnImplementation(input.binaryPath, args, {
    cwd: input.access.primaryRoot,
    env: environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"] as const,
    windowsHide: true,
  });

  return new SpawnedGeminiProcess(
    child,
    environment,
    input.maxStderrBytes ?? 64 * 1024,
  );
}

function assertUsableDirectory(
  directory: string,
  role: "Hauptordner" | "Zusatzordner",
): void {
  try {
    const canonicalPath = realpathSync(directory);
    if (!statSync(canonicalPath).isDirectory()) {
      throw new Error("not_a_directory");
    }
    accessSync(canonicalPath, fsConstants.R_OK | fsConstants.X_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const reason =
      code === "EACCES" || code === "EPERM"
        ? "GeminUI hat keinen Zugriff mehr darauf"
        : code === "ENOENT"
          ? "er existiert nicht mehr oder wurde verschoben"
          : "er kann nicht als Arbeitsordner verwendet werden";
    throw new GeminiIntegrationError(
      "invalid_project_access",
      `Der Gemini-${role} ist nicht verfügbar (${reason}): ${directory}. Bitte prüfe den Projektordner und wähle ihn bei Bedarf erneut aus.`,
      { cause: error, details: { directory, role, code } },
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
