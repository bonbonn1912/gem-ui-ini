import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { BoundedTextBuffer } from "./bounded-text-buffer.js";

export interface CapturedCommandInput {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface CapturedCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Executes a fixed argv without a shell and captures bounded diagnostics. */
export function runCapturedCommand(
  input: CapturedCommandInput,
): Promise<CapturedCommandResult> {
  const timeoutMs = input.timeoutMs ?? 5_000;
  const stdout = new BoundedTextBuffer(input.maxOutputBytes ?? 1024 * 1024);
  const stderr = new BoundedTextBuffer(input.maxOutputBytes ?? 1024 * 1024);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(input.binaryPath, [...input.args], {
      // Never inherit Electron's launch cwd. During development or a relaunch
      // that directory may have been moved/deleted, making Node-based CLIs fail
      // in process.cwd() with uv_cwd before they can print their version/help.
      cwd: input.cwd ?? tmpdir(),
      env: input.environment ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
      });
    });
  });
}
