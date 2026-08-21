import { randomUUID } from "node:crypto";
import {
  AppSessionSchema,
  JsonValueSchema,
  type AgentEvent,
  type AppSession,
  type CancelTurnInput,
  type CreateSessionInput,
  type DeleteSessionInput,
  GetProjectApprovalPolicyInputSchema,
  type ListSessionsInput,
  ProjectApprovalPolicySchema,
  type ProjectApprovalPolicy,
  type ProjectWithRoots,
  type PermissionResponse as UiPermissionResponse,
  type SendPromptInput,
  type SetSessionModeInput,
  type SetSessionModelInput,
  SetProjectApprovalPolicyInputSchema,
  type SetProjectApprovalPolicyInput,
  type StreamEnvelope,
  type UpdateSessionInput,
  type UsageSnapshot,
} from "../shared/contracts";
import type { AttachmentService } from "./attachments/attachment-service";
import type { GeminiCapabilityService } from "./capability-service";
import {
  type NormalizedAgentEvent,
  type NormalizedContent,
  type NormalizedToolCall,
  type ProjectAccess as GeminiProjectAccess,
  type PromptPart,
  type SessionMode,
  type SessionModeSnapshot,
} from "./gemini";
import type { ProjectService, ProjectRuntimeCoordinator } from "./projects";
import { runCapturedCommand } from "./processes/run-command";
import { GeminiSessionManager } from "./sessions";
import type { UsageService } from "./usage";
import {
  type AttachmentRepository,
  type EventRepository,
  type SessionUpdate,
  type SessionRepository,
} from "./storage";

type ActiveTurn = {
  turnId: string;
  assistantMessageId: string;
  thoughtMessageId: string;
};

type PendingEventBuffer = {
  timer: ReturnType<typeof setTimeout>;
  events: Array<{
    sessionId: string;
    turnId: string | null;
    event: AgentEvent;
    timestamp: string;
  }>;
};

export type AppControllerOptions = {
  projects: ProjectService;
  sessions: SessionRepository;
  events: EventRepository;
  attachmentRepository: AttachmentRepository;
  attachmentService: AttachmentService;
  capabilities: GeminiCapabilityService;
  usage: UsageService;
  publishEvents: (events: StreamEnvelope[]) => void | Promise<void>;
};

export class AppController implements ProjectRuntimeCoordinator {
  readonly #projects: ProjectService;
  readonly #sessions: SessionRepository;
  readonly #events: EventRepository;
  readonly #attachmentRepository: AttachmentRepository;
  readonly #attachmentService: AttachmentService;
  readonly #capabilities: GeminiCapabilityService;
  readonly #usage: UsageService;
  readonly #publishEvents: AppControllerOptions["publishEvents"];
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #eventBuffers = new Map<string, PendingEventBuffer>();
  #manager: GeminiSessionManager | null = null;
  #managerBinaryPath: string | null = null;
  #unsubscribeManager: (() => void) | null = null;

  constructor(options: AppControllerOptions) {
    this.#projects = options.projects;
    this.#sessions = options.sessions;
    this.#events = options.events;
    this.#attachmentRepository = options.attachmentRepository;
    this.#attachmentService = options.attachmentService;
    this.#capabilities = options.capabilities;
    this.#usage = options.usage;
    this.#publishEvents = options.publishEvents;
  }

  listSessions(input: ListSessionsInput): AppSession[] {
    return this.#sessions.listByProject(
      input.projectId,
      input.includeArchived ?? false,
    );
  }

  async createSession(input: CreateSessionInput): Promise<AppSession> {
    const access = await this.#projects.getCurrentAccess(input.projectId);
    const timestamp = new Date().toISOString();
    const appSession = AppSessionSchema.parse({
      id: randomUUID(),
      provider: "gemini-cli",
      providerSessionId: null,
      projectId: input.projectId,
      lastRootRevision: access.rootRevision,
      lastRootFingerprint: access.rootFingerprint,
      title: input.title?.trim() || "Neue Session",
      status: "starting",
      model: null,
      mode: null,
      pinned: false,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#sessions.create(appSession, [
      access.primaryRoot,
      ...access.additionalRoots,
    ]);

    try {
      const manager = await this.#getManager();
      await this.#makeRoomForSession(manager, appSession.id);
      const snapshot = await manager.createSession({
        appSessionId: appSession.id,
        access: toGeminiAccess(access),
      });
      const appliedMode = await this.#applyProjectApprovalDefault(
        input.projectId,
        appSession.id,
        snapshot.modes,
      );
      return this.#sessions.update(appSession.id, {
        providerSessionId: snapshot.providerSessionId,
        status: "idle",
        mode: appliedMode,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.#sessions.update(appSession.id, {
        status: "error",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  updateSession(input: UpdateSessionInput): AppSession {
    return this.#sessions.update(input.sessionId, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteSession(input: DeleteSessionInput): Promise<void> {
    const session = this.#sessions.getById(input.sessionId);
    await this.#manager?.disposeSession(input.sessionId);

    if (input.deleteProviderHistory && session.providerSessionId) {
      const probe = this.#capabilities.probe;
      if (!probe?.ok || !probe.features.deleteSession) {
        throw new Error(
          "Diese Gemini-Version unterstützt das geprüfte Löschen der nativen Session-Historie nicht.",
        );
      }
      const access = await this.#projects.getCurrentAccess(session.projectId);
      const launch = this.#capabilities.requireLaunchCommand();
      const result = await runCapturedCommand({
        binaryPath: launch.binaryPath,
        args: [
          ...launch.binaryArgs,
          "--delete-session",
          session.providerSessionId,
        ],
        cwd: access.primaryRoot.realPath,
        timeoutMs: 10_000,
      });
      if (result.timedOut || result.exitCode !== 0) {
        throw new Error(
          result.stderr.trim() || "Gemini konnte die native Session nicht löschen.",
        );
      }
    }

    for (const attachment of this.#attachmentRepository.listBySession(
      input.sessionId,
    )) {
      await this.#attachmentService.remove(attachment.id);
    }
    this.#sessions.delete(input.sessionId);
  }

  async sendPrompt(input: SendPromptInput): Promise<{ turnId: string }> {
    const session = this.#sessions.getById(input.sessionId);
    const access = await this.#projects.getCurrentAccess(session.projectId);
    if (input.expectedRootRevision !== access.rootRevision) {
      throw new Error(
        "Die Projektordner wurden geändert. Bitte prüfe die aktuelle Root-Liste und sende erneut.",
      );
    }
    if (this.#activeTurns.has(session.id)) {
      throw new Error("In dieser Session läuft bereits eine Anfrage.");
    }

    await this.#ensureManagedSession(session, access);
    for (const attachmentId of input.attachmentIds) {
      const attachment = this.#attachmentRepository.find(attachmentId);
      if (
        !attachment ||
        attachment.status !== "staged" ||
        (attachment.sessionId !== null && attachment.sessionId !== session.id)
      ) {
        throw new Error("Mindestens ein Bild ist nicht mehr für diese Session verfügbar.");
      }
    }
    const images =
      input.attachmentIds.length > 0
        ? await this.#attachmentService.getPromptImages(input.attachmentIds)
        : [];
    const parts: PromptPart[] = [];
    if (input.text.trim()) parts.push({ type: "text", text: input.text });
    for (const image of images) {
      parts.push({
        type: "image",
        mimeType: image.mimeType,
        data: image.data,
      });
    }

    const turnId = randomUUID();
    const activeTurn: ActiveTurn = {
      turnId,
      assistantMessageId: randomUUID(),
      thoughtMessageId: randomUUID(),
    };
    this.#activeTurns.set(session.id, activeTurn);

    const timestamp = new Date().toISOString();
    const userEnvelope = this.#events.append({
      sessionId: session.id,
      turnId,
      event: {
        type: "message.user",
        messageId: randomUUID(),
        text: input.text,
        attachmentIds: input.attachmentIds,
      },
      timestamp,
    });
    void this.#publishEvents([userEnvelope]);

    for (const image of images) {
      this.#attachmentRepository.markSent(image.id, session.id, turnId);
    }

    this.#sessions.update(session.id, {
      status: "running",
      updatedAt: timestamp,
    });

    void this.#manager!
      .prompt(session.id, parts)
      .catch((error: unknown) => this.#handleSyntheticFailure(session.id, error));

    return { turnId };
  }

  async cancelTurn(input: CancelTurnInput): Promise<void> {
    const active = this.#activeTurns.get(input.sessionId);
    if (!active || active.turnId !== input.turnId) return;
    this.#sessions.update(input.sessionId, {
      status: "cancelling",
      updatedAt: new Date().toISOString(),
    });
    await this.#manager?.cancel(input.sessionId);
  }

  respondToPermission(input: UiPermissionResponse): void {
    this.#manager?.respondToPermission({
      appSessionId: input.sessionId,
      permissionId: input.requestId,
      optionId: input.optionId,
    });
  }

  async setMode(input: SetSessionModeInput): Promise<AppSession> {
    const session = this.#sessions.getById(input.sessionId);
    const access = await this.#projects.getCurrentAccess(session.projectId);
    await this.#ensureManagedSession(session, access);
    await this.#manager!.setMode(input.sessionId, input.modeId);
    return this.#sessions.update(input.sessionId, {
      mode: input.modeId,
      updatedAt: new Date().toISOString(),
    });
  }

  async getProjectApprovalPolicy(
    input: { projectId: string },
  ): Promise<ProjectApprovalPolicy> {
    const parsed = GetProjectApprovalPolicyInputSchema.parse(input);
    let project = this.#projects.get(parsed.projectId);
    const snapshot = await this.#getProjectModeSnapshot(parsed.projectId);
    project = this.#projects.get(parsed.projectId);
    return toProjectApprovalPolicy(project, snapshot?.modes);
  }

  async setProjectApprovalPolicy(
    input: SetProjectApprovalPolicyInput,
  ): Promise<ProjectApprovalPolicy> {
    const parsed = SetProjectApprovalPolicyInputSchema.parse(input);
    if (parsed.modeId === null) {
      const project = this.#projects.setApprovalModeState({
        projectId: parsed.projectId,
        modeId: null,
        state: "gemini_default",
      });
      const snapshot = await this.#getProjectModeSnapshot(parsed.projectId, false);
      return toProjectApprovalPolicy(project, snapshot?.modes);
    }

    const snapshot = await this.#getProjectModeSnapshot(parsed.projectId);
    const selected = snapshot?.modes?.availableModes.find(
      (mode) => mode.id === parsed.modeId,
    );
    if (!selected) {
      throw new Error(
        "Dieser Modus wurde von der aktuellen Gemini-ACP-Session nicht angeboten und kann nicht projektweit gespeichert werden.",
      );
    }
    if (isUnrestrictedMode(selected) && !parsed.confirmUnrestricted) {
      throw new Error(
        "Der Modus „Alles erlauben“ benötigt eine ausdrückliche Bestätigung, da Gemini damit Tools ohne einzelne Rückfrage ausführen darf.",
      );
    }

    const manager = await this.#getManager();
    const projectSessionIds = new Set(
      this.#sessions.listByProject(parsed.projectId, true).map((session) => session.id),
    );
    const managed = manager
      .listActiveSessions()
      .filter((session) => projectSessionIds.has(session.appSessionId));
    if (
      managed.some(
        (session) =>
          !session.modes?.availableModes.some((mode) => mode.id === parsed.modeId),
      )
    ) {
      throw new Error(
        "Mindestens eine aktive Gemini-Session bietet diesen Modus nicht an. Die Projekteinstellung wurde nicht geändert.",
      );
    }

    await Promise.all(
      managed.map(async (session) => {
        if (session.modes?.currentModeId !== parsed.modeId) {
          await manager.setMode(session.appSessionId, parsed.modeId!);
        }
        this.#sessions.update(session.appSessionId, {
          mode: parsed.modeId,
          updatedAt: new Date().toISOString(),
        });
      }),
    );
    const project = this.#projects.setApprovalModeState({
      projectId: parsed.projectId,
      modeId: parsed.modeId,
      state: "available",
    });
    const current = manager.getSession(snapshot!.appSessionId);
    return toProjectApprovalPolicy(project, current?.modes ?? snapshot?.modes);
  }

  async setModel(input: SetSessionModelInput): Promise<AppSession> {
    const session = this.#sessions.getById(input.sessionId);
    const access = await this.#projects.getCurrentAccess(session.projectId);
    await this.#ensureManagedSession(session, access);
    const models = this.#manager?.getSession(input.sessionId)?.models;
    if (!models?.availableModels.some((model) => model.id === input.modelId)) {
      throw new Error(
        "Dieses Modell wurde von der aktuellen Gemini-Session nicht angeboten.",
      );
    }
    await this.#manager!.setModel(input.sessionId, input.modelId);
    // The context window belongs to the previous model. Drop it until the agent
    // reports a new one instead of showing a percentage of the wrong size.
    if (session.model !== input.modelId) {
      this.#publishUsageSnapshot(
        input.sessionId,
        null,
        this.#usage.invalidateContext(input.sessionId, new Date().toISOString()),
      );
    }
    return this.#sessions.update(input.sessionId, {
      model: input.modelId,
      updatedAt: new Date().toISOString(),
    });
  }

  async assertProjectIdle(projectId: string): Promise<void> {
    const busy = this.#sessions
      .listByProject(projectId, true)
      .some(
        (session) =>
          this.#activeTurns.has(session.id) ||
          session.status === "running" ||
          session.status === "awaiting_permission" ||
          session.status === "cancelling",
      );
    if (busy) {
      throw new Error(
        "Projektordner können nicht geändert werden, solange eine Session arbeitet oder auf eine Freigabe wartet.",
      );
    }
  }

  async stopProjectProcesses(projectId: string): Promise<void> {
    if (!this.#manager) return;
    const sessions = this.#sessions.listByProject(projectId, true);
    await Promise.allSettled(
      sessions.map((session) => this.#manager!.disposeSession(session.id)),
    );
  }

  async prepareProjectDeletion(projectId: string): Promise<void> {
    await this.assertProjectIdle(projectId);
    await this.stopProjectProcesses(projectId);
    for (const session of this.#sessions.listByProject(projectId, true)) {
      for (const attachment of this.#attachmentRepository.listBySession(
        session.id,
      )) {
        await this.#attachmentService.remove(attachment.id);
      }
    }
  }

  assertCanSwitchGeminiBinary(): void {
    if (
      this.#activeTurns.size > 0 ||
      this.#manager
        ?.listActiveSessions()
        .some(
          (session) =>
            session.state === "running" ||
            session.state === "awaiting_permission" ||
            session.state === "cancelling",
        )
    ) {
      throw new Error(
        "Gemini kann nicht gewechselt werden, solange eine Session arbeitet.",
      );
    }
  }

  async resetGeminiManager(): Promise<void> {
    this.#unsubscribeManager?.();
    this.#unsubscribeManager = null;
    await this.#manager?.dispose();
    this.#manager = null;
    this.#managerBinaryPath = null;
  }

  async dispose(): Promise<void> {
    for (const buffer of this.#eventBuffers.values()) clearTimeout(buffer.timer);
    for (const sessionId of [...this.#eventBuffers.keys()]) {
      this.#flushBufferedEvents(sessionId);
    }
    await this.resetGeminiManager();
  }

  async #getManager(): Promise<GeminiSessionManager> {
    const configuredBinaryPath = this.#capabilities.requireBinaryPath();
    const launch = this.#capabilities.requireLaunchCommand();
    const managerKey = JSON.stringify([
      configuredBinaryPath,
      launch.binaryPath,
      ...launch.binaryArgs,
    ]);
    if (this.#manager && this.#managerBinaryPath === managerKey) {
      return this.#manager;
    }
    if (this.#manager) await this.resetGeminiManager();

    const manager = new GeminiSessionManager({
      binaryPath: launch.binaryPath,
      binaryArgs: launch.binaryArgs,
    });
    this.#unsubscribeManager = manager.subscribe((event) =>
      this.#handleNormalizedEvent(event),
    );
    this.#manager = manager;
    this.#managerBinaryPath = managerKey;
    return manager;
  }

  async #ensureManagedSession(
    session: AppSession,
    access: Awaited<ReturnType<ProjectService["getCurrentAccess"]>>,
  ): Promise<void> {
    const manager = await this.#getManager();
    if (manager.getSession(session.id)) return;
    await this.#makeRoomForSession(manager, session.id);

    this.#sessions.update(session.id, {
      status: "starting",
      updatedAt: new Date().toISOString(),
    });
    try {
      const snapshot = session.providerSessionId
        ? await manager.loadSession({
            appSessionId: session.id,
            providerSessionId: session.providerSessionId,
            access: toGeminiAccess(access),
          })
        : await manager.createSession({
            appSessionId: session.id,
            access: toGeminiAccess(access),
          });

      const appliedMode = await this.#applyProjectApprovalDefault(
        session.projectId,
        session.id,
        snapshot.modes,
      );

      const now = new Date().toISOString();
      this.#sessions.update(session.id, {
        providerSessionId: snapshot.providerSessionId,
        lastRootRevision: access.rootRevision,
        lastRootFingerprint: access.rootFingerprint,
        status: "idle",
        mode: appliedMode,
        model: snapshot.models?.currentModelId ?? null,
        updatedAt: now,
      });
      this.#sessions.recordRootSnapshot({
        sessionId: session.id,
        rootRevision: access.rootRevision,
        rootFingerprint: access.rootFingerprint,
        capturedAt: now,
        roots: [access.primaryRoot, ...access.additionalRoots],
      });
    } catch (error) {
      this.#sessions.update(session.id, {
        status: "error",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async #getProjectModeSnapshot(
    projectId: string,
    openIfNeeded = true,
  ): Promise<ReturnType<GeminiSessionManager["getSession"]>> {
    this.#projects.get(projectId);
    const projectSessions = this.#sessions.listByProject(projectId, true);
    const projectSessionIds = new Set(projectSessions.map((session) => session.id));
    const active = this.#manager
      ?.listActiveSessions()
      .find((session) => projectSessionIds.has(session.appSessionId));
    if (active || !openIfNeeded) return active;

    const candidate =
      projectSessions.find((session) => !session.archived) ?? projectSessions[0];
    if (!candidate) return undefined;
    const access = await this.#projects.getCurrentAccess(projectId);
    await this.#ensureManagedSession(candidate, access);
    return this.#manager?.getSession(candidate.id);
  }

  async #applyProjectApprovalDefault(
    projectId: string,
    appSessionId: string,
    modes: SessionModeSnapshot | undefined,
  ): Promise<string | null> {
    const project = this.#projects.get(projectId);
    const result = await applyProjectApprovalMode({
      requestedModeId: project.approvalModeId,
      modes,
      setMode: (modeId) => this.#manager!.setMode(appSessionId, modeId),
    });
    if (
      project.approvalModeState !== result.state ||
      (result.state === "gemini_default" && project.approvalModeId !== null)
    ) {
      this.#projects.setApprovalModeState({
        projectId,
        modeId: project.approvalModeId,
        state: result.state,
      });
    }
    return result.currentModeId;
  }

  async #makeRoomForSession(
    manager: GeminiSessionManager,
    targetSessionId: string,
  ): Promise<void> {
    const active = manager.listActiveSessions();
    if (active.length < 3) return;
    const victim = active.find(
      (session) =>
        session.appSessionId !== targetSessionId && session.state === "idle",
    );
    if (!victim) {
      throw new Error(
        "Es laufen bereits drei Gemini-Sessions. Stoppe zuerst eine laufende Anfrage.",
      );
    }
    await manager.disposeSession(victim.appSessionId);
  }

  #handleNormalizedEvent(event: NormalizedAgentEvent): void {
    const active = this.#activeTurns.get(event.appSessionId);
    const sharedEvent = toSharedEvent(event, active);

    switch (event.type) {
      case "session.started":
        this.#safeSessionUpdate(event.appSessionId, { status: "starting" });
        break;
      case "session.ready":
        this.#safeSessionUpdate(event.appSessionId, {
          status: "idle",
          providerSessionId: event.providerSessionId,
          mode: event.payload.modes?.currentModeId ?? null,
          model: event.payload.models?.currentModelId ?? null,
        });
        break;
      case "session.failed":
      case "turn.failed":
        this.#safeSessionUpdate(event.appSessionId, { status: "error" });
        break;
      case "permission.requested":
        this.#safeSessionUpdate(event.appSessionId, {
          status: "awaiting_permission",
        });
        break;
      case "permission.resolved":
        this.#safeSessionUpdate(event.appSessionId, {
          status: active ? "running" : "idle",
        });
        break;
      case "turn.completed":
      case "turn.cancelled":
        this.#safeSessionUpdate(event.appSessionId, { status: "idle" });
        break;
      case "process.disconnected":
        this.#safeSessionUpdate(event.appSessionId, {
          status: "disconnected",
        });
        break;
      case "mode.updated":
        this.#safeSessionUpdate(event.appSessionId, {
          mode: event.payload.currentModeId,
        });
        break;
      case "usage.tokens.observed":
        this.#recordTokenUsage(event.appSessionId, active?.turnId ?? null, {
          observation: event.payload,
          occurredAt: event.occurredAt,
        });
        break;
      case "usage.context.observed":
        this.#recordContextUsage(event.appSessionId, active?.turnId ?? null, {
          observation: event.payload,
          occurredAt: event.occurredAt,
        });
        break;
    }

    if (sharedEvent) {
      this.#queueEvent({
        sessionId: event.appSessionId,
        turnId: active?.turnId ?? null,
        event: sharedEvent,
        timestamp: event.occurredAt,
      });
    }

    if (
      event.type === "turn.completed" ||
      event.type === "turn.cancelled" ||
      event.type === "turn.failed"
    ) {
      this.#activeTurns.delete(event.appSessionId);
    }
  }

  #recordTokenUsage(
    sessionId: string,
    turnId: string | null,
    input: {
      observation: Parameters<UsageService["recordTokens"]>[0]["observation"];
      occurredAt: string;
    },
  ): void {
    try {
      // Without an active turn the observation cannot be de-duplicated by turn
      // id, so it gets its own synthetic key instead of colliding with a real
      // turn and silently replacing it.
      const snapshot = this.#usage.recordTokens({
        sessionId,
        turnId: turnId ?? `untracked-${randomUUID()}`,
        observation: input.observation,
        occurredAt: input.occurredAt,
      });
      this.#publishUsageSnapshot(sessionId, turnId, snapshot, input.occurredAt);
    } catch {
      // A usage bookkeeping failure must never abort the running turn.
    }
  }

  #recordContextUsage(
    sessionId: string,
    turnId: string | null,
    input: {
      observation: Parameters<UsageService["recordContext"]>[0]["observation"];
      occurredAt: string;
    },
  ): void {
    try {
      const snapshot = this.#usage.recordContext({
        sessionId,
        observation: input.observation,
        occurredAt: input.occurredAt,
      });
      this.#publishUsageSnapshot(sessionId, turnId, snapshot, input.occurredAt);
    } catch {
      // See #recordTokenUsage.
    }
  }

  #publishUsageSnapshot(
    sessionId: string,
    turnId: string | null,
    snapshot: UsageSnapshot | null,
    timestamp = new Date().toISOString(),
  ): void {
    if (!snapshot) return;
    this.#queueEvent({
      sessionId,
      turnId,
      event: { type: "usage.updated", snapshot },
      timestamp,
    });
  }

  #handleSyntheticFailure(sessionId: string, error: unknown): void {
    const active = this.#activeTurns.get(sessionId);
    if (!active) return;
    this.#queueEvent({
      sessionId,
      turnId: active.turnId,
      event: {
        type: "turn.failed",
        error: {
          code: "prompt_failed",
          message: error instanceof Error ? error.message : "Prompt fehlgeschlagen",
          retryable: true,
        },
      },
      timestamp: new Date().toISOString(),
    });
    this.#activeTurns.delete(sessionId);
    this.#safeSessionUpdate(sessionId, { status: "error" });
  }

  #safeSessionUpdate(
    sessionId: string,
    update: Omit<SessionUpdate, "updatedAt"> & { updatedAt?: string },
  ): void {
    try {
      this.#sessions.update(sessionId, {
        ...update,
        updatedAt: update.updatedAt ?? new Date().toISOString(),
      });
    } catch {
      // A late process event after deletion must not tear down the ACP loop.
    }
  }

  #queueEvent(input: {
    sessionId: string;
    turnId: string | null;
    event: AgentEvent;
    timestamp: string;
  }): void {
    if (!isDeltaEvent(input.event)) {
      this.#flushBufferedEvents(input.sessionId);
      const envelope = this.#events.append(input);
      void this.#publishEvents([envelope]);
      return;
    }

    let buffer = this.#eventBuffers.get(input.sessionId);
    if (!buffer) {
      buffer = {
        timer: setTimeout(() => this.#flushBufferedEvents(input.sessionId), 32),
        events: [],
      };
      buffer.timer.unref?.();
      this.#eventBuffers.set(input.sessionId, buffer);
    }

    const previous = buffer.events.at(-1);
    if (
      previous &&
      isDeltaEvent(previous.event) &&
      previous.event.type === input.event.type &&
      previous.event.messageId === input.event.messageId &&
      previous.event.delta.length + input.event.delta.length <= 100_000
    ) {
      previous.event = {
        ...previous.event,
        delta: previous.event.delta + input.event.delta,
      };
    } else {
      buffer.events.push(input);
    }
  }

  #flushBufferedEvents(sessionId: string): void {
    const buffer = this.#eventBuffers.get(sessionId);
    if (!buffer) return;
    clearTimeout(buffer.timer);
    this.#eventBuffers.delete(sessionId);
    if (buffer.events.length === 0) return;
    const envelopes = this.#events.appendBatch(buffer.events);
    void this.#publishEvents(envelopes);
  }
}

function toGeminiAccess(
  access: Awaited<ReturnType<ProjectService["getCurrentAccess"]>>,
): GeminiProjectAccess {
  return {
    primaryRoot: access.primaryRoot.realPath,
    additionalRoots: access.additionalRoots.map((root) => root.realPath),
  };
}

function toSharedEvent(
  event: NormalizedAgentEvent,
  active: ActiveTurn | undefined,
): AgentEvent | null {
  switch (event.type) {
    case "session.started":
      return {
        type: "session.started",
        providerSessionId: event.providerSessionId,
      };
    case "session.ready":
      return {
        type: "session.ready",
        modes:
          event.payload.modes?.availableModes.map((mode) => mode.id) ?? [],
        models:
          event.payload.models?.availableModels.map((model) => model.id) ?? [],
      };
    case "session.failed":
      return {
        type: "turn.failed",
        error: {
          code: "session_failed",
          message: event.payload.message,
          retryable: true,
        },
      };
    case "message.user":
      return null;
    case "message.assistant.delta": {
      const delta = contentToText(event.payload.content);
      if (!delta || !active) return null;
      return {
        type: "message.assistant.delta",
        messageId: active.assistantMessageId,
        delta,
      };
    }
    case "message.thought.delta": {
      const delta = contentToText(event.payload.content);
      if (!delta || !active) return null;
      return {
        type: "message.thought.delta",
        messageId: active.thoughtMessageId,
        delta,
      };
    }
    case "tool.started":
      return {
        type: "tool.started",
        toolCallId: event.payload.toolCall.toolCallId,
        title: toolTitle(event.payload.toolCall),
        kind: event.payload.toolCall.kind ?? null,
        arguments: toJson(event.payload.toolCall.rawInput),
      };
    case "tool.updated":
      return {
        type: "tool.updated",
        toolCallId: event.payload.toolCall.toolCallId,
        status: event.payload.toolCall.status ?? "in_progress",
        update: toJson(
          event.payload.toolCall.content ?? event.payload.toolCall.rawOutput,
        ),
      };
    case "tool.completed":
      return {
        type: "tool.completed",
        toolCallId: event.payload.toolCall.toolCallId,
        result: toJson(
          event.payload.toolCall.rawOutput ?? event.payload.toolCall.content,
        ),
      };
    case "tool.failed":
      return {
        type: "tool.failed",
        toolCallId: event.payload.toolCall.toolCallId,
        error: {
          code: "tool_failed",
          message: `${toolTitle(event.payload.toolCall)} ist fehlgeschlagen.`,
          retryable: false,
          details: toJson(event.payload.toolCall.rawOutput),
        },
      };
    case "permission.requested":
      return {
        type: "permission.requested",
        requestId: event.payload.permissionId,
        toolCallId: event.payload.toolCall.toolCallId ?? null,
        title: toolTitle(event.payload.toolCall),
        options: event.payload.options.map((option) => ({
          optionId: option.optionId,
          label: option.name,
          kind: option.kind,
        })),
      };
    case "permission.resolved":
      return event.payload.optionId
        ? {
            type: "permission.resolved",
            requestId: event.payload.permissionId,
            optionId: event.payload.optionId,
          }
        : null;
    // Usage is not a straight passthrough: both observations are aggregated by
    // the UsageService and published as one complete snapshot.
    case "usage.tokens.observed":
    case "usage.context.observed":
      return null;
    case "commands.updated":
      return {
        type: "commands.updated",
        commands: event.payload.commands
          .map((command) => {
            if (!command || typeof command !== "object") return null;
            const value = command as Record<string, unknown>;
            const name =
              typeof value.name === "string"
                ? value.name
                : typeof value.command === "string"
                  ? value.command
                  : null;
            if (!name) return null;
            return {
              name,
              description:
                typeof value.description === "string"
                  ? value.description
                  : null,
            };
          })
          .filter((command): command is NonNullable<typeof command> => !!command),
      };
    case "turn.completed":
      return {
        type: "turn.completed",
        stopReason: event.payload.stopReason,
      };
    case "turn.cancelled":
      return { type: "turn.cancelled", reason: null };
    case "turn.failed":
      return {
        type: "turn.failed",
        error: {
          code: "turn_failed",
          message: event.payload.message,
          retryable: true,
        },
      };
    case "process.disconnected":
      return {
        type: "process.disconnected",
        reason:
          event.payload.message ??
          (event.payload.stderr ||
            "Die Verbindung zu Gemini CLI wurde beendet."),
        exitCode: event.payload.exitCode,
      };
    case "mode.updated":
    case "config.updated":
    case "session.info.updated":
    case "plan.updated":
    case "plan.removed":
      return null;
  }
}

function contentToText(content: NormalizedContent): string | null {
  return content.type === "text" ? content.text : null;
}

function toolTitle(toolCall: NormalizedToolCall): string {
  return (toolCall.title || toolCall.name || "Gemini-Tool").slice(0, 500);
}

function toJson(value: unknown): ReturnType<typeof JsonValueSchema.parse> | null {
  if (value === undefined) return null;
  const direct = JsonValueSchema.safeParse(value);
  if (direct.success) return direct.data;
  try {
    const serialized = JSON.parse(JSON.stringify(value)) as unknown;
    const parsed = JsonValueSchema.safeParse(serialized);
    return parsed.success ? parsed.data : String(value).slice(0, 2_000);
  } catch {
    return String(value).slice(0, 2_000);
  }
}

function isDeltaEvent(
  event: AgentEvent,
): event is Extract<
  AgentEvent,
  { type: "message.assistant.delta" | "message.thought.delta" }
> {
  return (
    event.type === "message.assistant.delta" ||
    event.type === "message.thought.delta"
  );
}

export async function applyProjectApprovalMode(input: {
  requestedModeId: string | null;
  modes: SessionModeSnapshot | undefined;
  setMode: (modeId: string) => Promise<void>;
}): Promise<{
  currentModeId: string | null;
  state: "gemini_default" | "available" | "unavailable";
}> {
  if (input.requestedModeId === null) {
    return {
      currentModeId: input.modes?.currentModeId ?? null,
      state: "gemini_default",
    };
  }

  const offered = input.modes?.availableModes.some(
    (mode) => mode.id === input.requestedModeId,
  );
  if (!offered || !input.modes) {
    return {
      currentModeId: input.modes?.currentModeId ?? null,
      state: "unavailable",
    };
  }

  if (input.modes.currentModeId !== input.requestedModeId) {
    try {
      await input.setMode(input.requestedModeId);
    } catch {
      return {
        currentModeId: input.modes.currentModeId,
        state: "unavailable",
      };
    }
  }
  return { currentModeId: input.requestedModeId, state: "available" };
}

function toProjectApprovalPolicy(
  project: ProjectWithRoots,
  modes: SessionModeSnapshot | undefined,
): ProjectApprovalPolicy {
  const availableModes = (modes?.availableModes ?? []).map((mode) => ({
    id: mode.id,
    name: mode.name,
    description: mode.description ?? null,
    unrestricted: isUnrestrictedMode(mode),
  }));
  let message: string | null = null;
  if (project.approvalModeState === "unavailable") {
    message = project.approvalModeId
      ? `Der gespeicherte Projektmodus „${project.approvalModeId}“ wird von dieser Gemini-Session nicht angeboten. Gemini verwendet deshalb seinen eigenen Standardmodus.`
      : "Gemini verwendet seinen eigenen Standardmodus.";
  } else if (availableModes.length === 0) {
    message =
      "Gemini hat noch keine Projektmodi angeboten. Erstelle oder lade zuerst eine Session.";
  }
  return ProjectApprovalPolicySchema.parse({
    projectId: project.id,
    modeId: project.approvalModeId,
    state: project.approvalModeState,
    currentModeId: modes?.currentModeId ?? null,
    availableModes,
    message,
  });
}

function isUnrestrictedMode(mode: SessionMode): boolean {
  // Gemini defines `yolo` as its allow-all mode. It is exposed only when that
  // exact id was advertised by the current ACP session.
  return mode.id === "yolo";
}
