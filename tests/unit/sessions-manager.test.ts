import { mkdtemp, mkdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { GeminiProcessSpawner, NormalizedAgentEvent } from "../../src/main/gemini/index.js";
import { spawnGeminiProcess } from "../../src/main/processes/index.js";
import { GeminiSessionManager, isMissingProviderSessionError } from "../../src/main/sessions/index.js";

const fakeAgent = resolve("tests/fake-acp-agent/fake-acp-agent.mjs");
const managers: GeminiSessionManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

describe("GeminiSessionManager ACP contract", () => {
  it("keeps ten simultaneous starts within the atomic process budget", async () => {
    const fixture = await workspaceFixture();
    let active = 0;
    let peak = 0;
    const spawner: GeminiProcessSpawner = (input) => {
      const child = spawnGeminiProcess(input);
      active += 1;
      peak = Math.max(peak, active);
      let countedExit = false;
      child.onExit(() => {
        if (!countedExit) { countedExit = true; active -= 1; }
      });
      return child;
    };
    const manager = new GeminiSessionManager({
      binaryPath: process.execPath,
      binaryArgs: [fakeAgent],
      processSpawner: spawner,
      environment: { ...process.env, FAKE_ACP_TRACE_FILE: fixture.traceFile },
      resourceProfile: "balanced",
    });
    managers.push(manager);
    await Promise.all(Array.from({ length: 10 }, (_, index) => manager.createSession({
      appSessionId: `budget-${index}`, access: fixture.access,
    })));
    expect(peak).toBeLessThanOrEqual(2);
    expect((await readTrace(fixture.traceFile)).filter((entry) => entry.kind === "spawn")).toHaveLength(10);
    expect(manager.listActiveSessions().length).toBeLessThanOrEqual(2);
  });

  it("aborts a pending handshake and waits for its child during manager disposal", async () => {
    const fixture = await workspaceFixture();
    const manager = createManager(fixture, { FAKE_ACP_INITIALIZE_DELAY_MS: "5000" });
    const opening = manager.createSession({ appSessionId: "pending-open", access: fixture.access });
    await expect.poll(async () => {
      try { return (await readTrace(fixture.traceFile)).some((entry) => entry.kind === "spawn"); }
      catch { return false; }
    }).toBe(true);
    const startedAt = Date.now();
    await manager.dispose();
    managers.splice(managers.indexOf(manager), 1);
    await expect(opening).rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

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
    // Gemini CLI 0.56 sends neither usage_update nor PromptResponse.usage; the
    // counters only exist inside _meta.quota.
    expect(result.usage).toMatchObject({
      scope: "turn",
      source: "gemini_meta_quota",
      tokens: { input: 4, output: 6, total: 10, totalKind: "derived_input_plus_output" },
      byModel: [{ model: "gemini-2.5-pro", input: 4, output: 6 }],
    });
    const usageIndex = events.findIndex((event) => event.type === "usage.tokens.observed");
    const completedIndex = events.findIndex((event) => event.type === "turn.completed");
    // The observation must arrive before turn.completed so the controller can
    // still attribute it to the active turn.
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeLessThan(completedIndex);
    expect(events.some((event) => event.type === "usage.context.observed")).toBe(false);
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
        "usage.tokens.observed",
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

    await manager.setMode("app-1", "autoEdit");
    expect(manager.getSession("app-1")?.modes?.currentModeId).toBe("autoEdit");
    await manager.setModel("app-1", "gemini-2.5-flash");
    expect(manager.getSession("app-1")?.models?.currentModelId).toBe(
      "gemini-2.5-flash",
    );
  });

  it("passes a fully ACP-compliant agent through without a Gemini special case", async () => {
    const fixture = await workspaceFixture();
    const events: NormalizedAgentEvent[] = [];
    const manager = createManager(fixture, { FAKE_ACP_USAGE_MODE: "acp_full" });
    manager.subscribe((event) => {
      events.push(event);
      if (event.type === "permission.requested") {
        manager.respondToPermission({
          appSessionId: "acp-full",
          permissionId: event.payload.permissionId,
          optionId: "allow-once",
        });
      }
    });

    await manager.createSession({ appSessionId: "acp-full", access: fixture.access });
    await manager.prompt("acp-full", [{ type: "text", text: "please stream" }]);

    const context = events.find((event) => event.type === "usage.context.observed");
    expect(context?.payload).toMatchObject({ used: 10, size: 100 });
    const tokens = events.find((event) => event.type === "usage.tokens.observed");
    expect(tokens?.payload).toMatchObject({
      scope: "session_cumulative",
      source: "acp_prompt_usage",
      tokens: { input: 4, output: 6, total: 10, totalKind: "provider" },
    });
  });

  it("auto-approves permission requests while Developer (yolo) is active", async () => {
    const fixture = await workspaceFixture();
    const events: NormalizedAgentEvent[] = [];
    const manager = createManager(fixture);
    manager.subscribe((event) => events.push(event));

    await manager.createSession({ appSessionId: "yolo-app", access: fixture.access });
    await manager.setMode("yolo-app", "yolo");
    const result = await manager.prompt("yolo-app", [
      { type: "text", text: "please stream" },
    ]);

    expect(result.stopReason).toBe("end_turn");
    // Nothing may reach the UI: the request is answered like the first allow
    // option, without ever becoming a pending permission.
    expect(events.some((event) => event.type === "permission.requested")).toBe(false);
    const trace = await readTrace(fixture.traceFile);
    const approval = trace.find(
      (entry) =>
        entry.kind === "inbound" &&
        entry.message &&
        typeof entry.message === "object" &&
        typeof entry.message.id === "string" &&
        entry.message.id.startsWith("fake-permission-"),
    );
    expect(approval?.message.result).toMatchObject({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  it("stays silent instead of inventing usage when an agent reports none", async () => {
    const fixture = await workspaceFixture();
    const events: NormalizedAgentEvent[] = [];
    const manager = createManager(fixture, { FAKE_ACP_USAGE_MODE: "none" });
    manager.subscribe((event) => events.push(event));

    await manager.createSession({ appSessionId: "no-usage", access: fixture.access });
    const result = await manager.prompt("no-usage", [{ type: "text", text: "hello" }]);

    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toBeUndefined();
    expect(events.some((event) => event.type.startsWith("usage."))).toBe(false);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
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
          event.type === "session.started" &&
          event.providerSessionId === "provider-existing",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "session.ready" &&
          event.providerSessionId === "provider-existing",
      ),
    ).toBe(true);
    // session/load restores provider context but may replay old transcript
    // notifications. Those must stay suppressed to avoid duplicate timeline
    // messages; fresh output starts with the next user prompt below.
    expect(events.some((event) => event.type === "message.assistant.delta")).toBe(false);
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

  it("lists provider sessions by cursor and gates provider deletion on ACP capabilities", async () => {
    const fixture = await workspaceFixture();
    const manager = createManager(fixture, { FAKE_ACP_SESSION_LIST_DELETE: "1" });
    await manager.createSession({ appSessionId: "provider-admin", access: fixture.access });
    const first = await manager.listProviderSessions("provider-admin", { cwd: fixture.primaryRoot });
    expect(first).toMatchObject({ sessions: [{ sessionId: "provider-page-1" }], nextCursor: "page-two" });
    await expect(manager.listProviderSessions("provider-admin", { cursor: first.nextCursor! })).resolves.toMatchObject({
      sessions: [{ sessionId: "provider-page-2" }],
    });
    await manager.deleteProviderSession("provider-admin", "provider-page-2");

    const unsupportedFixture = await workspaceFixture();
    const unsupported = createManager(unsupportedFixture);
    await unsupported.createSession({ appSessionId: "no-provider-admin", access: unsupportedFixture.access });
    await expect(unsupported.listProviderSessions("no-provider-admin", {})).rejects.toMatchObject({ code: "capability_unsupported" });
    await expect(unsupported.deleteProviderSession("no-provider-admin", "id")).rejects.toMatchObject({ code: "capability_unsupported" });
  });

  it("reads and switches models on an agent that still speaks the legacy models API", async () => {
    // Gemini CLI pins @agentclientprotocol/sdk 0.16.x: session/new answers with
    // a dedicated `models` object instead of `configOptions`, and the switch is
    // session/set_model. Reading configOptions alone left the model picker
    // permanently empty against the real CLI.
    const fixture = await workspaceFixture();
    const manager = createManager(fixture, { FAKE_ACP_LEGACY_MODELS: "1" });

    const snapshot = await manager.createSession({
      appSessionId: "legacy-models",
      access: fixture.access,
    });
    expect(snapshot.models).toEqual({
      transport: "legacy_models",
      configId: null,
      currentModelId: "gemini-2.5-pro",
      availableModels: [
        { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      ],
    });

    await manager.setModel("legacy-models", "gemini-2.5-flash");
    expect(manager.getSession("legacy-models")?.models?.currentModelId).toBe(
      "gemini-2.5-flash",
    );
    const trace = await readTrace(fixture.traceFile);
    expect(
      trace.some((entry) => JSON.stringify(entry.message ?? {}).includes("session/set_model")),
    ).toBe(true);

    await expect(
      manager.setModel("legacy-models", "gemini-1.0-nonexistent"),
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

describe("isMissingProviderSessionError", () => {
  it("recognises a vanished Gemini session behind an ACP internal error", () => {
    // Gemini 0.59 answers session/load with -32603 "Internal error" and moves
    // the SessionError text into data.details.
    const requestError = Object.assign(new Error("Internal error"), {
      name: "RequestError",
      code: -32603,
      data: {
        details:
          'Invalid session identifier "afaff2c3-2a59-42da-a539-c27ac476e2d7".\n' +
          "  Searched for sessions in /tmp/chats.\n" +
          "  Use --list-sessions to see available sessions.",
      },
    });
    expect(isMissingProviderSessionError(requestError)).toBe(true);
  });

  it("recognises an empty Gemini session store", () => {
    const requestError = Object.assign(new Error("Internal error"), {
      name: "RequestError",
      code: -32603,
      data: { details: "No previous sessions found for this project." },
    });
    expect(isMissingProviderSessionError(requestError)).toBe(true);
  });

  it("recognises raw SessionError codes and plain session-not-found messages", () => {
    expect(
      isMissingProviderSessionError(
        Object.assign(new Error("Invalid session identifier \"x\""), {
          name: "SessionError",
          code: "INVALID_SESSION_IDENTIFIER",
        }),
      ),
    ).toBe(true);
    expect(
      isMissingProviderSessionError(new Error("Session not found: fake-session-1")),
    ).toBe(true);
  });

  it("keeps auth, transport and unrelated params failures retryable", () => {
    expect(
      isMissingProviderSessionError(
        Object.assign(new Error("Authentication required"), {
          code: -32000,
          data: { details: "Please set an Auth method before running." },
        }),
      ),
    ).toBe(false);
    expect(isMissingProviderSessionError(new Error("ACP connection closed"))).toBe(false);
    expect(
      isMissingProviderSessionError(
        Object.assign(new Error("Invalid params"), {
          code: -32602,
          data: { details: "Invalid or unavailable mode: yolo" },
        }),
      ),
    ).toBe(false);
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
    // Mirrors the production wiring (CapabilityService forwards the probed
    // executablePath/executableArgs): a JavaScript entry point is started via
    // node instead of its shebang. Windows has no shebang support and rejects
    // a direct spawn of the .mjs agent with EFTYPE.
    binaryPath: process.execPath,
    binaryArgs: [fakeAgent],
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
