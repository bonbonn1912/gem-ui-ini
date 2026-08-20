import {
  GeminiAcpSession,
  GeminiIntegrationError,
  toErrorMessage,
  type AgentEventListener,
  type GeminiAcpSessionInput,
  type GeminiProcessSpawner,
  type GeminiSessionSnapshot,
  type GeminiTurnResult,
  type NormalizedAgentEvent,
  type PermissionResponse,
  type ProjectAccess,
  type PromptPart,
} from "../gemini/index.js";

export interface GeminiSessionManagerOptions {
  readonly binaryPath: string;
  readonly binaryArgs?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly processSpawner?: GeminiProcessSpawner;
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly cancelTimeoutMs?: number;
  readonly maxStderrBytes?: number;
  readonly maxProtocolLineBytes?: number;
}

export interface CreateManagedSessionInput {
  readonly appSessionId: string;
  readonly access: ProjectAccess;
}

export interface LoadManagedSessionInput extends CreateManagedSessionInput {
  readonly providerSessionId: string;
}

/**
 * Main-process integration API. It guarantees one child per active app session
 * and deliberately contains no persistence, IPC, Electron, or renderer imports.
 */
export class GeminiSessionManager {
  private readonly sessions = new Map<string, GeminiAcpSession>();
  private readonly opening = new Set<string>();
  private readonly listeners = new Set<AgentEventListener>();
  private disposed = false;

  constructor(private readonly options: GeminiSessionManagerOptions) {}

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createSession(input: CreateManagedSessionInput): Promise<GeminiSessionSnapshot> {
    return this.open(input.appSessionId, "new", async () =>
      GeminiAcpSession.createNew(this.sessionInput(input)),
    );
  }

  async loadSession(input: LoadManagedSessionInput): Promise<GeminiSessionSnapshot> {
    return this.open(input.appSessionId, "load", async () =>
      GeminiAcpSession.load({
        ...this.sessionInput(input),
        providerSessionId: input.providerSessionId,
      }),
    );
  }

  getSession(appSessionId: string): GeminiSessionSnapshot | undefined {
    return this.sessions.get(appSessionId)?.snapshot();
  }

  listActiveSessions(): GeminiSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  prompt(
    appSessionId: string,
    parts: readonly PromptPart[],
  ): Promise<GeminiTurnResult> {
    return this.requireSession(appSessionId).prompt(parts);
  }

  cancel(appSessionId: string): Promise<void> {
    return this.requireSession(appSessionId).cancel();
  }

  respondToPermission(input: PermissionResponse): void {
    this.requireSession(input.appSessionId).respondToPermission(
      input.permissionId,
      input.optionId,
    );
  }

  setMode(appSessionId: string, modeId: string): Promise<void> {
    return this.requireSession(appSessionId).setMode(modeId);
  }

  setModel(appSessionId: string, modelId: string): Promise<void> {
    return this.requireSession(appSessionId).setModel(modelId);
  }

  authenticate(appSessionId: string, methodId: string): Promise<void> {
    return this.requireSession(appSessionId).authenticate(methodId);
  }

  async disposeSession(appSessionId: string): Promise<void> {
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    this.sessions.delete(appSessionId);
    await session.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.dispose()));
    this.listeners.clear();
  }

  private async open(
    appSessionId: string,
    operation: "new" | "load",
    factory: () => Promise<GeminiAcpSession>,
  ): Promise<GeminiSessionSnapshot> {
    this.assertNotDisposed();
    if (this.sessions.has(appSessionId) || this.opening.has(appSessionId)) {
      throw new GeminiIntegrationError(
        "session_already_active",
        `App session ${appSessionId} already owns a Gemini process`,
      );
    }

    this.opening.add(appSessionId);
    this.emit({
      type: "session.started",
      appSessionId,
      providerSessionId: null,
      occurredAt: new Date().toISOString(),
      payload: { operation },
    });
    try {
      const session = await factory();
      if (this.disposed) {
        await session.dispose();
        throw new GeminiIntegrationError("disposed", "The session manager was disposed");
      }
      this.sessions.set(appSessionId, session);
      const snapshot = session.snapshot();
      this.emit({
        type: "session.ready",
        appSessionId,
        providerSessionId: snapshot.providerSessionId,
        occurredAt: new Date().toISOString(),
        payload: {
          capabilities: snapshot.capabilities,
          ...(snapshot.modes ? { modes: snapshot.modes } : {}),
          ...(snapshot.models ? { models: snapshot.models } : {}),
        },
      });
      return snapshot;
    } catch (error) {
      this.emit({
        type: "session.failed",
        appSessionId,
        providerSessionId: null,
        occurredAt: new Date().toISOString(),
        payload: { message: toErrorMessage(error) },
      });
      throw error;
    } finally {
      this.opening.delete(appSessionId);
    }
  }

  private sessionInput(input: CreateManagedSessionInput): GeminiAcpSessionInput {
    return {
      appSessionId: input.appSessionId,
      binaryPath: this.options.binaryPath,
      binaryArgs: this.options.binaryArgs,
      access: input.access,
      environment: this.options.environment,
      processSpawner: this.options.processSpawner,
      initializeTimeoutMs: this.options.initializeTimeoutMs,
      requestTimeoutMs: this.options.requestTimeoutMs,
      cancelTimeoutMs: this.options.cancelTimeoutMs,
      maxStderrBytes: this.options.maxStderrBytes,
      maxProtocolLineBytes: this.options.maxProtocolLineBytes,
      onEvent: (event) => this.emit(event),
    };
  }

  private requireSession(appSessionId: string): GeminiAcpSession {
    this.assertNotDisposed();
    const session = this.sessions.get(appSessionId);
    if (!session) {
      throw new GeminiIntegrationError(
        "session_not_found",
        `No active Gemini process exists for app session ${appSessionId}`,
      );
    }
    return session;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new GeminiIntegrationError("disposed", "The Gemini session manager is disposed");
    }
  }

  private emit(event: NormalizedAgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A UI/event-store subscriber must not break the ACP protocol loop.
      }
    }
  }
}
