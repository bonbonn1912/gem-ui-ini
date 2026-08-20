import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type {
  ClientConnection,
  ContentBlock,
  InitializeResponse,
  PromptResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import {
  NdjsonLineGuard,
  spawnGeminiProcess,
  type GeminiProcessHandle,
  type SpawnGeminiProcessInput,
} from "../processes/index.js";
import {
  normalizeCapabilities,
  normalizeModes,
  normalizeModels,
} from "./capabilities.js";
import { GeminiIntegrationError, toErrorMessage } from "./errors.js";
import { normalizeSessionNotification } from "./event-normalizer.js";
import { PermissionBroker } from "./permission-broker.js";
import type {
  AgentEventListener,
  GeminiSessionSnapshot,
  GeminiTurnResult,
  NormalizedAcpCapabilities,
  NormalizedAgentEvent,
  PermissionRequest,
  ProjectAccess,
  PromptPart,
  SessionModeSnapshot,
} from "./types.js";

export type GeminiProcessSpawner = (
  input: SpawnGeminiProcessInput,
) => GeminiProcessHandle;

export interface GeminiAcpSessionInput {
  readonly appSessionId: string;
  readonly binaryPath: string;
  readonly binaryArgs?: readonly string[];
  readonly access: ProjectAccess;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onEvent?: AgentEventListener;
  readonly processSpawner?: GeminiProcessSpawner;
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly cancelTimeoutMs?: number;
  readonly maxStderrBytes?: number;
  readonly maxProtocolLineBytes?: number;
}

export interface LoadGeminiAcpSessionInput extends GeminiAcpSessionInput {
  readonly providerSessionId: string;
}

type SessionState = GeminiSessionSnapshot["state"];

/** One stable ACP v1 connection and exactly one Gemini provider session. */
export class GeminiAcpSession {
  readonly appSessionId: string;
  readonly access: ProjectAccess;

  private readonly onEvent?: AgentEventListener;
  private readonly process: GeminiProcessHandle;
  private readonly permissionBroker: PermissionBroker;
  private readonly initializeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly protocolGuard: NdjsonLineGuard;

  private connection?: ClientConnection;
  private capabilitiesValue!: NormalizedAcpCapabilities;
  private modesValue?: SessionModeSnapshot;
  private modelsValue?: import("./types.js").SessionModelSnapshot;
  private providerSessionIdValue: string | null;
  private stateValue: SessionState = "idle";
  private activeTurn?: Promise<GeminiTurnResult>;
  private disposing = false;
  private disposePromise?: Promise<void>;
  private disconnectedEmitted = false;
  private initializationComplete = false;
  private unsubscribeStderr?: () => void;

  private constructor(
    input: GeminiAcpSessionInput,
    providerSessionId: string | null,
  ) {
    this.appSessionId = input.appSessionId;
    this.access = input.access;
    this.onEvent = input.onEvent;
    this.providerSessionIdValue = providerSessionId;
    this.initializeTimeoutMs = input.initializeTimeoutMs ?? 10_000;
    this.requestTimeoutMs = input.requestTimeoutMs ?? 30_000;
    this.cancelTimeoutMs = input.cancelTimeoutMs ?? 3_000;

    const spawnProcess = input.processSpawner ?? spawnGeminiProcess;
    this.process = spawnProcess({
      binaryPath: input.binaryPath,
      binaryArgs: input.binaryArgs,
      access: input.access,
      environment: input.environment,
      maxStderrBytes: input.maxStderrBytes,
    });

    this.protocolGuard = new NdjsonLineGuard(
      input.maxProtocolLineBytes ?? 32 * 1024 * 1024,
    );
    this.process.stdout.pipe(this.protocolGuard);
    this.protocolGuard.once("error", (error) => {
      void this.handleTransportFailure(error);
    });

    this.permissionBroker = new PermissionBroker({
      appSessionId: input.appSessionId,
      onRequested: (request) => this.handlePermissionRequested(request),
      onResolved: (resolution) => {
        this.emit("permission.resolved", resolution);
        if (this.stateValue === "awaiting_permission" && this.permissionBroker.size === 0) {
          this.stateValue = this.activeTurn ? "running" : "idle";
        }
      },
    });

    this.process.onExit((exit) => this.handleProcessExit(exit));
    this.unsubscribeStderr = this.process.onStderr(() => {
      if (this.initializationComplete || this.disposing) return;
      const diagnostic = this.process.stderrSnippet().trim();
      if (!isFatalStartupDiagnostic(diagnostic)) return;
      void this.handleTransportFailure(
        new GeminiIntegrationError("process_crashed", diagnostic),
      );
    });
  }

  static async createNew(input: GeminiAcpSessionInput): Promise<GeminiAcpSession> {
    const session = new GeminiAcpSession(input, null);
    try {
      await session.connectAndInitialize();
      const response = await session.withRequestTimeout(
        session.agent.request(acp.methods.agent.session.new, {
          cwd: input.access.primaryRoot,
          mcpServers: [],
          // Gemini receives multi-root access through repeated CLI flags. Its ACP
          // implementation does not currently advertise/use additionalDirectories.
        }),
        "session/new",
      );
      session.providerSessionIdValue = response.sessionId;
      session.modesValue = normalizeModes(response.modes);
      session.modelsValue = normalizeModels(response.configOptions);
      return session;
    } catch (error) {
      await session.dispose();
      throw session.startupError(error);
    }
  }

  static async load(input: LoadGeminiAcpSessionInput): Promise<GeminiAcpSession> {
    const session = new GeminiAcpSession(input, input.providerSessionId);
    try {
      await session.connectAndInitialize();
      if (!session.capabilities.loadSession) {
        throw new GeminiIntegrationError(
          "capability_unsupported",
          "The installed Gemini CLI does not advertise ACP session/load",
        );
      }
      const response = await session.withRequestTimeout(
        session.agent.request(acp.methods.agent.session.load, {
          cwd: input.access.primaryRoot,
          mcpServers: [],
          sessionId: input.providerSessionId,
        }),
        "session/load",
      );
      session.modesValue = normalizeModes(response?.modes);
      session.modelsValue = normalizeModels(response?.configOptions);
      return session;
    } catch (error) {
      await session.dispose();
      throw session.startupError(error);
    }
  }

  get providerSessionId(): string {
    if (!this.providerSessionIdValue) {
      throw new GeminiIntegrationError(
        "session_not_found",
        "Gemini has not returned a provider session ID",
      );
    }
    return this.providerSessionIdValue;
  }

  get capabilities(): NormalizedAcpCapabilities {
    return this.capabilitiesValue;
  }

  get modes(): SessionModeSnapshot | undefined {
    return this.modesValue;
  }

  get state(): SessionState {
    return this.stateValue;
  }

  snapshot(): GeminiSessionSnapshot {
    return {
      appSessionId: this.appSessionId,
      providerSessionId: this.providerSessionId,
      state: this.stateValue,
      capabilities: this.capabilities,
      ...(this.modesValue ? { modes: this.modesValue } : {}),
      ...(this.modelsValue ? { models: this.modelsValue } : {}),
      pendingPermissionCount: this.permissionBroker.size,
      stderr: this.process.stderrSnippet(),
    };
  }

  async prompt(parts: readonly PromptPart[]): Promise<GeminiTurnResult> {
    this.assertUsable();
    if (this.activeTurn) {
      throw new GeminiIntegrationError(
        "session_busy",
        "Only one prompt may run in a Gemini session at a time",
      );
    }

    const prompt = this.toAcpPrompt(parts);
    this.stateValue = "running";
    const turn = this.runPrompt(prompt);
    this.activeTurn = turn;
    try {
      return await turn;
    } finally {
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
      if (!this.disposing && (this.stateValue as SessionState) !== "disconnected") {
        this.stateValue = this.permissionBroker.size > 0 ? "awaiting_permission" : "idle";
      }
    }
  }

  async cancel(): Promise<void> {
    this.assertUsable();
    const activeTurn = this.activeTurn;
    if (!activeTurn) return;

    this.stateValue = "cancelling";
    try {
      await this.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: this.providerSessionId,
      });
    } finally {
      // ACP requires pending permission requests to be answered as cancelled.
      this.permissionBroker.cancelSession(this.providerSessionId);
    }

    const completed = await settleWithin(activeTurn, this.cancelTimeoutMs);
    if (!completed) {
      await this.process.terminate(250);
    }
  }

  respondToPermission(permissionId: string, optionId: string): void {
    this.assertUsable();
    this.permissionBroker.resolve(permissionId, optionId);
  }

  async setMode(modeId: string): Promise<void> {
    this.assertUsable();
    const modes = this.modesValue;
    if (!modes || !modes.availableModes.some((mode) => mode.id === modeId)) {
      throw new GeminiIntegrationError(
        "capability_unsupported",
        `Gemini did not advertise session mode ${modeId}`,
      );
    }

    await this.withRequestTimeout(
      this.agent.request(acp.methods.agent.session.setMode, {
        sessionId: this.providerSessionId,
        modeId,
      }),
      "session/set_mode",
    );
    if (modes.currentModeId !== modeId) {
      this.modesValue = { ...modes, currentModeId: modeId };
      this.emit("mode.updated", { currentModeId: modeId });
    }
  }

  async setModel(modelId: string): Promise<void> {
    this.assertUsable();
    const models = this.modelsValue;
    if (!models || !models.availableModels.some((model) => model.id === modelId)) {
      throw new GeminiIntegrationError(
        "capability_unsupported",
        `Gemini did not advertise session model ${modelId}`,
      );
    }

    const response = await this.withRequestTimeout(
      this.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.providerSessionId,
        configId: models.configId,
        value: modelId,
      }),
      "session/set_config_option",
    );
    const nextModels = normalizeModels(response.configOptions);
    if (!nextModels || nextModels.currentModelId !== modelId) {
      throw new GeminiIntegrationError(
        "protocol_mismatch",
        "Gemini did not confirm the selected model",
      );
    }
    this.modelsValue = nextModels;
  }

  async authenticate(methodId: string): Promise<void> {
    this.assertUsable();
    if (!this.capabilities.authMethods.some((method) => method.id === methodId)) {
      throw new GeminiIntegrationError(
        "capability_unsupported",
        `Gemini did not advertise authentication method ${methodId}`,
      );
    }
    await this.withRequestTimeout(
      this.agent.request(acp.methods.agent.authenticate, { methodId }),
      "authenticate",
    );
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private get agent() {
    if (!this.connection) {
      throw new GeminiIntegrationError("disposed", "The ACP connection is not available");
    }
    return this.connection.agent;
  }

  private async connectAndInitialize(): Promise<void> {
    const output = Writable.toWeb(this.process.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(this.protocolGuard) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    const client = acp
      .client({ name: "geminui" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        this.handlePermissionRequest(params),
      )
      .onNotification(acp.methods.client.session.update, ({ params }) =>
        this.handleSessionNotification(params),
      );

    this.connection = client.connect(stream);
    void this.connection.closed.then(() => {
      if (!this.disposing && !this.disconnectedEmitted) {
        // stdout commonly closes just before ChildProcess emits `close`. Give the
        // process event one tick so crash diagnostics retain the real exit code.
        const timer = setTimeout(() => {
          if (!this.disposing && !this.disconnectedEmitted) {
            void this.handleTransportFailure(new Error("ACP transport closed"));
          }
        }, 25);
        timer.unref?.();
      }
    });

    const response = await withTimeout(
      this.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        // Intentionally omit fs and terminal: Gemini uses its native multi-root workspace.
        clientCapabilities: {},
        clientInfo: { name: "geminui", title: "GeminUI", version: "0.1.0" },
      }),
      this.initializeTimeoutMs,
      "ACP initialize",
      () => {
        this.connection?.close(
          new Error(
            "Gemini CLI antwortet nicht über ACP. Öffne `gemini` im Terminal und prüfe Anmeldung und Workspace-Setup.",
          ),
        );
        void this.process.terminate(250);
      },
    );
    this.validateInitialize(response);
    this.capabilitiesValue = normalizeCapabilities(response);
    this.initializationComplete = true;
    this.unsubscribeStderr?.();
    this.unsubscribeStderr = undefined;
  }

  private validateInitialize(response: InitializeResponse): void {
    if (response.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new GeminiIntegrationError(
        "protocol_mismatch",
        `Gemini negotiated ACP v${response.protocolVersion}; GeminUI supports stable ACP v${acp.PROTOCOL_VERSION}`,
        {
          details: {
            expected: acp.PROTOCOL_VERSION,
            actual: response.protocolVersion,
          },
        },
      );
    }
  }

  private async runPrompt(prompt: ContentBlock[]): Promise<GeminiTurnResult> {
    try {
      const response: PromptResponse = await this.agent.request(
        acp.methods.agent.session.prompt,
        { sessionId: this.providerSessionId, prompt },
      );
      const result: GeminiTurnResult = {
        stopReason: response.stopReason,
        ...(response.usage ? { usage: response.usage } : {}),
      };
      if (response.stopReason === "cancelled") {
        this.emit("turn.cancelled", {});
      } else {
        this.emit("turn.completed", {
          stopReason: response.stopReason,
          ...(response.usage ? { usage: response.usage } : {}),
        });
      }
      return result;
    } catch (error) {
      if (!this.disposing) {
        this.emit("turn.failed", { message: toErrorMessage(error) });
      }
      throw error;
    }
  }

  private toAcpPrompt(parts: readonly PromptPart[]): ContentBlock[] {
    if (parts.length === 0) {
      throw new GeminiIntegrationError(
        "capability_unsupported",
        "A Gemini prompt must contain at least one content block",
      );
    }

    return parts.map((part): ContentBlock => {
      switch (part.type) {
        case "text":
          return { type: "text", text: part.text };
        case "image":
          if (!this.capabilities.prompt.image) {
            throw new GeminiIntegrationError(
              "capability_unsupported",
              "The installed Gemini CLI does not advertise ACP image prompts",
            );
          }
          return {
            type: "image",
            mimeType: part.mimeType,
            data: part.data,
            ...(part.uri ? { uri: part.uri } : {}),
          };
        case "audio":
          if (!this.capabilities.prompt.audio) {
            throw new GeminiIntegrationError(
              "capability_unsupported",
              "The installed Gemini CLI does not advertise ACP audio prompts",
            );
          }
          return { type: "audio", mimeType: part.mimeType, data: part.data };
        case "resource_link":
          return {
            type: "resource_link",
            name: part.name,
            uri: part.uri,
            ...(part.mimeType ? { mimeType: part.mimeType } : {}),
            ...(part.size !== undefined ? { size: part.size } : {}),
            ...(part.description ? { description: part.description } : {}),
          };
        default:
          return assertNever(part);
      }
    });
  }

  private handleSessionNotification(notification: SessionNotification): void {
    if (
      this.providerSessionIdValue &&
      notification.sessionId !== this.providerSessionIdValue
    ) {
      return;
    }

    if (notification.update.sessionUpdate === "current_mode_update" && this.modesValue) {
      this.modesValue = {
        ...this.modesValue,
        currentModeId: notification.update.currentModeId,
      };
    }
    if (notification.update.sessionUpdate === "config_option_update") {
      this.modelsValue = normalizeModels(notification.update.configOptions);
    }
    for (const event of normalizeSessionNotification(notification, {
      appSessionId: this.appSessionId,
      providerSessionId: notification.sessionId,
    })) {
      this.deliverEvent(event);
    }
  }

  private handlePermissionRequest(
    request: Parameters<PermissionBroker["request"]>[0],
  ) {
    if (
      this.providerSessionIdValue &&
      request.sessionId !== this.providerSessionIdValue
    ) {
      return Promise.resolve({ outcome: { outcome: "cancelled" as const } });
    }
    return this.permissionBroker.request(request);
  }

  private handlePermissionRequested(request: PermissionRequest): void {
    this.stateValue = "awaiting_permission";
    this.emit("permission.requested", request);
  }

  private handleProcessExit(exit: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }): void {
    if (this.disposing || this.disconnectedEmitted) return;
    this.disconnectedEmitted = true;
    this.unsubscribeStderr?.();
    this.unsubscribeStderr = undefined;
    this.stateValue = "disconnected";
    this.permissionBroker.dispose();
    const stderr = this.process.stderrSnippet();
    const message =
      exit.error?.message ??
      (stderr.trim() ||
        `Gemini CLI exited before the ACP connection completed (exit ${String(exit.exitCode)})`);
    // Reject initialize/session requests immediately. Without closing the SDK
    // connection here an early CLI failure (for example missing auth) would be
    // reported only as an unrelated request timeout.
    this.connection?.close(
      new GeminiIntegrationError("process_crashed", message),
    );
    this.emit("process.disconnected", {
      exitCode: exit.exitCode,
      signal: exit.signal,
      stderr,
      message,
    });
  }

  private async handleTransportFailure(error: Error): Promise<void> {
    if (this.disposing || this.disconnectedEmitted) return;
    this.disconnectedEmitted = true;
    this.unsubscribeStderr?.();
    this.unsubscribeStderr = undefined;
    this.stateValue = "disconnected";
    this.permissionBroker.dispose();
    this.connection?.close(error);
    this.emit("process.disconnected", {
      exitCode: null,
      signal: null,
      stderr: this.process.stderrSnippet(),
      message: error.message,
    });
    await this.process.terminate(250);
  }

  private async disposeInternal(): Promise<void> {
    if (this.stateValue === "disposed") return;
    this.disposing = true;
    this.unsubscribeStderr?.();
    this.unsubscribeStderr = undefined;
    const activeTurn = this.activeTurn;
    if (activeTurn && this.connection && this.providerSessionIdValue) {
      try {
        await this.agent.notify(acp.methods.agent.session.cancel, {
          sessionId: this.providerSessionIdValue,
        });
      } catch {
        // The process may already be gone.
      }
      this.permissionBroker.cancelSession(this.providerSessionIdValue);
      await settleWithin(activeTurn, Math.min(this.cancelTimeoutMs, 500));
    }
    this.permissionBroker.dispose();
    this.connection?.close();
    await this.process.terminate(500);
    this.stateValue = "disposed";
  }

  private async withRequestTimeout<T>(request: Promise<T>, label: string): Promise<T> {
    return withTimeout(request, this.requestTimeoutMs, label, () => {
      this.connection?.close(new Error(`${label} timed out`));
      void this.process.terminate(250);
    });
  }

  private assertUsable(): void {
    if (this.disposing || this.stateValue === "disposed") {
      throw new GeminiIntegrationError("disposed", "The Gemini session is disposed");
    }
    if (this.stateValue === "disconnected") {
      throw new GeminiIntegrationError(
        "process_crashed",
        "The Gemini process is disconnected; load the provider session in a new process",
      );
    }
  }

  private startupError(error: unknown): unknown {
    const diagnostic = this.process.stderrSnippet().trim();
    if (
      !diagnostic ||
      (this.stateValue !== "disconnected" &&
        toErrorMessage(error) !== "ACP connection closed")
    ) {
      return error;
    }
    return new GeminiIntegrationError("process_crashed", diagnostic, {
      cause: error,
    });
  }

  private emit<Type extends NormalizedAgentEvent["type"]>(
    type: Type,
    payload: Extract<NormalizedAgentEvent, { type: Type }>["payload"],
  ): void {
    const event = {
      type,
      appSessionId: this.appSessionId,
      providerSessionId: this.providerSessionIdValue,
      occurredAt: new Date().toISOString(),
      payload,
    } as Extract<NormalizedAgentEvent, { type: Type }>;
    this.deliverEvent(event);
  }

  private deliverEvent(event: NormalizedAgentEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Event persistence/UI callbacks must never break the ACP protocol loop.
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(
            new GeminiIntegrationError("timeout", `${label} timed out after ${milliseconds}ms`),
          );
        }, milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), milliseconds);
      timer.unref?.();
    }),
  ]);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled prompt content: ${JSON.stringify(value)}`);
}

function isFatalStartupDiagnostic(value: string): boolean {
  return /(?:^|\n)(?:Error authenticating:|Fatal error:|An unexpected critical error occurred:|Cleanup timed out)/i.test(
    value,
  );
}
