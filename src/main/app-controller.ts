import { randomUUID } from "node:crypto";
import {
  AppSessionSchema,
  generateSessionTitleFromPrompt,
  JsonValueSchema,
  type AgentEvent,
  type AppSession,
  type CancelTurnInput,
  type CreateSessionInput,
  type DeleteSessionInput,
  GetProjectApprovalPolicyInputSchema,
  type GetSessionReconnectStateInput,
  type ListSessionsInput,
  ProjectApprovalPolicySchema,
  type ProjectApprovalPolicy,
  type ProjectWithRoots,
  type PermissionResponse as UiPermissionResponse,
  type SearchSessionsInput,
  type SessionSearchResult,
  type SendPromptInput,
  type SessionOption,
  type SessionReconnectState,
  type SessionStatus,
  type SetSessionModeInput,
  type SetSessionModelInput,
  SetProjectApprovalPolicyInputSchema,
  type SetProjectApprovalPolicyInput,
  type StreamEnvelope,
  type UpdateSessionInput,
  type UsageSnapshot,
  type AppStats,
  type GetStatsInput,
} from "../shared/contracts";
import type { AttachmentService } from "./attachments/attachment-service";
import type { ContextAttachmentService } from "./context-attachments";
import type { GeminiCapabilityService } from "./capability-service";
import {
  describeGeminiError,
  type NormalizedAgentEvent,
  type NormalizedContent,
  type NormalizedToolCall,
  type ProjectAccess as GeminiProjectAccess,
  type PromptPart,
  type SessionMode,
  type SessionModeSnapshot,
  type SessionModelSnapshot,
} from "./gemini";
import type { ProjectService, ProjectRuntimeCoordinator } from "./projects";
import type { ProjectFileService } from "./project-files";
import { runCapturedCommand } from "./processes/run-command";
import { GeminiSessionManager } from "./sessions";
import type { UsageService } from "./usage";
import {
  type AttachmentRepository,
  type EventRepository,
  type SessionUpdate,
  type SessionRepository,
  type StatsRepository,
} from "./storage";

/**
 * Zustände, die einen laufenden Gemini-Prozess behaupten. Nach einem Neustart
 * — und unter Windows auch nach einem harten Abschuss der App — steht so ein
 * Zustand in der Datenbank, ohne dass noch irgendetwas läuft.
 */
const LIVE_SESSION_STATUSES = [
  "starting",
  "running",
  "awaiting_permission",
  "cancelling",
] as const satisfies readonly SessionStatus[];

/**
 * Ereignisse, nach denen ein Turn noch offen ist. Endet die Timeline auf einem
 * davon, wurde die Antwort nie abgeschlossen und der Renderer bleibt beim
 * Abspielen der Historie in "running" stehen — mitsamt Abbrechen-Knopf.
 */
const OPEN_TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message.user",
  "message.assistant.delta",
  "message.thought.delta",
  "tool.started",
  "tool.updated",
  "permission.requested",
]);

type ActiveTurn = {
  turnId: string;
  assistantMessageId: string;
  thoughtMessageId: string;
  startTime: number;
  projectId: string;
  model: string;
  mode: string | null;
  planDecision?: "accepted" | "rejected" | null;
  linesAdded: number;
  linesDeleted: number;
  filesCreated: number;
  filesModified: number;
  filesDeleted: number;
  toolActivity: Map<string, ToolActivityAnalysis>;
  tokens?: {
    input: number;
    output: number;
    total: number;
    thought: number;
    cached: number;
  };
  /**
   * Der Turn hat bereits sichtbare Ausgabe geliefert. Meldet Gemini danach
   * noch einen Fehler, ist das ein Nachklapp am Turn-Ende und keine
   * gescheiterte Anfrage.
   */
  producedOutput?: boolean;
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

import type { ExternalPromptContextRegistry } from "./integrations/external-prompt-context-registry";

export type AppControllerOptions = {
  projects: ProjectService;
  sessions: SessionRepository;
  events: EventRepository;
  attachmentRepository: AttachmentRepository;
  attachmentService: AttachmentService;
  contextAttachments: ContextAttachmentService;
  projectFiles: ProjectFileService;
  capabilities: GeminiCapabilityService;
  usage: UsageService;
  stats?: StatsRepository;
  publishEvents: (events: StreamEnvelope[]) => void | Promise<void>;
  externalContextRegistry?: ExternalPromptContextRegistry;
};

export class AppController implements ProjectRuntimeCoordinator {
  readonly #projects: ProjectService;
  readonly #sessions: SessionRepository;
  readonly #events: EventRepository;
  readonly #attachmentRepository: AttachmentRepository;
  readonly #attachmentService: AttachmentService;
  readonly #contextAttachments: ContextAttachmentService;
  readonly #projectFiles: ProjectFileService;
  readonly #capabilities: GeminiCapabilityService;
  readonly #usage: UsageService;
  readonly #stats?: StatsRepository;
  readonly #publishEvents: AppControllerOptions["publishEvents"];
  readonly #externalContextRegistry?: ExternalPromptContextRegistry;
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #eventBuffers = new Map<string, PendingEventBuffer>();
  readonly #reconnectedSessions = new Set<string>();
  /**
   * Sessions, deren ACP-Prozess gerade hochgefahren wird. Sie stehen auf
   * `starting`, haben aber noch keinen aktiven Turn — ohne diese Merkliste
   * würde der Abgleich sie fälschlich für verwaist halten.
   */
  readonly #openingSessions = new Set<string>();
  #reconcileTimer: ReturnType<typeof setInterval> | null = null;
  #manager: GeminiSessionManager | null = null;
  #managerBinaryPath: string | null = null;
  #unsubscribeManager: (() => void) | null = null;

  constructor(options: AppControllerOptions) {
    this.#projects = options.projects;
    this.#sessions = options.sessions;
    this.#events = options.events;
    this.#attachmentRepository = options.attachmentRepository;
    this.#attachmentService = options.attachmentService;
    this.#contextAttachments = options.contextAttachments;
    this.#projectFiles = options.projectFiles;
    this.#capabilities = options.capabilities;
    this.#usage = options.usage;
    this.#stats = options.stats;
    this.#publishEvents = options.publishEvents;
    this.#externalContextRegistry = options.externalContextRegistry;
  }

  listSessions(input: ListSessionsInput): AppSession[] {
    // Der Moment, in dem die Oberfläche den Zustand liest, ist auch der
    // richtige, um ihn vorher geradezurücken.
    this.reconcileSessions(input.projectId);
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

    this.#openingSessions.add(appSession.id);
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
        model: snapshot.models?.currentModelId ?? null,
        ...toCachedSessionOptions(snapshot),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.#sessions.update(appSession.id, {
        status: "error",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      this.#openingSessions.delete(appSession.id);
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

  searchSessions(input: SearchSessionsInput): SessionSearchResult {
    const sessions = this.#sessions.listByProject(input.projectId, true);
    const lowerQuery = input.query.toLowerCase();
    const titleMatches = new Set<string>();

    for (const s of sessions) {
      if (s.title.toLowerCase().includes(lowerQuery)) {
        titleMatches.add(s.id);
      }
    }

    const contentMatches = input.searchContent
      ? this.#events.searchByContent(input.projectId, input.query)
      : [];

    const contentMatchMap = new Map(contentMatches.map((m) => [m.sessionId, m.snippet]));

    const allMatchingSessionIds = new Set([
      ...titleMatches,
      ...contentMatchMap.keys(),
    ]);

    const results = Array.from(allMatchingSessionIds).map((sessionId) => ({
      sessionId,
      titleMatches: titleMatches.has(sessionId),
      matchedSnippet: contentMatchMap.get(sessionId) ?? null,
    }));

    return {
      projectId: input.projectId,
      query: input.query,
      results,
    };
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
    await this.#contextAttachments.removeSessionAttachments(input.sessionId);
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
    const projectFilesContext = await this.#projectFiles.buildPromptContext({
      projectId: session.projectId,
      expectedRootRevision: input.expectedRootRevision,
      references: input.projectFiles ?? [],
    });
    const context = await this.#contextAttachments.buildPromptContext({
      projectId: session.projectId,
      sessionId: session.id,
      attachmentIds: input.contextAttachmentIds ?? [],
      imagesSupported: this.#capabilities.snapshot().gemini.images,
    });
    const external = this.#externalContextRegistry
      ? await this.#externalContextRegistry.resolve(input.externalContextRefs ?? [])
      : { parts: [], snapshots: [] };

    const parts: PromptPart[] = [];
    if (this.#reconnectedSessions.has(session.id)) {
      this.#reconnectedSessions.delete(session.id);
      const compressedHistory = this.#buildCompressedHistory(session.id);
      if (compressedHistory) {
        parts.push({
          type: "text",
          text: `[Kontext: Bisheriger Gesprächsverlauf dieser Session]\n${compressedHistory}\n[Ende des bisherigen Verlaufs. Beantworte nun die folgende Benutzeranfrage unter Berücksichtigung dieses Verlaufs:]`,
        });
      }
    }
    parts.push(
      ...external.parts,
      ...projectFilesContext.parts,
      ...context.parts,
    );
    for (const image of images) {
      parts.push({
        type: "image",
        mimeType: image.mimeType,
        data: image.data,
      });
    }
    if (input.text.trim()) parts.push({ type: "text", text: input.text });

    const turnId = randomUUID();
    const lowerText = input.text.trim().toLowerCase();
    let planDecision: "accepted" | "rejected" | null = null;
    if (lowerText.startsWith("plan akzeptiert") || lowerText.startsWith("plan accepted")) {
      planDecision = "accepted";
    } else if (lowerText.startsWith("plan abgelehnt") || lowerText.startsWith("plan rejected")) {
      planDecision = "rejected";
    }

    const activeTurn: ActiveTurn = {
      turnId,
      assistantMessageId: randomUUID(),
      thoughtMessageId: randomUUID(),
      startTime: Date.now(),
      projectId: session.projectId,
      model: session.model || "gemini",
      mode: session.mode,
      planDecision,
      linesAdded: 0,
      linesDeleted: 0,
      filesCreated: 0,
      filesModified: 0,
      filesDeleted: 0,
      toolActivity: new Map(),
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
        contextAttachments: context.snapshots,
        projectFiles: projectFilesContext.snapshots,
        externalContexts: external.snapshots,
      },
      timestamp,
    });
    void this.#publishEvents([userEnvelope]);

    for (const image of images) {
      this.#attachmentRepository.markSent(image.id, session.id, turnId);
    }

    const isInitialTitle = !session.title || session.title.trim() === "Neue Session";
    const nextTitle = isInitialTitle && input.text.trim()
      ? generateSessionTitleFromPrompt(input.text)
      : session.title;

    this.#sessions.update(session.id, {
      title: nextTitle,
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
    if (active && input.turnId && active.turnId !== input.turnId) return;
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

  getSessionReconnectState(
    input: GetSessionReconnectStateInput,
  ): SessionReconnectState {
    const hasHistory = this.#hasPreviousHistory(input.sessionId);
    const reconnected =
      this.#reconnectedSessions.has(input.sessionId) && hasHistory;
    return {
      sessionId: input.sessionId,
      reconnected,
      hasHistory,
    };
  }

  /**
   * Gleicht den gespeicherten Sessionzustand mit der Wirklichkeit ab.
   *
   * Wird die App beendet, während ein Turn läuft, bleibt in der Datenbank
   * `running` stehen und die Timeline endet ohne Abschlussereignis. Beim
   * nächsten Start zeigt die Oberfläche deshalb einen Abbrechen-Knopf für eine
   * Antwort, die niemand mehr schreibt. Hier wird ein solcher Turn
   * nachträglich beendet.
   *
   * Maßstab ist ausschließlich der eigene Prozesszustand: Nur ein Eintrag in
   * `#activeTurns` bedeutet, dass wirklich noch etwas läuft.
   */
  reconcileSessions(projectId?: string): number {
    let repaired = 0;
    for (const session of this.#sessions.listByStatuses(LIVE_SESSION_STATUSES)) {
      if (projectId && session.projectId !== projectId) continue;
      if (this.#activeTurns.has(session.id)) continue;
      if (this.#openingSessions.has(session.id)) continue;
      this.#closeAbandonedTurn(session.id);
      repaired += 1;
    }
    return repaired;
  }

  /**
   * Wiederholter Abgleich für lange Laufzeiten: Endet ein Turn ohne sein
   * Abschlussereignis — etwa weil der Gemini-Prozess weggebrochen ist —,
   * räumt der nächste Durchlauf auf, statt den Zustand bis zum Neustart
   * stehen zu lassen.
   */
  startSessionReconciliation(intervalMs = 60_000): void {
    if (this.#reconcileTimer) return;
    this.#reconcileTimer = setInterval(() => {
      try {
        this.reconcileSessions();
      } catch (error) {
        console.error("[AppController] Sessionabgleich fehlgeschlagen.", error);
      }
    }, intervalMs);
  }

  #closeAbandonedTurn(sessionId: string): void {
    try {
      const latestSeq = this.#events.latestSequence(sessionId);
      const last =
        latestSeq > 0
          ? this.#events.listAfter(sessionId, latestSeq - 1, 1).at(-1)
          : undefined;

      if (last?.turnId && OPEN_TURN_EVENT_TYPES.has(last.event.type)) {
        const envelope = this.#events.append({
          sessionId,
          turnId: last.turnId,
          event: {
            type: "turn.cancelled",
            reason:
              "Diese Antwort lief noch, als die Anwendung beendet wurde. Der Turn wurde deshalb nachträglich abgeschlossen.",
          },
          timestamp: new Date().toISOString(),
        });
        void this.#publishEvents([envelope]);
      }
    } catch (error) {
      console.error(
        `[AppController] Offener Turn von Session ${sessionId} konnte nicht abgeschlossen werden.`,
        error,
      );
    }
    this.#safeSessionUpdate(sessionId, { status: "idle" });
  }

  getStats(input?: GetStatsInput): AppStats {
    if (!this.#stats) {
      throw new Error("StatsRepository ist nicht initialisiert.");
    }
    return this.#stats.getAggregatedStats(input);
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
    const managedSession = this.#manager?.getSession(input.sessionId);
    const available = managedSession?.models?.availableModels ?? session.availableModels;
    if (available && available.length > 0 && !available.some((model) => model.id === input.modelId)) {
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
    await this.#contextAttachments.removeProjectAttachments(projectId);
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
    if (this.#reconcileTimer) {
      clearInterval(this.#reconcileTimer);
      this.#reconcileTimer = null;
    }
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

    this.#openingSessions.add(session.id);
    this.#sessions.update(session.id, {
      status: "starting",
      updatedAt: new Date().toISOString(),
    });
    try {
      let snapshot: Awaited<ReturnType<GeminiSessionManager["createSession"]>>;
      if (session.providerSessionId) {
        try {
          snapshot = await manager.loadSession({
            appSessionId: session.id,
            providerSessionId: session.providerSessionId,
            access: toGeminiAccess(access),
          });
        } catch (loadError) {
          console.warn(
            `[AppController] Konnte vorherige ACP-Session ${session.providerSessionId} für Session ${session.id} nicht laden. Erstelle neue Session. Fehler:`,
            loadError,
          );
          this.#reconnectedSessions.add(session.id);
          snapshot = await manager.createSession({
            appSessionId: session.id,
            access: toGeminiAccess(access),
          });
        }
      } else {
        snapshot = await manager.createSession({
          appSessionId: session.id,
          access: toGeminiAccess(access),
        });
      }

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
        ...toCachedSessionOptions(snapshot),
        updatedAt: now,
      });
      // Der Root-Audittrail ist Buchhaltung, kein Teil des Sendewegs: Die
      // Session läuft an dieser Stelle bereits. Ein Fehler beim Schreiben darf
      // den Prompt deshalb nicht mehr abbrechen — die für den Root-Vergleich
      // maßgeblichen Werte stehen ohnehin am Sessiondatensatz.
      try {
        this.#sessions.recordRootSnapshot({
          sessionId: session.id,
          rootRevision: access.rootRevision,
          rootFingerprint: access.rootFingerprint,
          capturedAt: now,
          roots: [access.primaryRoot, ...access.additionalRoots],
        });
      } catch (auditError) {
        console.error(
          `[AppController] Root-Audittrail für Session ${session.id} konnte nicht geschrieben werden.`,
          auditError,
        );
      }
    } catch (error) {
      this.#sessions.update(session.id, {
        status: "error",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      this.#openingSessions.delete(session.id);
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
    if (
      active &&
      (event.type === "message.assistant.delta" ||
        event.type === "tool.started" ||
        event.type === "tool.completed")
    ) {
      active.producedOutput = true;
    }
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
          ...toCachedSessionOptions(event.payload),
        });
        break;
      case "session.failed":
        this.#safeSessionUpdate(event.appSessionId, { status: "error" });
        break;
      case "turn.failed":
        this.#safeSessionUpdate(event.appSessionId, {
          status: active?.producedOutput ? "idle" : "error",
        });
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
      case "tool.started":
      case "tool.updated":
      case "tool.completed": {
        if (active) {
          const toolCallId = event.payload.toolCall.toolCallId;
          active.toolActivity.set(
            toolCallId,
            mergeToolActivity(
              active.toolActivity.get(toolCallId),
              analyzeToolActivity(event.payload.toolCall),
            ),
          );
        }
        break;
      }
      case "usage.tokens.observed": {
        if (active) {
          active.tokens = {
            input: event.payload.tokens.input ?? 0,
            output: event.payload.tokens.output ?? 0,
            total: event.payload.tokens.total ?? ((event.payload.tokens.input ?? 0) + (event.payload.tokens.output ?? 0)),
            thought: event.payload.tokens.thought ?? 0,
            cached: event.payload.tokens.cachedRead ?? 0,
          };
          if (event.payload.byModel && event.payload.byModel.length > 0) {
            active.model = event.payload.byModel[0].model;
          }
        }
        this.#recordTokenUsage(event.appSessionId, active?.turnId ?? null, {
          observation: event.payload,
          occurredAt: event.occurredAt,
        });
        break;
      }
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
      if (active && this.#stats) {
        try {
          const project = this.#projects.getById(active.projectId);
          if (project.statsEnabled) {
            const durationMs = Math.max(0, Date.now() - active.startTime);
            const status =
              event.type === "turn.completed"
                ? "completed"
                : event.type === "turn.cancelled"
                  ? "cancelled"
                  : "failed";

            let linesAdded = active.linesAdded;
            let linesDeleted = active.linesDeleted;
            let filesCreated = active.filesCreated;
            let filesModified = active.filesModified;
            let filesDeleted = active.filesDeleted;
            const skillsUsedMap: Record<string, number> = {};
            const mcpUsedMap: Record<string, number> = {};
            const gitActionsMap: Record<string, number> = {};
            const shellCommandsMap: Record<string, number> = {};

            for (const act of active.toolActivity.values()) {
              linesAdded += act.diff.added;
              linesDeleted += act.diff.deleted;
              filesCreated += act.filesCreated;
              filesModified += act.filesModified;
              filesDeleted += act.filesDeleted;
              for (const s of act.skills) {
                skillsUsedMap[s] = (skillsUsedMap[s] || 0) + 1;
              }
              for (const m of act.mcpTools) {
                mcpUsedMap[m] = (mcpUsedMap[m] || 0) + 1;
              }
              for (const g of act.gitActions) {
                gitActionsMap[g] = (gitActionsMap[g] || 0) + 1;
              }
              for (const cmd of act.shellCommands) {
                shellCommandsMap[cmd] = (shellCommandsMap[cmd] || 0) + 1;
              }
            }

            this.#stats.recordTurnMetric({
              turnId: active.turnId,
              sessionId: event.appSessionId,
              projectId: active.projectId,
              model: active.model,
              mode: active.mode,
              durationMs,
              inputTokens: active.tokens?.input ?? 0,
              outputTokens: active.tokens?.output ?? 0,
              totalTokens: active.tokens?.total ?? 0,
              thoughtTokens: active.tokens?.thought ?? 0,
              cachedTokens: active.tokens?.cached ?? 0,
              linesAdded,
              linesDeleted,
              filesCreated,
              filesModified,
              filesDeleted,
              skillsUsedJson: JSON.stringify(skillsUsedMap),
              mcpUsedJson: JSON.stringify(mcpUsedMap),
              gitActionsJson: JSON.stringify(gitActionsMap),
              shellCommandsJson: JSON.stringify(shellCommandsMap),
              planDecision: active.planDecision,
              status,
              createdAt: event.occurredAt,
            });
          }
        } catch {
          // ignore if project was deleted
        }
      }

      const brokenSession =
        event.type === "turn.failed" && !active?.producedOutput;
      this.#activeTurns.delete(event.appSessionId);
      try {
        this.#sessions.update(event.appSessionId, {
          status: brokenSession ? "error" : "idle",
          updatedAt: event.occurredAt,
        });
      } catch {
        // ignore if session was already deleted
      }
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
        severity: active.producedOutput ? "warning" : "error",
        error: {
          code: "prompt_failed",
          ...describeGeminiError(error),
          retryable: true,
        },
      },
      timestamp: new Date().toISOString(),
    });
    this.#activeTurns.delete(sessionId);
    this.#safeSessionUpdate(sessionId, {
      status: active.producedOutput ? "idle" : "error",
    });
  }

  #buildCompressedHistory(sessionId: string): string | null {
    const envelopes = this.#events.listAfter(sessionId, 0, 1000);
    if (envelopes.length === 0) return null;

    const turns: Array<{ role: "User" | "Assistant"; text: string }> = [];
    let currentAssistantText = "";

    for (const env of envelopes) {
      const event = env.event;
      if (event.type === "message.user") {
        if (currentAssistantText.trim()) {
          turns.push({ role: "Assistant", text: currentAssistantText.trim() });
          currentAssistantText = "";
        }
        if (event.text && event.text.trim()) {
          turns.push({ role: "User", text: event.text.trim() });
        }
      } else if (event.type === "message.assistant.delta") {
        currentAssistantText += event.delta;
      } else if (
        event.type === "turn.completed" ||
        event.type === "turn.failed" ||
        event.type === "turn.cancelled"
      ) {
        if (currentAssistantText.trim()) {
          turns.push({ role: "Assistant", text: currentAssistantText.trim() });
          currentAssistantText = "";
        }
      }
    }

    if (currentAssistantText.trim()) {
      turns.push({ role: "Assistant", text: currentAssistantText.trim() });
    }

    if (turns.length === 0) return null;

    return turns
      .map((t) => {
        const text =
          t.text.length > 2000
            ? `${t.text.slice(0, 1950)}... [gekürzt]`
            : t.text;
        return `${t.role}: ${text}`;
      })
      .join("\n\n");
  }

  #hasPreviousHistory(sessionId: string): boolean {
    const envelopes = this.#events.listAfter(sessionId, 0, 10);
    return envelopes.some(
      (env) =>
        env.event.type === "message.user" ||
        env.event.type === "message.assistant.delta",
    );
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

/**
 * The picker contents of a live ACP session, in the shape the session cache
 * stores. A list the agent did not report is left out rather than emptied —
 * silence about models says nothing about what an earlier session learned.
 */
function toCachedSessionOptions(snapshot: {
  readonly modes?: SessionModeSnapshot;
  readonly models?: SessionModelSnapshot;
}): Pick<SessionUpdate, "availableModels" | "availableModes"> {
  return {
    ...(snapshot.models
      ? { availableModels: snapshot.models.availableModels.map(toSessionOption) }
      : {}),
    ...(snapshot.modes
      ? { availableModes: snapshot.modes.availableModes.map(toSessionOption) }
      : {}),
  };
}

function toSessionOption(option: {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}): SessionOption {
  return {
    id: option.id,
    name: option.name,
    ...(option.description ? { description: option.description } : {}),
  };
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
        providerSessionId: event.providerSessionId,
        modes:
          event.payload.modes?.availableModes.map((mode) => mode.id) ?? [],
        models:
          event.payload.models?.availableModels.map((model) => model.id) ?? [],
      };
    case "session.failed":
      return {
        type: "turn.failed",
        severity: "error",
        error: {
          code: "session_failed",
          message: event.payload.message,
          retryable: true,
          ...(event.payload.details ? { details: event.payload.details } : {}),
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
        // Kam die Antwort schon an, meldet die Oberfläche einen Hinweis statt
        // eines Fehlschlags — sonst steht eine rote Fehlermeldung unter einer
        // vollständigen Antwort.
        severity: active?.producedOutput ? "warning" : "error",
        error: {
          code: "turn_failed",
          message: event.payload.message,
          retryable: true,
          ...(event.payload.details ? { details: event.payload.details } : {}),
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

export function extractLineDiffCounts(toolCall: NormalizedToolCall): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;

  const countLines = (str: string): number => {
    if (!str || typeof str !== "string") return 0;
    const lines = str.split(/\r?\n/);
    return lines.length > 1 && lines[lines.length - 1] === ""
      ? lines.length - 1
      : lines.length;
  };

  const processDiffString = (str: string) => {
    if (!str || typeof str !== "string") return;
    if (str.includes("@@") || str.startsWith("---") || str.startsWith("diff --git") || str.startsWith("+++")) {
      const lines = str.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        else if (line.startsWith("-") && !line.startsWith("---")) deleted++;
      }
    }
  };

  const inspect = (data: unknown, depth = 0) => {
    if (!data || depth > 5) return;

    if (typeof data === "string") {
      const trimmed = data.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          inspect(parsed, depth + 1);
          return;
        } catch {
          // not JSON, continue
        }
      }
      processDiffString(data);
      return;
    }

    if (Array.isArray(data)) {
      for (const item of data) {
        inspect(item, depth + 1);
      }
      return;
    }

    if (typeof data === "object") {
      const obj = data as Record<string, unknown>;

      // 1. Direct diff / patch strings
      if (typeof obj.diff === "string") processDiffString(obj.diff);
      if (typeof obj.patch === "string") processDiffString(obj.patch);
      if (typeof obj.unified_diff === "string") processDiffString(obj.unified_diff);
      if (typeof obj.delta === "string") processDiffString(obj.delta);

      // 2. Specific tool replacement fields (Antigravity, Gemini tools, Claude tools, etc.)
      if (typeof obj.ReplacementContent === "string") {
        added += countLines(obj.ReplacementContent);
      }
      if (typeof obj.TargetContent === "string") {
        deleted += countLines(obj.TargetContent);
      }
      if (typeof obj.CodeContent === "string") {
        added += countLines(obj.CodeContent);
      }

      // 3. Snake_case & camelCase variations
      if (typeof obj.new_str === "string") added += countLines(obj.new_str);
      if (typeof obj.old_str === "string") deleted += countLines(obj.old_str);
      if (typeof obj.newStr === "string") added += countLines(obj.newStr);
      if (typeof obj.oldStr === "string") deleted += countLines(obj.oldStr);
      if (typeof obj.new_string === "string") added += countLines(obj.new_string);
      if (typeof obj.old_string === "string") deleted += countLines(obj.old_string);
      if (typeof obj.new_text === "string") added += countLines(obj.new_text);
      if (typeof obj.old_text === "string") deleted += countLines(obj.old_text);
      if (typeof obj.newText === "string") added += countLines(obj.newText);
      if (typeof obj.oldText === "string") deleted += countLines(obj.oldText);
      if (typeof obj.new_content === "string") added += countLines(obj.new_content);
      if (typeof obj.old_content === "string") deleted += countLines(obj.old_content);
      if (typeof obj.newContent === "string") added += countLines(obj.newContent);
      if (typeof obj.oldContent === "string") deleted += countLines(obj.oldContent);

      if (typeof obj.replacement === "string") added += countLines(obj.replacement);
      if (typeof obj.target === "string" && typeof obj.replacement === "string") deleted += countLines(obj.target);
      if (typeof obj.replace === "string") added += countLines(obj.replace);
      if (typeof obj.find === "string" && typeof obj.replace === "string") deleted += countLines(obj.find);

      // 4. File creation / overwrite (content, contents, file_content, file_text, code)
      const isReplacement =
        obj.ReplacementContent !== undefined ||
        obj.new_str !== undefined ||
        obj.newStr !== undefined ||
        obj.new_string !== undefined ||
        obj.new_text !== undefined ||
        obj.newText !== undefined ||
        obj.new_content !== undefined ||
        obj.newContent !== undefined ||
        obj.replacement !== undefined ||
        obj.replace !== undefined ||
        obj.TargetContent !== undefined ||
        obj.old_str !== undefined ||
        obj.oldStr !== undefined ||
        obj.old_string !== undefined ||
        obj.old_text !== undefined ||
        obj.oldText !== undefined ||
        obj.old_content !== undefined ||
        obj.oldContent !== undefined;

      if (!isReplacement) {
        if (typeof obj.content === "string" && (toolCall.kind === "write" || toolCall.kind === "edit" || !obj.type)) {
          added += countLines(obj.content);
        } else if (typeof obj.contents === "string") {
          added += countLines(obj.contents);
        } else if (typeof obj.file_content === "string") {
          added += countLines(obj.file_content);
        } else if (typeof obj.file_text === "string") {
          added += countLines(obj.file_text);
        } else if (typeof obj.code === "string" && (toolCall.kind === "write" || toolCall.kind === "edit")) {
          added += countLines(obj.code);
        }
      }

      // 5. Nested arrays like `edits`, `replacements`, `changes`, `hunks`, `files`
      if (Array.isArray(obj.edits)) inspect(obj.edits, depth + 1);
      if (Array.isArray(obj.replacements)) inspect(obj.replacements, depth + 1);
      if (Array.isArray(obj.changes)) inspect(obj.changes, depth + 1);
      if (Array.isArray(obj.hunks)) inspect(obj.hunks, depth + 1);
      if (Array.isArray(obj.files)) inspect(obj.files, depth + 1);
    }
  };

  if (toolCall.rawInput) inspect(toolCall.rawInput);
  if (toolCall.rawOutput) inspect(toolCall.rawOutput);
  if (toolCall.content) inspect(toolCall.content);

  return { added, deleted };
}

export type ToolActivityAnalysis = {
  diff: { added: number; deleted: number };
  filesCreated: number;
  filesModified: number;
  filesDeleted: number;
  skills: string[];
  mcpTools: string[];
  gitActions: string[];
  shellCommands: string[];
};

/**
 * ACP meldet einen Werkzeugaufruf in mehreren Nachrichten: `tool_call` trägt
 * Titel und Art, die folgenden `tool_call_update` nur noch Status und Inhalt.
 * Würde jede Nachricht die vorherige Auswertung ersetzen, bliebe am Ende die
 * leere Auswertung des letzten Updates stehen — genau deshalb blieben Skills,
 * MCP-, Git- und Shell-Zähler dauerhaft null.
 */
export function mergeToolActivity(
  previous: ToolActivityAnalysis | undefined,
  next: ToolActivityAnalysis,
): ToolActivityAnalysis {
  if (!previous) return next;

  // Innerhalb *eines* Aufrufs leitet jede Nachricht dieselben Bezeichner
  // erneut ab; die Vereinigung verhindert Doppelzählung, behält aber, was nur
  // die erste Nachricht wusste.
  const union = (before: string[], after: string[]): string[] =>
    after.length > 0 ? [...new Set([...before, ...after])] : before;

  // Bei den Dateizählern gewinnt die vollständigere Auswertung als Ganzes,
  // sonst summierten sich "angelegt" der einen und "geändert" der anderen
  // Nachricht zu zwei Dateien.
  const previousFiles =
    previous.filesCreated + previous.filesModified + previous.filesDeleted;
  const nextFiles = next.filesCreated + next.filesModified + next.filesDeleted;
  const files = nextFiles >= previousFiles ? next : previous;

  return {
    diff: {
      added: Math.max(previous.diff.added, next.diff.added),
      deleted: Math.max(previous.diff.deleted, next.diff.deleted),
    },
    filesCreated: files.filesCreated,
    filesModified: files.filesModified,
    filesDeleted: files.filesDeleted,
    skills: union(previous.skills, next.skills),
    mcpTools: union(previous.mcpTools, next.mcpTools),
    gitActions: union(previous.gitActions, next.gitActions),
    shellCommands: union(previous.shellCommands, next.shellCommands),
  };
}

export function analyzeToolActivity(toolCall: NormalizedToolCall): ToolActivityAnalysis {
  const diff = extractLineDiffCounts(toolCall);
  let filesCreated = 0;
  let filesModified = 0;
  let filesDeleted = 0;
  const skills: string[] = [];
  const mcpTools: string[] = [];
  const gitActions: string[] = [];
  const shellCommands: string[] = [];

  const rawName = (toolCall.name || toolCall.title || "").trim();
  const nameLower = rawName.toLowerCase();
  const kindLower = (toolCall.kind || "").toLowerCase();

  const getRawInputObject = (): Record<string, unknown> | null => {
    if (!toolCall.rawInput) return null;
    if (typeof toolCall.rawInput === "object" && toolCall.rawInput !== null) {
      return toolCall.rawInput as Record<string, unknown>;
    }
    if (typeof toolCall.rawInput === "string") {
      try {
        const parsed = JSON.parse(toolCall.rawInput);
        if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
      } catch {}
    }
    return null;
  };

  const inputObj = getRawInputObject();

  /**
   * Gemini CLI setzt in seinen ACP-Nachrichten weder `name` (im Protokoll als
   * experimentell markiert) noch `rawInput`. Verlässlich sind nur `kind` und
   * `title` — und der Titel eines Shell-Aufrufs *ist* der Befehl. Deshalb
   * dienen beide hier als gleichwertige Quellen neben `rawInput`.
   */
  const isExecuteKind = kindLower === "execute";
  const titleText = (toolCall.title ?? "").trim();

  // 1. File operations classification
  if (
    nameLower.includes("create_file") ||
    nameLower.includes("write_to_file") ||
    nameLower.includes("write_file") ||
    nameLower.includes("new_file") ||
    kindLower === "write"
  ) {
    if (inputObj?.Overwrite === true) {
      filesModified++;
    } else {
      filesCreated++;
    }
  } else if (
    nameLower.includes("replace_file_content") ||
    nameLower.includes("edit_file") ||
    nameLower.includes("edit") ||
    nameLower.includes("patch") ||
    nameLower.includes("apply_diff") ||
    nameLower.includes("insert_content") ||
    nameLower.includes("str_replace") ||
    kindLower === "edit"
  ) {
    filesModified++;
  } else if (
    nameLower.includes("delete_file") ||
    nameLower.includes("remove_file") ||
    nameLower.includes("unlink") ||
    nameLower === "rm"
  ) {
    filesDeleted++;
  }

  // 2. Skill usage classification
  if (
    nameLower === "skill" ||
    nameLower === "run_skill" ||
    nameLower === "use_skill" ||
    nameLower === "execute_skill" ||
    nameLower === "activate_skill" ||
    nameLower.startsWith("activate_skill") ||
    nameLower.startsWith("skill_") ||
    nameLower.startsWith("skill:")
  ) {
    let skillName = "";
    if (inputObj?.skillName && typeof inputObj.skillName === "string") {
      skillName = inputObj.skillName;
    } else if (inputObj?.skill_name && typeof inputObj.skill_name === "string") {
      skillName = inputObj.skill_name;
    } else if (inputObj?.skill && typeof inputObj.skill === "string") {
      skillName = inputObj.skill;
    } else if (inputObj?.name && typeof inputObj.name === "string") {
      skillName = inputObj.name;
    } else if (titleText) {
      // Ohne rawInput bleibt der Titel, etwa: Activate skill "pdf"
      const fromTitle = titleText.match(/skill[\s:"'\u201c\u201e]*([a-zA-Z0-9_@./-]+)/i);
      skillName = fromTitle?.[1] ?? "";
    } else if (nameLower.startsWith("skill_")) {
      skillName = rawName.slice(6);
    } else if (nameLower.startsWith("skill:")) {
      skillName = rawName.slice(6);
    }
    skills.push((skillName.trim() || "Allgemein").slice(0, 100));
  } else {
    /**
     * Ohne `name` bleibt nur der Titel. Er wird bewusst nur am Anfang geprüft:
     * "Activate skill \"pdf\"" ist eine Skill-Aktivierung, ein Shell-Befehl,
     * der irgendwo das Wort skill enthält, dagegen nicht.
     */
    const fromTitle = titleText.match(
      /^\s*(?:activate|activating|use|run|execute|aktiviere)?\s*skill[\s:"'\u201c\u201e]+([a-zA-Z0-9_@./-]+)/i,
    );
    if (fromTitle?.[1]) {
      skills.push(fromTitle[1].slice(0, 100));
    }
  }

  // 3. MCP (Model Context Protocol) usage classification
  if (
    kindLower === "mcp" ||
    nameLower.startsWith("mcp__") ||
    nameLower.startsWith("mcp_") ||
    nameLower.startsWith("mcp:") ||
    nameLower.includes("__mcp__") ||
    /\(\s*[^)]+\s+mcp\s+server\s*\)/i.test(rawName)
  ) {
    let mcpName = rawName;
    // Gemini beschriftet MCP-Werkzeuge als "toolName (serverName MCP Server)".
    const labelled = rawName.match(/^(.*?)\s*\(\s*([^)]+?)\s+MCP\s+Server\s*\)\s*$/i);
    if (labelled?.[1] && labelled?.[2]) {
      mcpName = `${labelled[2].trim()}:${labelled[1].trim()}`;
    }
    if (nameLower.startsWith("mcp__")) {
      mcpName = rawName.slice(5).replace("__", ":");
    } else if (nameLower.startsWith("mcp_")) {
      mcpName = rawName.slice(4).replace("_", ":");
    } else if (nameLower.startsWith("mcp:")) {
      mcpName = rawName.slice(4);
    }
    mcpTools.push((mcpName || "MCP-Tool").slice(0, 100));
  }

  // 4. Shell commands & Git actions classification
  if (
    nameLower.includes("command") ||
    nameLower.includes("terminal") ||
    nameLower.includes("bash") ||
    nameLower.includes("exec") ||
    nameLower.includes("shell") ||
    nameLower === "sh" ||
    nameLower === "zsh" ||
    isExecuteKind
  ) {
    const cmdStr =
      (typeof inputObj?.command === "string" ? inputObj.command : "") ||
      (typeof inputObj?.CommandLine === "string" ? inputObj.CommandLine : "") ||
      (typeof inputObj?.cmd === "string" ? inputObj.cmd : "") ||
      (typeof inputObj?.script === "string" ? inputObj.script : "") ||
      // Ohne rawInput steht der Befehl im Titel; Gemini hängt eine optionale
      // Beschreibung in Klammern an, die nicht Teil der Kommandozeile ist.
      (isExecuteKind ? titleText.replace(/\s*\([^()]*\)\s*$/, "").trim() : "");

    if (cmdStr.trim()) {
      const subCommands = cmdStr.split(/&&|;|\|\||\|/).map((c) => c.trim()).filter(Boolean);

      for (const sub of subCommands) {
        const tokens = sub.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) continue;
        const first = tokens[0].replace(/^(?:sudo|env|nohup)\s+/, "");
        const binary = first.split("/").pop() || first;

        if (binary === "git" && tokens.length > 1) {
          const gitSub = tokens[1].toLowerCase().replace(/^--?[a-z-]+$/, "");
          if (gitSub) {
            gitActions.push(gitSub.slice(0, 50));
          } else {
            gitActions.push("other");
          }
          if (gitSub === "rm") filesDeleted++;
        } else if (binary === "rm" || binary === "unlink") {
          filesDeleted++;
        } else if (binary === "touch" || binary === "mkdir") {
          filesCreated++;
        }

        let signature = binary;
        if (["npm", "yarn", "pnpm", "bun", "cargo", "go", "pytest", "python", "node", "docker", "git"].includes(binary) && tokens.length > 1) {
          if (tokens[1] === "run" && tokens.length > 2) {
            signature = `${binary} run ${tokens[2]}`;
          } else {
            signature = `${binary} ${tokens[1]}`;
          }
        }
        shellCommands.push(signature.slice(0, 50));
      }
    }
  } else if (nameLower.startsWith("git_")) {
    const action = nameLower.slice(4);
    gitActions.push(action.slice(0, 50));
  }

  // 5. Angelegt oder geändert? ACP liefert die Änderung als Diff-Block, und
  // ein fehlender alter Text ist die einzige verlässliche Unterscheidung —
  // Gemini meldet für beides dieselbe Art "edit". Der Inhalt schlägt deshalb
  // die namensbasierte Einordnung oben.
  if (Array.isArray(toolCall.content)) {
    let created = 0;
    let modified = 0;
    for (const entry of toolCall.content) {
      if (!entry || typeof entry !== "object") continue;
      const block = entry as { type?: unknown; oldText?: unknown };
      if (block.type !== "diff") continue;
      if (block.oldText === null || block.oldText === undefined || block.oldText === "") {
        created += 1;
      } else {
        modified += 1;
      }
    }
    if (created > 0 || modified > 0) {
      filesCreated = created;
      filesModified = modified;
    }
  }

  return {
    diff,
    filesCreated,
    filesModified,
    filesDeleted,
    skills,
    mcpTools,
    gitActions,
    shellCommands,
  };
}
