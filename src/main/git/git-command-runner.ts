import { spawn } from "node:child_process";

export const GIT_STATUS_OUTPUT_LIMIT = 10 * 1024 * 1024;
export const GIT_DIFF_OUTPUT_LIMIT = 5 * 1024 * 1024;
export const GIT_STDERR_LIMIT = 256 * 1024;

export type GitCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  aborted: boolean;
  tooLarge: boolean;
};

export type GitCommandInput = {
  binaryPath: string;
  args: readonly string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  stdin?: Buffer;
  signal?: AbortSignal;
  readOnly?: boolean;
};

/** Captures complete Git output or fails closed once a byte limit is crossed. */
export function runGitCommand(input: GitCommandInput): Promise<GitCommandResult> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const maxStdoutBytes = input.maxStdoutBytes ?? GIT_STATUS_OUTPUT_LIMIT;
  const maxStderrBytes = input.maxStderrBytes ?? GIT_STDERR_LIMIT;

  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let tooLarge = false;
    let settled = false;

    const child = spawn(input.binaryPath, [...input.args], {
      cwd: input.cwd,
      env: {
        ...(input.environment ?? process.env),
        GIT_PAGER: "cat",
        PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        ...(input.readOnly ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
      },
      shell: false,
      windowsHide: true,
      stdio: [input.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });

    const stop = () => {
      if (!child.killed) child.kill("SIGKILL");
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdoutBytes) {
        tooLarge = true;
        stdout.length = 0;
        stop();
        return;
      }
      stdout.push(chunk);
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxStderrBytes) {
        tooLarge = true;
        stderr.length = 0;
        stop();
        return;
      }
      stderr.push(chunk);
    });

    if (input.stdin) {
      child.stdin!.end(input.stdin);
    }

    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode,
        signal,
        stdout: tooLarge ? Buffer.alloc(0) : Buffer.concat(stdout, stdoutBytes),
        stderr: tooLarge ? Buffer.alloc(0) : Buffer.concat(stderr, stderrBytes),
        timedOut,
        aborted,
        tooLarge,
      });
    });
  });
}
