import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GeminiBinaryProbeResult } from "../../src/main/gemini/types";

const probes = vi.hoisted(() => ({ gemini: vi.fn(), git: vi.fn() }));
vi.mock("../../src/main/gemini", () => ({ probeGeminiBinary: probes.gemini }));
vi.mock("../../src/main/git", () => ({ probeGitBinary: probes.git }));
import { GeminiCapabilityService } from "../../src/main/capability-service";
import type { SettingsRepository } from "../../src/main/storage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function success(binaryPath: string): GeminiBinaryProbeResult {
  return {
    ok: true, binaryPath, executablePath: binaryPath, executableArgs: [],
    version: "0.61.0", rawVersion: "0.61.0",
    features: { acp: true, acpFlag: "--acp", skipTrust: true, includeDirectories: true,
      resume: true, listSessions: true, deleteSession: true, approvalMode: true },
  };
}
function service() {
  const settings = {
    getGeminiSettings: vi.fn(() => null), getGitSettings: vi.fn(() => null),
    setGeminiBinaryPath: vi.fn(), setGitBinaryPath: vi.fn(),
    get: vi.fn(() => null), set: vi.fn(),
  };
  return { settings, capabilities: new GeminiCapabilityService(settings as unknown as SettingsRepository, "0.16.0") };
}

describe("capability selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    probes.git.mockResolvedValue({ ok: true, binaryPath: "/git", version: "2.50.0" });
  });
  it("keeps the latest selection when an earlier probe finishes last", async () => {
    const a = deferred<GeminiBinaryProbeResult>();
    const b = deferred<GeminiBinaryProbeResult>();
    probes.gemini.mockImplementation(({ candidate }) => candidate === "/a" ? a.promise : b.promise);
    const { settings, capabilities } = service();
    const first = capabilities.choose("/a");
    const second = capabilities.choose("/b");
    b.resolve(success("/b")); await second;
    a.resolve(success("/a")); await first;
    expect(capabilities.snapshot().gemini.binaryPath).toBe("/b");
    expect(settings.setGeminiBinaryPath.mock.calls).toEqual([["/b"]]);
  });
  it("deduplicates matching candidates while allowing a new candidate to start", async () => {
    const a = deferred<GeminiBinaryProbeResult>();
    const b = deferred<GeminiBinaryProbeResult>();
    probes.gemini.mockImplementation(({ candidate }) => candidate === "/a" ? a.promise : b.promise);
    const { capabilities } = service();
    const requests = [capabilities.refresh("/a"), capabilities.refresh("/a"), capabilities.refresh("/b")];
    expect(probes.gemini).toHaveBeenCalledTimes(2);
    a.resolve(success("/a")); b.resolve(success("/b"));
    await Promise.all(requests);
    expect(capabilities.snapshot().gemini.binaryPath).toBe("/b");
  });
  it("does not infer ACP session capabilities from CLI help", async () => {
    probes.gemini.mockResolvedValue(success("/gemini"));
    const { capabilities } = service();
    expect(capabilities.snapshot().gemini.probeState).toBe("checking");
    await capabilities.refresh();
    expect(capabilities.snapshot().gemini).toMatchObject({
      probeState: "ready", available: true, negotiated: false,
      sessionLoad: false, images: false, modes: false, models: false,
    });
  });
});
