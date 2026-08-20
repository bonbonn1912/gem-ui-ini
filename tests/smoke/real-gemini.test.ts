import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeGeminiBinary } from "../../src/main/gemini/binary-probe";
import { GeminiSessionManager } from "../../src/main/sessions/gemini-session-manager";
import { spawnGeminiProcess } from "../../src/main/processes/gemini-process";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const realGeminiTest = process.env.REAL_GEMINI_SMOKE === "1" ? test : test.skip;

realGeminiTest(
  "installed Gemini CLI completes an ACP multi-root handshake",
  async () => {
    const probe = await probeGeminiBinary();
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;

    const root = await mkdtemp(path.join(os.tmpdir(), "gem-ui-real-acp-"));
    temporaryDirectories.push(root);
    const primaryRoot = path.join(root, "primary");
    const additionalRootA = path.join(root, "additional-a");
    const additionalRootB = path.join(root, "additional-b");
    await Promise.all(
      [primaryRoot, additionalRootA, additionalRootB].map((directory) =>
        mkdir(directory),
      ),
    );

    const manager = new GeminiSessionManager({
      binaryPath: probe.executablePath,
      binaryArgs: probe.executableArgs,
      initializeTimeoutMs: 20_000,
      requestTimeoutMs: 20_000,
      processSpawner: (input) => {
        const processHandle = spawnGeminiProcess(input);
        const diagnosticTimer = setInterval(() => {
          const diagnostic = processHandle.stderrSnippet().trim();
          if (diagnostic) console.warn(`[real-gemini stderr] ${diagnostic}`);
        }, 2_000);
        diagnosticTimer.unref();
        processHandle.exited.finally(() => clearInterval(diagnosticTimer));
        return processHandle;
      },
    });
    manager.subscribe((event) => {
      if (event.type === "process.disconnected" || event.type === "session.failed") {
        console.warn(`[real-gemini ${event.type}] ${JSON.stringify(event.payload)}`);
      }
    });
    try {
      const session = await manager.createSession({
        appSessionId: "real-gemini-smoke",
        access: {
          primaryRoot,
          additionalRoots: [additionalRootA, additionalRootB],
        },
      });
      expect(session.providerSessionId).toBeTruthy();
      expect(session.state).toBe("idle");
    } finally {
      await manager.dispose();
    }
  },
  30_000,
);
