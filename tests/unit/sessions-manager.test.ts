import { mkdtemp, mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NormalizedAgentEvent } from "../../src/main/gemini/index.js";
import { GeminiSessionManager } from "../../src/main/sessions/index.js";

const fakeAgent = resolve("tests/fake-acp-agent/fake-acp-agent.mjs");
const managers: GeminiSessionManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

describe("GeminiSessionManager ACP contract", () => {
  it("spawns one safe child, handles fragmented NDJSON, and brokers exact permissions", async () => {
    const fixture = await workspaceFixture();
    const events: NormalizedAgentEvent[] = [];
    const manager = createManager(fixture, { GEMINI_API_KEY: "secret-for-test" });
    manager.subscribe((event) => {
      events.push(event);
      if (event.type === "permission.requested") {
        manager.respondToPermission({
          appSessionId: "app-1",
          permissionId: event.payload.permissionId,
          optionId: "allow-once",
        });
      }
    });

    const snapshot = await manager.createSession({
      appSessionId: "app-1",
      access: fixture.access,
    });
    expect(snapshot).toMatchObject({
      providerSessionId: "fake-session-1",
      state: "idle",
      capabilities: { loadSession: true, prompt: { image: true } },
      modes: { currentModeId: "default" },
      models: {
        currentModelId: "gemini-2.5-pro",
        availableModels: [
          { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
          { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
        ],
      },
    });

    const result = await manager.prompt("app-1", [
      { type: "text", text: "please stream" },
    ]);
    expect(result.stopReason).toBe("end_turn");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "session.started",
        "session.ready",
        "message.assistant.delta",
        "message.thought.delta",
        "tool.started",
        "permission.requested",
        "permission.resolved",
        "tool.completed",
        "usage.updated",
        "turn.completed",
      ]),
    );
    expect(
      events
        .filter((event) => event.type === "message.assistant.delta")
        .map((event) =>
          event.payload.content.type === "text" ? event.payload.content.text : "",
        )
        .join(""),
    ).toBe("first second");

    const trace = await readTrace(fixture.traceFile);
    expect(trace.find((entry) => entry.kind === "spawn")).toMatchObject({
      argv: [
        "--acp",
        "--skip-trust",
        "--include-directories",
        fixture.additionalRoot,
        "--include-directories",
        fixture.unicodeRoot,
      ],
      cwd: fixture.primaryRoot,
      noRelaunch: "true",
    });
    expect(
      trace.find(
        (entry) =>
          entry.kind === "inbound" &&
          entry.message &&
          typeof entry.message === "object" &&
          "result" in entry.message &&
          JSON.stringify(entry.message).includes("allow-once"),
      ),
    ).toBeTruthy();

    await manager.setMode("app-1", "auto_edit");
    expect(manager.getSession("app-1")?.modes?.currentModeId).toBe("auto_edit");
    await manager.setModel("app-1", "gemini-2.5-flash");
    expect(manager.getSession("app-1")?.models?.currentModelId).toBe(
      "gemini-2.5-flash",
    );
  });

  it("sends semantic session/cancel and waits for the cancelled stop reason", async () => {
    const fixture = await workspaceFixture();
    const manager = createManager(fixture);
    const events: NormalizedAgentEvent[] = [];
    let releaseStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      releaseStarted = resolveStarted;
    });
    manager.subscribe((event) => {
      events.push(event);
      if (
        event.type === "message.assistant.delta" &&
        event.payload.content.type === "text" &&
        event.payload.content.text === "working"
      ) {
        releaseStarted();
      }
    });

    await manager.createSession({ appSessionId: "cancel-app", access: fixture.access });
    const turn = manager.prompt("cancel-app", [
      { type: "text", text: "cancel this turn" },
    ]);
    await started;
    await manager.cancel("cancel-app");
    await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
    expect(events.some((event) => event.type === "turn.cancelled")).toBe(true);

    const trace = await readTrace(fixture.traceFile);
    expect(
      trace.some(
        (entry) =>
          entry.kind === "inbound" &&
          entry.message?.method === "session/cancel" &&
          entry.message?.params?.sessionId === "fake-session-1",
      ),
    ).toBe(true);
  });

  it("surfaces a child crash with bounded, redacted stderr and keeps other sessions isolated", async () => {
    const fixture = await workspaceFixture();
    const manager = createManager(fixture, {
      GEMINI_API_KEY: "secret-for-crash-test",
    });
    let resolveDisconnect!: (event: NormalizedAgentEvent) => void;
    const disconnected = new Promise<NormalizedAgentEvent>((resolveEvent) => {
      resolveDisconnect = resolveEvent;
    });
    manager.subscribe((event) => {
      if (event.type === "process.disconnected") resolveDisconnect(event);
    });

    await manager.createSession({ appSessionId: "crash-app", access: fixture.access });
    await expect(
      manager.prompt("crash-app", [{ type: "text", text: "please crash" }]),
    ).rejects.toThrow();
    const event = await disconnected;
    expect(event).toMatchObject({
      type: "process.disconnected",
      payload: { exitCode: 17 },
    });
    if (event.type === "process.disconnected") {
      expect(event.payload.stderr).toContain("[REDACTED]");
      expect(event.payload.stderr).not.toContain("secret-for-crash-test");
    }
    expect(manager.getSession("crash-app")?.state).toBe("disconnected");
  });

  it("loads provider history in a fresh child and capability-gates image/load operations", async () => {
    const fixture = await workspaceFixture();
    const events: NormalizedAgentEvent[] = [];
    const manager = createManager(fixture);
    manager.subscribe((event) => events.push(event));

    await manager.loadSession({
      appSessionId: "loaded-app",
      providerSessionId: "provider-existing",
      access: fixture.access,
    });
    expect(
      events.some(
        (event) =>
          event.type === "message.assistant.delta" &&
          event.providerSessionId === "provider-existing",
      ),
    ).toBe(true);
    await expect(
      manager.prompt("loaded-app", [
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ]),
    ).resolves.toMatchObject({ stopReason: "end_turn" });

    const noImageFixture = await workspaceFixture();
    const noImageManager = createManager(noImageFixture, { FAKE_ACP_NO_IMAGE: "1" });
    await noImageManager.createSession({
      appSessionId: "no-image",
      access: noImageFixture.access,
    });
    await expect(
      noImageManager.prompt("no-image", [
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ]),
    ).rejects.toMatchObject({ code: "capability_unsupported" });

    const noLoadFixture = await workspaceFixture();
    const noLoadManager = createManager(noLoadFixture, { FAKE_ACP_NO_LOAD: "1" });
    await expect(
      noLoadManager.loadSession({
        appSessionId: "no-load",
        providerSessionId: "provider-existing",
        access: noLoadFixture.access,
      }),
    ).rejects.toMatchObject({ code: "capability_unsupported" });
  });

  it("reports an early CLI startup failure instead of waiting for initialize timeout", async () => {
    const fixture = await workspaceFixture();
    const manager = createManager(fixture, {
      FAKE_ACP_EXIT_BEFORE_INIT: "1",
    });
    const startedAt = Date.now();

    await expect(
      manager.createSession({
        appSessionId: "startup-failure",
        access: fixture.access,
      }),
    ).rejects.toThrow(/authentication is required/i);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});

interface WorkspaceFixture {
  readonly primaryRoot: string;
  readonly additionalRoot: string;
  readonly unicodeRoot: string;
  readonly traceFile: string;
  readonly access: {
    readonly primaryRoot: string;
    readonly additionalRoots: readonly string[];
  };
}

async function workspaceFixture(): Promise<WorkspaceFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gem-ui-acp-")));
  const primaryRoot = join(root, "primary root");
  const additionalRoot = join(root, "shared, root");
  const unicodeRoot = join(root, "zusatz-ö");
  await Promise.all([
    mkdir(primaryRoot),
    mkdir(additionalRoot),
    mkdir(unicodeRoot),
  ]);
  return {
    primaryRoot,
    additionalRoot,
    unicodeRoot,
    traceFile: join(root, "trace.jsonl"),
    access: { primaryRoot, additionalRoots: [additionalRoot, unicodeRoot] },
  };
}

function createManager(
  fixture: WorkspaceFixture,
  extraEnvironment: NodeJS.ProcessEnv = {},
): GeminiSessionManager {
  const manager = new GeminiSessionManager({
    binaryPath: fakeAgent,
    environment: {
      ...process.env,
      FAKE_ACP_TRACE_FILE: fixture.traceFile,
      ...extraEnvironment,
    },
    initializeTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    cancelTimeoutMs: 1_000,
    maxStderrBytes: 256,
  });
  managers.push(manager);
  return manager;
}

async function readTrace(traceFile: string): Promise<any[]> {
  const value = await readFile(traceFile, "utf8");
  return value
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
