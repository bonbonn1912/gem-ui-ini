import {
  GeminiAcpSession,
  GeminiIntegrationError,
  describeGeminiError,
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
import type { ListSessionsResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { ElicitationRequest, RespondToElicitationInput } from "../../shared/contracts/elicitation.js";

export type ResourceProfile = "economy" | "balanced" | "performance";

const MISSING_SESSION_CODE = /^(?:INVALID_SESSION_IDENTIFIER|NO_SESSIONS_FOUND|session_not_found)$/;

/**
 * Collects every human-readable string an ACP error carries. The meaningful
 * text is not always on `message`: Gemini answers an unloadable session with
 * JSON-RPC "Internal error" and puts the real wording into `data.details`.
 */
function errorText(error: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const key of ["message", "details", "error", "reason", "description", "data", "cause"]) {
      visit(record[key], depth + 1);
    }
  };
  visit(error, 0);
  return parts.join(" ").toLowerCase();
}

/**
 * True only for an explicit provider response that says the persisted session
 * no longer exists. Network, auth and generic ACP failures must keep the old
 * ID so a later retry can resume it.
 *
 * Gemini's session store is the authority here: it reports a session that was
 * never flushed (no prompt completed), deleted, or created under a different
 * project root as "No previous sessions found for this project." or
 * "Invalid session identifier \"<id>\"..." (SessionError codes
 * NO_SESSIONS_FOUND / INVALID_SESSION_IDENTIFIER). Both must trigger the fresh
 * session fallback instead of surfacing a raw load failure on the next send or
 * mode change.
 */
export function isMissingProviderSessionError(error: unknown): boolean {
  if (error instanceof GeminiIntegrationError && error.code === "session_not_found") return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  if (value.code === "session_not_found") return true;
  if (typeof value.code === "string" && MISSING_SESSION_CODE.test(value.code)) return true;
  const text = errorText(error);
  if (text.includes("no previous sessions found") || text.includes("invalid session identifier")) return true;
  if (/\b(auth|unauthori[sz]ed|forbidden|credential|network|timeout|timed out|connection|offline|unavailable)\b/.test(text)) return false;
  return /\b(session|conversation)\b.{0,32}\b(not found|does not exist|no longer exists|unknown)\b/.test(text)
    || /\b(not found|does not exist|unknown)\b.{0,32}\b(session|conversation)\b/.test(text);
}

const RESOURCE_PROFILES: Record<ResourceProfile, { maxProcesses: number; idleTimeoutMs: number }> = {
  economy: { maxProcesses: 1, idleTimeoutMs: 0 },
  balanced: { maxProcesses: 2, idleTimeoutMs: 90_000 },
  performance: { maxProcesses: 3, idleTimeoutMs: 180_000 },
};

export interface GeminiSessionManagerOptions {
  readonly binaryPath: string;
  readonly binaryArgs?: readonly string[];
  readonly acpFlag?: "--acp" | "--experimental-acp";
  readonly environment?: NodeJS.ProcessEnv;
  readonly processSpawner?: GeminiProcessSpawner;
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly cancelTimeoutMs?: number;
  readonly maxStderrBytes?: number;
  readonly maxProtocolLineBytes?: number;
  readonly resourceProfile?: ResourceProfile;
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
  private readonly openingControllers = new Map<string, AbortController>();
  private readonly openTasks = new Set<Promise<unknown>>();
  private readonly listeners = new Set<AgentEventListener>();
  private resourceProfile: ResourceProfile;
  private readonly reservedSlots = new Set<string>();
  /** Prompt preparation may await disk and attachment IO before `prompt()`. */
  private readonly sessionLeases = new Map<string, number>();
  private readonly slotWaiters: Array<{ appSessionId: string; resolve: () => void; reject: (error: Error) => void }> = [];
  private readonly lastUsedAt = new Map<string, number>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly options: GeminiSessionManagerOptions) {
    this.resourceProfile = options.resourceProfile ?? "balanced";
  }

  setResourceProfile(profile: ResourceProfile): void {
    this.resourceProfile = profile;
    while (this.slotWaiters.length && this.reservedSlots.size < RESOURCE_PROFILES[profile].maxProcesses) {
      const waiter = this.slotWaiters.shift()!;
      this.reservedSlots.add(waiter.appSessionId);
      waiter.resolve();
    }
    this.rescheduleIdleSessions();
    this.evictToBudget();
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createSession(input: CreateManagedSessionInput): Promise<GeminiSessionSnapshot> {
    return this.open(input.appSessionId, "new", null, async (signal) =>
      GeminiAcpSession.createNew(this.sessionInput(input, signal)),
    );
  }

  async loadSession(input: LoadManagedSessionInput): Promise<GeminiSessionSnapshot> {
    return this.open(input.appSessionId, "load", input.providerSessionId, async (signal) =>
      GeminiAcpSession.load({
        ...this.sessionInput(input, signal),
        providerSessionId: input.providerSessionId,
      }),
    );
  }

  async resumeSession(input: LoadManagedSessionInput): Promise<GeminiSessionSnapshot> {
    return this.open(input.appSessionId, "load", input.providerSessionId, async (signal) =>
      GeminiAcpSession.resume({ ...this.sessionInput(input, signal), providerSessionId: input.providerSessionId }),
    );
  }

  getSession(appSessionId: string): GeminiSessionSnapshot | undefined {
    return this.sessions.get(appSessionId)?.snapshot();
  }

  /**
   * Protect an app session from idle/LRU eviction while its prompt is being
   * prepared. Acquire before the first await in the caller and release when
   * the actual prompt request has started (or preparation fails).
   */
  reserveSession(appSessionId: string): () => void {
    this.assertNotDisposed();
    this.sessionLeases.set(appSessionId, (this.sessionLeases.get(appSessionId) ?? 0) + 1);
    this.clearIdleTimer(appSessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.sessionLeases.get(appSessionId) ?? 0;
      if (count <= 1) this.sessionLeases.delete(appSessionId);
      else this.sessionLeases.set(appSessionId, count - 1);
      this.scheduleIdleDisposal(appSessionId);
    };
  }

  listActiveSessions(): GeminiSessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  prompt(
    appSessionId: string,
    parts: readonly PromptPart[],
  ): Promise<GeminiTurnResult> {
    this.touch(appSessionId);
    return this.requireSession(appSessionId).prompt(parts).finally(() => this.scheduleIdleDisposal(appSessionId));
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
    this.touch(appSessionId);
    return this.requireSession(appSessionId).setMode(modeId).finally(() => this.scheduleIdleDisposal(appSessionId));
  }

  setModel(appSessionId: string, modelId: string): Promise<void> {
    this.touch(appSessionId);
    return this.requireSession(appSessionId).setModel(modelId).finally(() => this.scheduleIdleDisposal(appSessionId));
  }

  authenticate(appSessionId: string, methodId: string): Promise<void> {
    this.touch(appSessionId);
    return this.requireSession(appSessionId).authenticate(methodId).finally(() => this.scheduleIdleDisposal(appSessionId));
  }

  getSessionConfig(appSessionId: string): readonly SessionConfigOption[] {
    this.touch(appSessionId);
    const options = this.requireSession(appSessionId).snapshot().config?.options ?? [];
    this.scheduleIdleDisposal(appSessionId);
    return options;
  }

  setConfigOption(appSessionId: string, configId: string, value: string | boolean): Promise<void> {
    this.touch(appSessionId);
    return this.requireSession(appSessionId).setConfigOption(configId, value).finally(() => this.scheduleIdleDisposal(appSessionId));
  }

  listProviderSessions(appSessionId: string, input: { cwd?: string; cursor?: string }): Promise<ListSessionsResponse> {
    this.touch(appSessionId);
    return this.requireSession(appSessionId).listProviderSessions(input).finally(() => this.scheduleIdleDisposal(appSessionId));
  }

  deleteProviderSession(appSessionId: string, providerSessionId: string): Promise<void> {
    this.touch(appSessionId);
    return this.requireSession(appSessionId).deleteProviderSession(providerSessionId).finally(() => this.scheduleIdleDisposal(appSessionId));
  }

  listElicitations(appSessionId: string): ElicitationRequest[] {
    return this.requireSession(appSessionId).listElicitations();
  }

  respondToElicitation(input: RespondToElicitationInput): void {
    this.requireSession(input.sessionId).respondToElicitation(input);
    this.scheduleIdleDisposal(input.sessionId);
  }

  async disposeSession(appSessionId: string): Promise<void> {
    const session = this.sessions.get(appSessionId);
    if (!session) return;
    this.sessions.delete(appSessionId);
    this.clearIdleTimer(appSessionId);
    try {
      await session.dispose();
    } finally {
      // A child that refuses to exit must not permanently consume a logical
      // slot; dispose() itself has a bounded process termination path.
      this.releaseSlot(appSessionId);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.openingControllers.values()) controller.abort();
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(new GeminiIntegrationError("disposed", "The session manager is disposed"));
    const cleanup = Promise.allSettled([...sessions.map((session) => session.dispose()), ...this.openTasks]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 3_000);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.reservedSlots.clear();
    this.sessionLeases.clear();
    this.listeners.clear();
  }

  private open(
    appSessionId: string,
    operation: "new" | "load",
    initialProviderSessionId: string | null,
    factory: (signal: AbortSignal) => Promise<GeminiAcpSession>,
  ): Promise<GeminiSessionSnapshot> {
    const task = this.openInternal(appSessionId, operation, initialProviderSessionId, factory);
    this.openTasks.add(task);
    void task.then(
      () => this.openTasks.delete(task),
      () => this.openTasks.delete(task),
    );
    return task;
  }

  private async openInternal(
    appSessionId: string,
    operation: "new" | "load",
    initialProviderSessionId: string | null,
    factory: (signal: AbortSignal) => Promise<GeminiAcpSession>,
  ): Promise<GeminiSessionSnapshot> {
    this.assertNotDisposed();
    if (this.sessions.has(appSessionId) || this.opening.has(appSessionId)) {
      throw new GeminiIntegrationError(
        "session_already_active",
        `App session ${appSessionId} already owns a Gemini process`,
      );
    }

    this.opening.add(appSessionId);
    const controller = new AbortController();
    this.openingControllers.set(appSessionId, controller);
    let reserved = false;
    this.emit({
      type: "session.started",
      appSessionId,
      providerSessionId: initialProviderSessionId,
      occurredAt: new Date().toISOString(),
      payload: { operation },
    });
    try {
      await this.reserveSlot(appSessionId);
      reserved = true;
      const session = await factory(controller.signal);
      if (this.disposed) {
        await session.dispose();
        throw new GeminiIntegrationError("disposed", "The session manager was disposed");
      }
      this.sessions.set(appSessionId, session);
      this.lastUsedAt.set(appSessionId, Date.now());
      this.scheduleIdleDisposal(appSessionId);
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
          ...(snapshot.config ? { config: snapshot.config } : {}),
        },
      });
      if (this.slotWaiters.length > 0) await this.evictOldestIdleSession();
      return snapshot;
    } catch (error) {
      this.emit({
        type: "session.failed",
        appSessionId,
        providerSessionId: null,
        occurredAt: new Date().toISOString(),
        payload: describeGeminiError(error),
      });
      throw error;
    } finally {
      this.opening.delete(appSessionId);
      this.openingControllers.delete(appSessionId);
      if (!this.sessions.has(appSessionId) && reserved) this.releaseSlot(appSessionId);
    }
  }

  private sessionInput(input: CreateManagedSessionInput, signal: AbortSignal): GeminiAcpSessionInput {
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
      acpFlag: this.options.acpFlag,
      onEvent: (event) => this.emit(event),
      signal,
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
    if (event.type === "turn.completed" || event.type === "turn.cancelled" || event.type === "turn.failed" || event.type === "permission.resolved") {
      this.scheduleIdleDisposal(event.appSessionId);
    } else if (event.type === "permission.requested" || event.type === "tool.started" || event.type === "message.assistant.delta") {
      this.clearIdleTimer(event.appSessionId);
      this.lastUsedAt.set(event.appSessionId, Date.now());
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A UI/event-store subscriber must not break the ACP protocol loop.
      }
    }
  }

  private async reserveSlot(appSessionId: string): Promise<void> {
    const max = RESOURCE_PROFILES[this.resourceProfile].maxProcesses;
    if (this.reservedSlots.size < max) {
      this.reservedSlots.add(appSessionId);
      return;
    }
    const victim = [...this.sessions.values()]
      .filter((session) => session.appSessionId !== appSessionId && !this.isLeased(session.appSessionId) && session.state === "idle" && session.snapshot().pendingPermissionCount === 0 && session.snapshot().pendingElicitationCount === 0)
      .sort((a, b) => (this.lastUsedAt.get(a.appSessionId) ?? 0) - (this.lastUsedAt.get(b.appSessionId) ?? 0))[0];
    if (victim) {
      await this.disposeSession(victim.appSessionId);
      if (this.reservedSlots.size < RESOURCE_PROFILES[this.resourceProfile].maxProcesses) {
        this.reservedSlots.add(appSessionId);
        return;
      }
    }
    if (this.slotWaiters.length >= 8) throw new GeminiIntegrationError("session_busy", "Zu viele Gemini-Starts warten auf einen freien Prozess-Slot.");
    await new Promise<void>((resolve, reject) => this.slotWaiters.push({ appSessionId, resolve, reject }));
  }

  private releaseSlot(appSessionId: string): void {
    this.reservedSlots.delete(appSessionId);
    const waiter = this.slotWaiters.shift();
    if (!waiter || this.disposed) return;
    if (this.reservedSlots.size >= RESOURCE_PROFILES[this.resourceProfile].maxProcesses) {
      this.slotWaiters.unshift(waiter);
      return;
    }
    this.reservedSlots.add(waiter.appSessionId);
    waiter.resolve();
  }

  private touch(appSessionId: string): void {
    this.lastUsedAt.set(appSessionId, Date.now());
    this.clearIdleTimer(appSessionId);
  }

  private scheduleIdleDisposal(appSessionId: string): void {
    const session = this.sessions.get(appSessionId);
    if (!session || this.isLeased(appSessionId) || session.state !== "idle" || session.snapshot().pendingPermissionCount > 0 || session.snapshot().pendingElicitationCount > 0) return;
    this.clearIdleTimer(appSessionId);
    const delay = this.slotWaiters.length ? 0 : RESOURCE_PROFILES[this.resourceProfile].idleTimeoutMs;
    const timer = setTimeout(() => {
      this.idleTimers.delete(appSessionId);
      const current = this.sessions.get(appSessionId);
      if (current && !this.isLeased(appSessionId) && current.state === "idle" && current.snapshot().pendingPermissionCount === 0 && current.snapshot().pendingElicitationCount === 0) void this.disposeSession(appSessionId).catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.idleTimers.set(appSessionId, timer);
  }

  private clearIdleTimer(appSessionId: string): void {
    const timer = this.idleTimers.get(appSessionId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(appSessionId);
  }

  private rescheduleIdleSessions(): void {
    for (const session of this.sessions.values()) if (session.state === "idle") this.scheduleIdleDisposal(session.appSessionId);
  }

  private evictToBudget(): void {
    const max = RESOURCE_PROFILES[this.resourceProfile].maxProcesses;
    const idle = [...this.sessions.values()].filter((session) => !this.isLeased(session.appSessionId) && session.state === "idle" && session.snapshot().pendingPermissionCount === 0 && session.snapshot().pendingElicitationCount === 0)
      .sort((a, b) => (this.lastUsedAt.get(a.appSessionId) ?? 0) - (this.lastUsedAt.get(b.appSessionId) ?? 0));
    while (this.reservedSlots.size > max && idle.length) void this.disposeSession(idle.shift()!.appSessionId).catch(() => undefined);
  }

  private async evictOldestIdleSession(): Promise<void> {
    const victim = [...this.sessions.values()]
      .filter((session) => !this.isLeased(session.appSessionId) && session.state === "idle" && session.snapshot().pendingPermissionCount === 0 && session.snapshot().pendingElicitationCount === 0)
      .sort((a, b) => (this.lastUsedAt.get(a.appSessionId) ?? 0) - (this.lastUsedAt.get(b.appSessionId) ?? 0))[0];
    if (victim) await this.disposeSession(victim.appSessionId);
  }

  private isLeased(appSessionId: string): boolean {
    return (this.sessionLeases.get(appSessionId) ?? 0) > 0;
  }
}
