import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectGeminiCliFeatures,
  parseGeminiVersion,
  probeGeminiBinary,
  resolveGeminiLaunch,
} from "../../src/main/gemini/index.js";

const fakeAgent = resolve("tests/fake-acp-agent/fake-acp-agent.mjs");

describe("Gemini binary probe", () => {
  it("probes version and advertised flags without a shell", async () => {
    const result = await probeGeminiBinary({ candidate: fakeAgent });
    expect(result).toMatchObject({
      ok: true,
      version: "0.56.0",
      features: {
        acp: true,
        includeDirectories: true,
        resume: true,
        listSessions: true,
        deleteSession: true,
        approvalMode: true,
      },
    });
    if (result.ok) expect(result.binaryPath).toBe(await realpath(fakeAgent));
  });

  it("returns a renderer-safe failure for a missing binary", async () => {
    const result = await probeGeminiBinary({
      candidate: "/definitely/missing/gemini",
    });
    expect(result).toMatchObject({ ok: false, code: "binary_not_found" });
  });

  it("parses preview versions and feature-detects the legacy ACP flag", () => {
    expect(parseGeminiVersion("Gemini CLI 0.57.0-preview.2")).toBe(
      "0.57.0-preview.2",
    );
    expect(detectGeminiCliFeatures("  --experimental-acp\n  --resume <id>"))
      .toMatchObject({ acp: true, resume: true });
  });

  it("resolves the standard Windows npm .cmd shim without invoking a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "gem-ui-win-launch-"));
    try {
      const npmBin = join(root, "npm bin");
      const packageRoot = join(
        npmBin,
        "node_modules",
        "@google",
        "gemini-cli",
      );
      const entry = join(packageRoot, "bundle", "gemini.js");
      const shim = join(npmBin, "gemini.cmd");
      const node = join(root, "node bin", "node.EXE");
      await mkdir(join(packageRoot, "bundle"), { recursive: true });
      await mkdir(join(root, "node bin"), { recursive: true });
      await writeFile(shim, "this shim must never be executed");
      await writeFile(node, "not executed by this resolver test");
      await writeFile(entry, "console.log('not executed')");
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@google/gemini-cli",
          bin: { gemini: "bundle/gemini.js" },
        }),
      );

      await expect(
        resolveGeminiLaunch(
          shim,
          { PATH: join(root, "node bin"), PATHEXT: ".EXE;.CMD" },
          "win32",
        ),
      ).resolves.toEqual({
        executablePath: await realpath(node),
        executableArgs: [await realpath(entry)],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
