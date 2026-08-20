import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  BoundedTextBuffer,
  buildGeminiAcpArgs,
  redactDiagnosticText,
  runCapturedCommand,
  spawnGeminiProcess,
  type GeminiSpawn,
} from "../../src/main/processes/index.js";

describe("Gemini process arguments", () => {
  it("uses cwd separately and emits one flag/value pair per additional root", () => {
    expect(
      buildGeminiAcpArgs({
        primaryRoot: "/workspace/main project",
        additionalRoots: [
          "/workspace/shared lib",
          "/workspace/überraschung",
          "/workspace/with,comma",
        ],
      }),
    ).toEqual([
      "--acp",
      "--skip-trust",
      "--include-directories",
      "/workspace/shared lib",
      "--include-directories",
      "/workspace/überraschung",
      "--include-directories",
      "/workspace/with,comma",
    ]);
  });

  it("rejects relative, duplicate, and excessive roots before spawn", () => {
    expect(() =>
      buildGeminiAcpArgs({ primaryRoot: "relative", additionalRoots: [] }),
    ).toThrow(/absolute/i);
    expect(() =>
      buildGeminiAcpArgs({
        primaryRoot: "/workspace/main",
        additionalRoots: ["/workspace/main"],
      }),
    ).toThrow(/unique/i);
    expect(() =>
      buildGeminiAcpArgs({
        primaryRoot: "/workspace/main",
        additionalRoots: Array.from({ length: 6 }, (_, index) => `/root-${index}`),
      }),
    ).toThrow(/at most 5/i);
  });

  it("does not start Gemini when a reloaded project's cwd disappeared", () => {
    const primaryRoot = mkdtempSync(join(tmpdir(), "gem-ui-stale-cwd-"));
    rmSync(primaryRoot, { recursive: true });
    const spawn = vi.fn(() => {
      throw new Error("spawn must not be reached");
    }) as unknown as GeminiSpawn;

    expect(() =>
      spawnGeminiProcess(
        {
          binaryPath: "/usr/bin/gemini",
          access: { primaryRoot, additionalRoots: [] },
        },
        spawn,
      ),
    ).toThrow(/existiert nicht mehr|verschoben/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("captured command cwd", () => {
  it("uses a stable neutral cwd when a probe does not provide one", async () => {
    const result = await runCapturedCommand({
      binaryPath: process.execPath,
      args: ["-e", "process.stdout.write(process.cwd())"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(realpathSync(tmpdir()));
  });
});

describe("bounded child diagnostics", () => {
  it("retains only the newest bytes", () => {
    const buffer = new BoundedTextBuffer(8);
    buffer.append("12345");
    buffer.append("67890");
    expect(buffer.toString()).toBe("34567890");
  });

  it("redacts assignments, bearer tokens, and explicit environment secrets", () => {
    expect(
      redactDiagnosticText(
        "GEMINI_API_KEY=secret-value Bearer abc.def token-is-here",
        ["token-is-here"],
      ),
    ).toBe("GEMINI_API_KEY=[REDACTED] Bearer [REDACTED] [REDACTED]");
  });
});
