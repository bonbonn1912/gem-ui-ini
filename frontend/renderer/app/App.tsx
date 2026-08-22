import { createEffect, createRenderEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Icon } from "../components/Icon";
import {
  Composer,
  type ComposerAttachment,
  type ComposerDraft,
} from "../features/attachments/Composer";
import { AttachmentsPanel } from "../features/attachments/AttachmentsPanel";
import { LiveViewModal } from "../features/attachments/LiveViewModal";
import { useContextAttachments } from "../features/attachments/useContextAttachments";
import { ChatHeader } from "../features/chat/ChatHeader";
import { PanelRail, type PanelRailItem } from "../features/chat/PanelRail";
import { Timeline } from "../features/chat/Timeline";
import {
  ReconnectHistoryBanner,
  ReconnectHistoryModal,
} from "../features/chat/ReconnectHistoryDialog";
import { chatReducer, createChatState, type ChatAction, type TurnPhase } from "../features/chat/reducer";
import { ChangesPanel } from "../features/git/ChangesPanel";
import type { DiffSelection } from "../features/git/DiffViewer";
import {
  gitStatusBaseline,
  useGitChangePreviews,
  type GitPreviewTrigger,
} from "../features/git/useGitChangePreviews";
import { useGitProjectStatus } from "../features/git/useGitProjectStatus";
import { ProjectDialog } from "../features/projects/ProjectDialog";
import { ProjectSettingsDialog } from "../features/projects/ProjectSettingsDialog";
import { Sidebar } from "../features/sessions/Sidebar";
import { TodosPanel } from "../features/todos/TodosPanel";
import { useTodos } from "../features/todos/useTodos";
import { GitLabPanel, type ReviewDelivery } from "../features/gitlab/GitLabPanel";
import { JiraIssueView } from "../features/jira/JiraIssueView";
import { useJiraIssue } from "../features/jira/useJiraIssue";
import { McpPanel } from "../features/mcp/McpPanel";
import { SkillsPanel } from "../features/skills/SkillsPanel";
import {
  generateSessionTitleFromPrompt,
  type AppCapabilities,
  type AppProject,
  type AppSession,
  type ExternalPromptContextRef,
  type GitLabRepositoryCandidate,
  type GitFileChange,
  type PreparedExternalContext,
  type GitProjectStatus,
  type ProjectFileSearchEntry,
  type ProjectRootCandidate,
  type Todo,
  type UiError,
  type StreamEnvelope,
} from "../types";
import { createClientRequestId } from "../utils/client-request-id";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Eine unerwartete Aktion ist fehlgeschlagen.";
}

function isProjectRootAccessError(error: unknown): boolean {
  const message = messageFrom(error);
  return (
    message.includes("ProjectRootValidationError") ||
    message.includes("keinen Zugriff auf den Projektordner") ||
    message.includes("root_not_accessible")
  );
}

function sessionStatusFromEvents(events: StreamEnvelope[]): AppSession["status"] | null {
  for (const { event } of [...events].reverse()) {
    switch (event.type) {
      case "session.ready":
      case "turn.completed":
      case "turn.cancelled":
        return "idle";
      case "permission.requested":
        return "awaiting_permission";
      case "turn.failed":
        return "error";
      case "process.disconnected":
        return "disconnected";
      case "session.started":
        return "starting";
      case "message.user":
      case "message.assistant.delta":
      case "message.thought.delta":
      case "tool.started":
      case "tool.updated":
      case "tool.completed":
      case "tool.failed":
      case "permission.resolved":
        return "running";
      default:
        break;
    }
  }
  return null;
}

function LoadingScreen() {
  return (
    <main class="boot-screen" aria-label="GeminUI wird geladen">
      <div class="boot-brand"><span><Icon name="sparkle" size={25} /></span><strong>GeminUI</strong></div>
      <div class="boot-progress"><i /></div>
      <p>Desktop-Client wird vorbereitet …</p>
    </main>
  );
}

function OnboardingScreen({
  capabilities,
  onRetry,
  onPickGemini,
}: {
  capabilities: AppCapabilities;
  onRetry: () => void;
  onPickGemini?: () => void;
}) {
  const status = !capabilities.gemini.binaryPath
    ? "not_found"
    : !capabilities.gemini.acp
      ? "incompatible"
      : "error";
  const title =
    status === "not_found"
      ? "Gemini CLI wurde nicht gefunden"
      : status === "incompatible"
        ? "Gemini CLI ist nicht kompatibel"
          : "Gemini CLI ist nicht bereit";
  const body = status === "not_found"
      ? "Installiere Gemini CLI oder stelle sicher, dass die ausführbare Datei für Desktop-Apps erreichbar ist."
      : "Prüfe Version und ACP-Unterstützung deiner lokalen Gemini-Installation.";

  return (
    <main class="onboarding-screen">
      <section class="onboarding-card">
        <div class="onboarding-logo"><Icon name="sparkle" size={28} /></div>
        <p class="eyebrow">Lokaler Desktop-Client</p>
        <h1>{title}</h1>
        <p class="onboarding-copy">{body}</p>
        <div class="onboarding-steps">
          <div><span>1</span><p><strong>Gemini CLI installieren</strong><code>npm install -g @google/gemini-cli</code></p></div>
          <div><span>2</span><p><strong>Einmal anmelden</strong><code>gemini</code></p></div>
          <div><span>3</span><p><strong>Hier erneut prüfen</strong><small>GeminUI verwendet deine bestehende lokale Anmeldung.</small></p></div>
        </div>
        <div class="onboarding-actions">
          <button class="primary-button" type="button" onClick={onPickGemini} disabled={!onPickGemini} title={onPickGemini ? "Installierte Gemini CLI auswählen" : "Die Dateiauswahl ist in diesem Build noch nicht verfügbar"}>
            <Icon name="folder" size={16} /> Gemini auswählen
          </button>
          <button class="secondary-button onboarding-retry" type="button" onClick={onRetry}>
            <Icon name="refresh" size={16} /> Erneut prüfen
          </button>
        </div>
        {!onPickGemini && <p class="binary-picker-hint">Die Binary-Auswahl ist noch nicht verfügbar. Prüfe stattdessen deinen PATH und versuche es erneut.</p>}
        {capabilities.gemini.version && <p class="detected-version">Erkannt: Gemini {capabilities.gemini.version}</p>}
      </section>
    </main>
  );
}

function EmptyWorkspace({ onCreateProject }: { onCreateProject: () => void }) {
  return (
    <main class="workspace-empty">
      <div class="empty-illustration" aria-hidden="true">
        <span class="empty-folder empty-folder--back"><Icon name="folder" size={42} /></span>
        <span class="empty-folder empty-folder--front"><Icon name="folder-plus" size={48} /></span>
        <i /><i /><i />
      </div>
      <p class="eyebrow">Willkommen bei GeminUI</p>
      <h1>Dein erster Workspace</h1>
      <p>Verbinde einen Hauptordner und bei Bedarf weitere Ordner. Alle werden Teil desselben Gemini-Kontexts.</p>
      <button class="primary-button" type="button" onClick={onCreateProject}><Icon name="folder-plus" size={17} /> Projekt anlegen</button>
      <div class="empty-benefits">
        <span><Icon name="shield" size={15} /> Lokal auf deinem Rechner</span>
        <span><Icon name="chat" size={15} /> Mehrere Sessions</span>
        <span><Icon name="image" size={15} /> Bilder im Prompt</span>
      </div>
    </main>
  );
}

function EmptyProject({
  project,
  onCreateSession,
}: {
  project: AppProject;
  onCreateSession: () => void;
}) {
  return (
    <main class="project-empty">
      <div class="project-empty-icon"><Icon name="chat" size={27} /></div>
      <p class="eyebrow">{project.name}</p>
      <h1>Starte eine neue Session</h1>
      <p>Gemini erhält Zugriff auf den gemeinsamen Kontext dieser Projektordner:</p>
      <div class="empty-root-list">
        {project.roots.map((root) => (
          <span ><Icon name="folder" size={14} /> {root.label || root.path.split(/[\\/]/).at(-1)} {root.kind === "primary" && <i>Primär</i>}</span>
        ))}
      </div>
      {/* Panels are one click away in the rail on the right, so this screen
          keeps the single action that has to be taken here. */}
      <div class="project-empty-actions">
        <button class="primary-button" type="button" onClick={onCreateSession}><Icon name="plus" size={17} /> Neue Session</button>
      </div>
    </main>
  );
}

function RootChangeBanner() {
  return (
    <div class="root-change-banner" role="alert">
      <Icon name="warning" size={17} />
      <p><strong>Projektordner wurden geändert.</strong><span>Prüfe die aktuelle Root-Liste, bevor du diese Session fortsetzt.</span></p>
    </div>
  );
}

/**
 * "jira" is a rail entry like the others but not a side panel: it swaps the
 * chat view for the issue, so it never opens the right column.
 */
type RightPanel =
  | "none"
  | "changes"
  | "attachments"
  | "todos"
  | "gitlab"
  | "jira"
  | "skills"
  | "mcp";

const RESTORABLE_RIGHT_PANELS = [
  "changes",
  "attachments",
  "todos",
  "gitlab",
  "jira",
  "skills",
  "mcp",
] as const satisfies readonly RightPanel[];

function isRestorableRightPanel(value: string | null): value is RightPanel {
  return value !== null && (RESTORABLE_RIGHT_PANELS as readonly string[]).includes(value);
}
const DEFAULT_RIGHT_PANEL_WIDTH = 520;
const MIN_RIGHT_PANEL_WIDTH = 300;
const MIN_CHAT_WIDTH = 260;
const MAX_RIGHT_PANEL_WIDTH = 1_600;
const RIGHT_PANEL_OVERLAY_BREAKPOINT = 640;

function initialRightPanel(): RightPanel {
  try {
    const stored = window.localStorage.getItem("geminui.right-panel");
    // "gitlab" may be restored here but is only honoured once the project's
    // bindings say the integration is actually enabled — see the effect below.
    if (isRestorableRightPanel(stored)) return stored;
    return window.localStorage.getItem("geminui.changes-panel.open") === "true" ? "changes" : "none";
  } catch {
    return "none";
  }
}

function initialRightPanelWidth(): number {
  try {
    const storedValue = window.localStorage.getItem("geminui.right-panel.width");
    const stored = storedValue === null ? Number.NaN : Number(storedValue);
    if (Number.isFinite(stored)) {
      return Math.min(MAX_RIGHT_PANEL_WIDTH, Math.max(MIN_RIGHT_PANEL_WIDTH, Math.round(stored)));
    }
  } catch {
    // The default remains usable when preferences are unavailable.
  }
  return DEFAULT_RIGHT_PANEL_WIDTH;
}

function RightPanelResizeHandle(props: {
  width: number;
  onChange: (width: number) => void;
}) {
  let drag: { pointerId: number; right: number; maximum: number } | null = null;
  const clamp = (value: number, maximum = MAX_RIGHT_PANEL_WIDTH) =>
    Math.round(Math.min(maximum, Math.max(MIN_RIGHT_PANEL_WIDTH, value)));
  const maximumFor = (handle: HTMLDivElement) => {
    const workspaceWidth = handle.parentElement?.getBoundingClientRect().width ?? 0;
    return workspaceWidth > MIN_CHAT_WIDTH + MIN_RIGHT_PANEL_WIDTH
      ? Math.min(MAX_RIGHT_PANEL_WIDTH, workspaceWidth - MIN_CHAT_WIDTH)
      : MAX_RIGHT_PANEL_WIDTH;
  };

  return (
    <div
      class="right-panel-resize-handle"
      role="separator"
      aria-label="Breite von Chat und rechtem Panel ändern"
      aria-orientation="vertical"
      aria-valuemin={MIN_RIGHT_PANEL_WIDTH}
      aria-valuemax={MAX_RIGHT_PANEL_WIDTH}
      aria-valuenow={props.width}
      tabIndex={0}
      title="Ziehen, um Chat und Panel in der Breite zu ändern · Doppelklick setzt zurück"
      onDblClick={(event) => props.onChange(clamp(DEFAULT_RIGHT_PANEL_WIDTH, maximumFor(event.currentTarget)))}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          props.onChange(clamp(props.width + 24, maximumFor(event.currentTarget)));
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onChange(clamp(props.width - 24));
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const workspace = event.currentTarget.parentElement;
        if (!workspace) return;
        const bounds = workspace.getBoundingClientRect();
        drag = {
          pointerId: event.pointerId,
          right: bounds.right,
          maximum: Math.max(MIN_RIGHT_PANEL_WIDTH, bounds.width - MIN_CHAT_WIDTH),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.classList.add("right-panel-resize-handle--dragging");
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const active = drag;
        if (!active || active.pointerId !== event.pointerId) return;
        props.onChange(clamp(active.right - event.clientX, active.maximum));
      }}
      onPointerUp={(event) => {
        if (drag?.pointerId !== event.pointerId) return;
        drag = null;
        event.currentTarget.classList.remove("right-panel-resize-handle--dragging");
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        drag = null;
        event.currentTarget.classList.remove("right-panel-resize-handle--dragging");
      }}
      onLostPointerCapture={(event) => {
        drag = null;
        event.currentTarget.classList.remove("right-panel-resize-handle--dragging");
      }}
    />
  );
}

function supportsGitArea(change: GitFileChange, area: DiffSelection["area"]): boolean {
  return area === "staged"
    ? change.indexStatus !== "." && !change.untracked
    : change.worktreeStatus !== "." || change.untracked || change.conflict;
}

export function App() {
  const [booting, setBooting] = createSignal(true);
  const [capabilities, setCapabilities] = createSignal<AppCapabilities | null>(null);
  const [projects, setProjects] = createSignal<AppProject[]>([]);
  const [activeProjectId, setActiveProjectId] = createSignal<string | null>(null);
  const [sessions, setSessions] = createSignal<AppSession[]>([]);
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = createSignal(false);
  const [projectDialogOpen, setProjectDialogOpen] = createSignal(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = createSignal(false);
  const [sidebarOpen, setSidebarOpen] = createSignal(false);
  const [rightPanel, setRightPanel] = createSignal<RightPanel>(initialRightPanel());
  const [rightPanelWidth, setRightPanelWidth] = createSignal(initialRightPanelWidth());
  const [gitSelection, setGitSelection] = createSignal<DiffSelection | null>(null);
  const [gitRefreshToken, setGitRefreshToken] = createSignal(0);
  const [gitPreviewTrigger, setGitPreviewTrigger] = createSignal<GitPreviewTrigger | null>(null);
  const [uiError, setUiError] = createSignal<UiError | null>(null);
  const [fatalError, setFatalError] = createSignal<string | null>(null);
  const [livePreviewUrl, setLivePreviewUrl] = createSignal<string | null>(null);
  const [reconnectedSessions, setReconnectedSessions] = createSignal<Record<string, boolean>>({});
  const [sessionHistoryModes, setSessionHistoryModes] = createSignal<Record<string, "compressed" | "fresh">>({});
  const [composerDraft, setComposerDraft] = createSignal<ComposerDraft | null>(null);
  const [pendingExternalContexts, setPendingExternalContexts] = createSignal<PreparedExternalContext[]>([]);
  const [pendingPrompt, setPendingPrompt] = createSignal<{
    text: string;
    attachments: ComposerAttachment[];
    projectFiles: ProjectFileSearchEntry[];
    externalContextRefs: ExternalPromptContextRef[];
  } | null>(null);
  const [chat, setChat] = createSignal(createChatState());
  const dispatch = (action: ChatAction) => setChat((current) => chatReducer(current, action));
  let gitStatusRef: GitProjectStatus | null = null;
  let workspaceRef!: HTMLDivElement;
  let gitToolBaselinesRef = new Map<string, ReadonlyMap<string, string>>();
  let gitPreviewSequenceRef = 0;

  const activeProject = createMemo(() => projects().find((project) => project.id === activeProjectId()) ?? null);
  const activeSession = createMemo(() => sessions().find((session) => session.id === activeSessionId()) ?? null);
  const changesOpen = createMemo(() => rightPanel() === "changes");
  const attachmentsOpen = createMemo(() => rightPanel() === "attachments");
  const todosOpen = createMemo(() => rightPanel() === "todos");
  /**
   * "jira" is a rail entry that replaces the chat view rather than opening the
   * right column, so it must not widen the grid or show the resize handle.
   */
  const rightPanelOpen = createMemo(() => rightPanel() !== "none" && rightPanel() !== "jira");
  const contextAttachments = useContextAttachments({
    project: activeProject,
    sessionId: activeSessionId,
  });
  const todos = useTodos({ project: activeProject });
  const gitState = useGitProjectStatus({
    project: activeProject,
    refreshToken: gitRefreshToken,
    onCapabilitiesChange: setCapabilities,
  });
  const gitPreviewGroups = useGitChangePreviews({
    sessionId: activeSessionId,
    project: activeProject,
    status: gitState.status,
    trigger: gitPreviewTrigger,
  });
  const changesCount = gitState.status()?.changes.length ?? 0;
  const [gitlabCandidates, setGitlabCandidates] = createSignal<GitLabRepositoryCandidate[]>([]);
  const [gitlabCandidatesLoaded, setGitlabCandidatesLoaded] = createSignal(false);

  createEffect(() => {
    // Cleared before the request, not after it: keeping the previous project's
    // candidates would leave `gitlabEnabled` true for a moment and flash a
    // GitLab tab into a project that never enabled the integration.
    setGitlabCandidates([]);
    setGitlabCandidatesLoaded(false);
    if (!activeProject()) {
      setGitlabCandidatesLoaded(true);
      return;
    }
    let current = true;
    window.gemUi.gitlab
      .listRepositoryCandidates({ projectId: activeProject()!.id })
      .then((list) => {
        if (current) setGitlabCandidates(list);
      })
      .catch(() => {
        if (current) setGitlabCandidates([]);
      })
      .finally(() => {
        if (current) setGitlabCandidatesLoaded(true);
      });
    onCleanup(() => {
      current = false;
    });
  });

  const gitlabEnabled = gitlabCandidates().some((c) => c.binding?.enabled);

  const jira = useJiraIssue({
    project: activeProject,
    sessionId: activeSessionId,
    sessionTitle: () => activeSession()?.title ?? null,
    // Reloading when the settings dialog closes is what makes a just-activated
    // Jira integration appear without restarting the app.
    reloadToken: projectSettingsOpen,
  });
  const jiraIssue = createMemo(() => activeSession() ? jira.issue() : null);

  /**
   * The Jira view lives under the same condition as its rail entry: a
   * `rightPanel` of "jira" restored from localStorage, or left over from a
   * session whose title did match, must not leave the workspace showing an
   * issue the current session has nothing to do with.
   */
  createEffect(() => {
    if (rightPanel() !== "jira" || jiraIssue()) return;
    // Waiting for the activation to arrive: resetting first would close the
    // view on every start for sessions that legitimately have an issue.
    if (activeSession() && jira.integration() === null) return;
    setRightPanel("none");
  });

  /**
   * The GitLab panel lives under the same condition as its toggle. Without
   * this, a `rightPanel` of "gitlab" restored from localStorage — or left over
   * from a project that does have a binding — renders the panel in a project
   * that offers no way to close or even reach it.
   *
   * The fallback waits for the candidate list: resetting before it arrives
   * would close the panel on every start for projects that legitimately use
   * GitLab.
   */
  createEffect(() => {
    if (rightPanel() !== "gitlab") return;
    if (!gitlabCandidatesLoaded() || gitlabEnabled) return;
    setRightPanel("none");
  });

  createEffect(() => {
    gitToolBaselinesRef.clear();
    setGitPreviewTrigger(null);
    setGitSelection(null);
  });

  const showError = (title: string, error: unknown, retry?: () => void) => {
    setUiError({ title, message: messageFrom(error), retry });
  };
  const closeProjectDialog = () => setProjectDialogOpen(false);

  const bootstrap = async () => {
    setBooting(true);
    setFatalError(null);
    try {
      if (!window.gemUi) throw new Error("Die sichere Desktop-Brücke ist nicht verfügbar.");
      const [nextCapabilities, nextProjects] = await Promise.all([
        window.gemUi.getCapabilities(),
        window.gemUi.projects.list(),
      ]);
      setCapabilities(nextCapabilities);
      setProjects(nextProjects);
      setActiveProjectId((current) =>
        current && nextProjects.some((project) => project.id === current)
          ? current
          : nextProjects.find((project) => !project.archived)?.id ?? null,
      );
    } catch (error) {
      setFatalError(messageFrom(error));
    } finally {
      setBooting(false);
    }
  };

  onMount(() => { void bootstrap(); });

  createEffect(() => {
    try {
      window.localStorage.setItem("geminui.right-panel", rightPanel());
      window.localStorage.setItem("geminui.changes-panel.open", String(changesOpen()));
    } catch {
      // A disabled preference store must not disable the viewer itself.
    }
  });

  createEffect(() => {
    try {
      window.localStorage.setItem("geminui.right-panel.width", String(rightPanelWidth()));
    } catch {
      // Resizing remains available without persistent preferences.
    }
  });

  createEffect(() => {
    const workspace = workspaceRef;
    if (!workspace || typeof ResizeObserver === "undefined") return;
    const fitToWorkspace = () => {
      if (window.innerWidth <= RIGHT_PANEL_OVERLAY_BREAKPOINT) return;
      if (workspace.clientWidth <= MIN_CHAT_WIDTH + MIN_RIGHT_PANEL_WIDTH) return;
      const maximum = Math.max(MIN_RIGHT_PANEL_WIDTH, workspace.clientWidth - MIN_CHAT_WIDTH);
      setRightPanelWidth((current) => Math.min(current, maximum));
    };
    fitToWorkspace();
    const observer = new ResizeObserver(fitToWorkspace);
    observer.observe(workspace);
    onCleanup(() => observer.disconnect());
  });

  createRenderEffect(() => {
    // The attachments panel and the Jira view share the one embedded web view,
    // so it is torn down whenever neither is what the workspace is showing.
    const usesLinkPreview = rightPanel() === "attachments" || rightPanel() === "jira";
    if (!usesLinkPreview || projectDialogOpen() || projectSettingsOpen()) {
      void window.gemUi?.linkPreview.close();
    }
  });

  createEffect(() => {
    if (!activeProjectId()) {
      setSessions([]);
      setActiveSessionId(null);
      return;
    }
    let current = true;
    setSessionsLoading(true);
    window.gemUi.sessions.list({ projectId: activeProjectId(), includeArchived: true })
      .then((nextSessions) => {
        if (!current) return;
        setSessions(nextSessions);
        setActiveSessionId((selected) =>
          selected && nextSessions.some((session) => session.id === selected)
            ? selected
            : nextSessions.find((session) => !session.archived)?.id ?? null,
        );
      })
      .catch((error) => {
        if (current) showError("Sessions konnten nicht geladen werden", error);
      })
      .finally(() => {
        if (current) setSessionsLoading(false);
      });
    onCleanup(() => { current = false; });
  });

  createEffect(() => {
    dispatch({ type: "reset", sessionId: activeSessionId() });
    if (!activeSessionId()) return;
    let current = true;
    let unsubscribe: (() => void) | undefined;
    window.gemUi.subscribeSessionEvents(
      { sessionId: activeSessionId(), afterSeq: 0 },
      (events) => {
        if (!current) return;
        dispatch({ type: "events", events });
        for (const envelope of events) {
          const { event } = envelope;
          if (event.type === "tool.started") {
            gitToolBaselinesRef.set(
              event.toolCallId,
              gitStatusBaseline(gitStatusRef),
            );
          } else if (event.type === "tool.completed" || event.type === "tool.failed") {
            setGitPreviewTrigger({
              id: ++gitPreviewSequenceRef,
              toolCallId: event.toolCallId,
              turnId: envelope.turnId,
              baseline: gitToolBaselinesRef.get(event.toolCallId) ?? new Map(),
              statusRefreshedAt: gitStatusRef?.refreshedAt ?? null,
            });
            gitToolBaselinesRef.delete(event.toolCallId);
          }
        }
        const status = sessionStatusFromEvents(events);
        if (status) {
          setSessions((currentSessions) => currentSessions.map((session) =>
            session.id === activeSessionId() ? { ...session, status } : session,
          ));
        }
        if (events.some(({ event }) => [
          "turn.completed",
          "turn.failed",
          "turn.cancelled",
          "tool.completed",
          "tool.failed",
        ].includes(event.type))) {
          setGitRefreshToken((currentToken) => currentToken + 1);
        }
      },
      (snapshot) => {
        // Restores the last known usage state right after a restart, even when
        // the matching event is outside the replay window.
        if (current) dispatch({ type: "usage-snapshot", snapshot });
      },
    )
      .then((dispose) => {
        if (current) unsubscribe = dispose;
        else dispose();
      })
      .catch((error) => {
        if (current) showError("Live-Verbindung fehlgeschlagen", error);
      });
    onCleanup(() => {
      current = false;
      unsubscribe?.();
    });
  });

  createEffect(() => {
    if (!activeSessionId()) return;
    let current = true;
    window.gemUi.sessions.getReconnectState?.({ sessionId: activeSessionId() })
      .then((state) => {
        if (!current) return;
        if (state?.reconnected && state?.hasHistory) {
          setReconnectedSessions((prev) => ({ ...prev, [activeSessionId()]: true }));
        }
      })
      .catch(() => {});
    onCleanup(() => {
      current = false;
    });
  });

  createEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "n") return;
      event.preventDefault();
      if (activeProjectId()) void createSession();
      else setProjectDialogOpen(true);
    };
    window.addEventListener("keydown", shortcut);
    onCleanup(() => window.removeEventListener("keydown", shortcut));
  });

  const createProject = async (input: {
    name: string;
    primaryRoot: ProjectRootCandidate;
    additionalRoots: ProjectRootCandidate[];
  }) => {
    const project = await window.gemUi.projects.create({
      name: input.name,
      primaryRootPath: input.primaryRoot.path,
      additionalRootPaths: input.additionalRoots.map((root) => root.path),
      clientRequestId: createClientRequestId(),
    });
    setProjects((current) => [...current, project]);
    setActiveProjectId(project.id);
    setActiveSessionId(null);
  };

  const createSession = async () => {
    if (!activeProjectId()) return;
    try {
      const session = await window.gemUi.sessions.create({ projectId: activeProjectId(), clientRequestId: createClientRequestId() });
      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      setSidebarOpen(false);
    } catch (error) {
      if (isProjectRootAccessError(error)) setProjectSettingsOpen(true);
      showError("Session konnte nicht angelegt werden", error, () => void createSession());
    }
  };

  const updateProject = async (input: {
    name: string;
    additionalRootPaths: string[];
  }) => {
    if (!activeProject()) return;
    let updated = activeProject()!;
    if (input.name !== updated.name) {
      updated = await window.gemUi.projects.rename({
        projectId: updated.id,
        name: input.name,
        clientRequestId: createClientRequestId(),
      });
      setProjects((current) =>
        current.map((project) => project.id === updated.id ? updated : project),
      );
    }

    const currentAdditionalPaths = updated.roots
      .filter((root) => root.kind === "additional")
      .map((root) => root.path);
    const rootsChanged =
      currentAdditionalPaths.length !== input.additionalRootPaths.length ||
      currentAdditionalPaths.some(
        (rootPath, index) => rootPath !== input.additionalRootPaths[index],
      );
    if (rootsChanged) {
      updated = await window.gemUi.projects.setAdditionalRoots({
        projectId: updated.id,
        expectedRootRevision: updated.rootRevision,
        additionalRootPaths: input.additionalRootPaths,
        clientRequestId: createClientRequestId(),
      });
      setProjects((current) =>
        current.map((project) => project.id === updated.id ? updated : project),
      );
      setSessions((current) =>
        current.map((session) => ({ ...session, status: "roots_changed" })),
      );
    }
  };

  const deleteProject = async () => {
    if (!activeProject()) return;
    const projectId = activeProject()!.id;
    await window.gemUi.projects.delete({
      projectId,
      clientRequestId: createClientRequestId(),
    });
    const remaining = projects().filter((project) => project.id !== projectId);
    setProjects(remaining);
    setActiveProjectId(remaining.find((project) => !project.archived)?.id ?? null);
    setSessions([]);
    setActiveSessionId(null);
  };

  const updateSession = async (
    sessionId: string,
    patch: Partial<Pick<AppSession, "title" | "pinned" | "archived" | "mode" | "model">>,
  ) => {
    try {
      const updated = await window.gemUi.sessions.update({ sessionId, ...patch, clientRequestId: createClientRequestId() });
      setSessions((current) => current.map((session) => session.id === sessionId ? updated : session));
    } catch (error) {
      showError("Session konnte nicht aktualisiert werden", error);
    }
  };

  const setSessionMode = async (sessionId: string, modeId: string) => {
    try {
      const updated = window.gemUi.sessions.setMode
        ? await window.gemUi.sessions.setMode({ sessionId, modeId, clientRequestId: createClientRequestId() })
        : await window.gemUi.sessions.update({ sessionId, mode: modeId, clientRequestId: createClientRequestId() });
      setSessions((current) => current.map((session) => session.id === sessionId ? updated : session));
    } catch (error) {
      showError("Gemini-Modus konnte nicht geändert werden", error);
    }
  };

  const setSessionModel = async (sessionId: string, modelId: string) => {
    try {
      const updated = await window.gemUi.sessions.setModel({
        sessionId,
        modelId,
        clientRequestId: createClientRequestId(),
      });
      setSessions((current) => current.map((session) => session.id === sessionId ? updated : session));
    } catch (error) {
      showError("Gemini-Modell konnte nicht geändert werden", error);
    }
  };

  const deleteSession = async (sessionId: string) => {
    const session = sessions().find((item) => item.id === sessionId);
    if (!window.confirm(`„${session?.title ?? "Session"}“ aus GeminUI löschen? Projektdateien werden nicht gelöscht.`)) return;
    try {
      await window.gemUi.sessions.delete({ sessionId, clientRequestId: createClientRequestId() });
      const remaining = sessions().filter((item) => item.id !== sessionId);
      setSessions(remaining);
      if (activeSessionId() === sessionId) setActiveSessionId(remaining.find((item) => !item.archived)?.id ?? null);
    } catch (error) {
      showError("Session konnte nicht gelöscht werden", error);
    }
  };

  const handleChooseReconnectMode = (sessionId: string, mode: "compressed" | "fresh") => {
    setSessionHistoryModes((prev) => ({ ...prev, [sessionId]: mode }));
    setReconnectedSessions((prev) => ({ ...prev, [sessionId]: false }));
    if (pendingPrompt() && activeSession()?.id === sessionId) {
      const promptToRun = pendingPrompt()!;
      setPendingPrompt(null);
      void executeSendPrompt(
        promptToRun.text,
        promptToRun.attachments,
        promptToRun.projectFiles,
        promptToRun.externalContextRefs,
        mode,
      );
    }
  };

  const handToComposer = (text: string) => {
    setComposerDraft({ token: Date.now() + Math.random(), text });
  };

  const sendPrompt = async (
    text: string,
    attachments: ComposerAttachment[] = [],
    projectFiles: ProjectFileSearchEntry[] = [],
    externalContextRefs: ExternalPromptContextRef[] = [],
  ) => {
    if (!activeSession()) return;
    // Review context that was parked in the composer travels with whatever the
    // user finally types, so it is merged in here rather than at the call site.
    const mergedRefs = [...externalContextRefs];
    for (const context of pendingExternalContexts()) {
      if (!mergedRefs.some((ref) => ref.id === context.ref.id)) mergedRefs.push(context.ref);
    }
    const isReconnected = reconnectedSessions()[activeSession()!.id];
    const preChosenMode = sessionHistoryModes()[activeSession()!.id];

    if (isReconnected && !preChosenMode) {
      setPendingPrompt({ text, attachments, projectFiles, externalContextRefs: mergedRefs });
      return;
    }

    await executeSendPrompt(
      text,
      attachments,
      projectFiles,
      mergedRefs,
      preChosenMode ?? "compressed",
    );
  };

  const executeSendPrompt = async (
    text: string,
    attachments: ComposerAttachment[] = [],
    projectFiles: ProjectFileSearchEntry[] = [],
    externalContextRefs: ExternalPromptContextRef[] = [],
    historyMode?: "compressed" | "fresh",
  ) => {
    if (!activeSession()) return;
    setReconnectedSessions((prev) => ({ ...prev, [activeSession()!.id]: false }));
    const clientRequestId = createClientRequestId();
    dispatch({
      type: "optimistic-user",
      clientRequestId,
      text,
      attachments,
      contextAttachments: contextAttachments.included().map(({ id, kind, title }) => ({ id, kind, title })),
      projectFiles: projectFiles.map(({ rootId, rootLabel, relativePath, displayName }) => ({
        rootId,
        rootLabel,
        relativePath,
        displayName,
      })),
      timestamp: new Date().toISOString(),
    });
    const isInitialTitle = !activeSession()!.title || activeSession()!.title.trim() === "Neue Session";
    const optimisticTitle = isInitialTitle && text.trim()
      ? generateSessionTitleFromPrompt(text)
      : activeSession()!.title;
    setSessions((current) =>
      current.map((session) =>
        session.id === activeSession()!.id
          ? { ...session, title: optimisticTitle, status: "running" }
          : session,
      ),
    );
    try {
      const result = await window.gemUi.sessions.sendPrompt({
        sessionId: activeSession()!.id,
        text,
        attachmentIds: attachments.map((attachment) => typeof attachment === "string" ? attachment : attachment.id),
        contextAttachmentIds: contextAttachments.included().map((attachment) => typeof attachment === "string" ? attachment : attachment.id),
        projectFiles: projectFiles.map(({ rootId, relativePath }) => ({ rootId, relativePath })),
        externalContextRefs: (externalContextRefs ?? []).map((ref) => ({ kind: ref.kind, id: ref.id })),
        expectedRootRevision: activeProject()?.rootRevision ?? 1,
        clientRequestId,
        ...(historyMode ? { historyMode } : {}),
      });
      dispatch({ type: "turn-started", turnId: result.turnId });
      // The prepared review snapshots are consumed once, so they must not stay
      // attached to the next message.
      if (externalContextRefs.length) setPendingExternalContexts([]);
    } catch (error) {
      console.error("[sendPrompt Error]:", error);
      const message = messageFrom(error);
      dispatch({ type: "prompt-failed", clientRequestId, message });
      setSessions((current) => current.map((session) => session.id === activeSession()!.id ? { ...session, status: "error" } : session));
      if (isProjectRootAccessError(error)) setProjectSettingsOpen(true);
      showError("Nachricht konnte nicht gesendet werden", error);
      throw error;
    }
  };

  /**
   * Hands a todo to a session: the main process selects the todo's attachments
   * for that session and returns the prompt text, which lands in the composer
   * so the todo can still be adjusted before it is sent.
   */
  const applyTodoToSession = async (todo: Todo, sessionId: string) => {
    const draft = await window.gemUi.todos.prepareForSession({
      clientRequestId: createClientRequestId(),
      todoId: todo.id,
      sessionId,
    });
    contextAttachments.apply(draft.contextAttachments);
    handToComposer(draft.text);
    setSidebarOpen(false);
  };

  const sendTodoToActiveSession = async (todo: Todo) => {
    if (!activeSession()) {
      throw new Error("Es ist keine Session geöffnet. Lege zuerst eine an.");
    }
    await applyTodoToSession(todo, activeSession()!.id);
  };

  const sendTodoToNewSession = async (todo: Todo) => {
    if (!activeProjectId()) return;
    const session = await window.gemUi.sessions.create({
      projectId: activeProjectId(),
      clientRequestId: createClientRequestId(),
    });
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    await applyTodoToSession(todo, session.id);
  };

  const deliverReviewContext = async (
    prepared: PreparedExternalContext,
    delivery: ReviewDelivery,
  ) => {
    if (delivery === "send") {
      await sendPrompt(
        "Bitte bearbeite das Review-Feedback zu dieser Stelle.",
        [],
        [],
        [prepared.ref],
      );
      return;
    }
    setPendingExternalContexts((current) =>
      current.some((context) => context.ref.id === prepared.ref.id)
        ? current
        : [...current, prepared],
    );
    handToComposer("Bitte bearbeite das Review-Feedback zu dieser Stelle.");
  };

  const cancelTurn = async () => {
    if (!activeSession()) return;
    const turnId = chat().activeTurnId ?? undefined;
    dispatch({ type: "cancelling" });
    setSessions((current) =>
      current.map((session) => (session.id === activeSession()!.id ? { ...session, status: "idle" } : session)),
    );
    try {
      await window.gemUi.sessions.cancel({
        sessionId: activeSession()!.id,
        turnId,
        clientRequestId: createClientRequestId(),
      });
    } catch (error) {
      showError("Antwort konnte nicht gestoppt werden", error);
      throw error;
    }
  };

  const respondToPermission = async (requestIdValue: string, optionId: string) => {
    if (!activeSession()) return;
    dispatch({ type: "permission-submitting", requestId: requestIdValue, optionId });
    try {
      await window.gemUi.sessions.respondToPermission({
        sessionId: activeSession()!.id,
        requestId: requestIdValue,
        optionId,
        clientRequestId: createClientRequestId(),
      });
    } catch (error) {
      dispatch({ type: "permission-failed", requestId: requestIdValue });
      showError("Freigabeantwort konnte nicht gesendet werden", error);
    }
  };

  const openExternal = (url: string) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      setLivePreviewUrl(url);
    } else {
      window.gemUi.openExternalHttpsUrl(url).catch((error) => showError("Link konnte nicht geöffnet werden", error));
    }
  };

  const openInExternalBrowser = (url: string) => {
    window.gemUi.openExternalHttpsUrl(url).catch((error) => showError("Link konnte nicht geöffnet werden", error));
  };

  const openGitDiff = (selection: DiffSelection) => {
    const change = gitState.status()?.changes.find((candidate) =>
      candidate.repositoryId === selection.repositoryId && candidate.path === selection.path,
    );
    if (!change) {
      setGitSelection(null);
      setRightPanel("changes");
      return;
    }
    const area = supportsGitArea(change, selection.area)
      ? selection.area
      : supportsGitArea(change, "unstaged")
        ? "unstaged"
        : "staged";
    setGitSelection({
      repositoryId: change.repositoryId,
      fileId: change.fileId,
      path: change.path,
      area,
    });
    setRightPanel("changes");
  };

  /**
   * One entry per right-hand panel. GitLab is the only conditional one: unlike
   * Skills and MCP it describes a binding this project may simply not have, and
   * an empty GitLab panel would have nothing honest to show.
   */
  const railItems = createMemo<PanelRailItem[]>(() => {
    const attachmentsCount = contextAttachments.all().length;
    const includedCount = contextAttachments.included().length;
    const items: PanelRailItem[] = [
      {
        id: "attachments",
        icon: "paperclip",
        label: "Anhänge",
        ...(attachmentsCount > 0
          ? {
              detail: `${attachmentsCount} Anhänge, ${includedCount} im Kontext`,
              badge: attachmentsCount,
              subBadge: includedCount,
            }
          : {}),
      },
      {
        id: "todos",
        icon: "checklist",
        label: "Todos",
        ...(todos.openCount() > 0
          ? { detail: `${todos.openCount()} offen`, badge: todos.openCount() }
          : {}),
      },
      {
        id: "changes",
        icon: "changes",
        label: "Änderungen",
        ...(changesCount > 0
          ? { detail: `${changesCount} Dateien`, badge: changesCount }
          : {}),
      },
    ];
    // No badge for GitLab: the unresolved count lives inside the panel's own
    // review state, and a number this component cannot actually read would be
    // a guess rather than a count.
    if (gitlabEnabled) {
      items.push({ id: "gitlab", icon: "gitlab", label: "GitLab", name: "GitLab Review" });
    }
    // Jira appears only when this session's name actually names an issue on the
    // activated instance — an entry that opened an empty issue view would be a
    // promise the integration cannot keep.
    if (jiraIssue()) {
      items.push({
        id: "jira",
        icon: "jira",
        label: "Jira",
        name: `Jira-Issue ${jiraIssue()!.issueKey}`,
        detail: jiraIssue()!.issueKey,
      });
    }
    items.push(
      { id: "skills", icon: "skill", label: "Skills" },
      { id: "mcp", icon: "server", label: "MCP", name: "MCP-Server" },
    );
    return items;
  });

  const toggleRightPanel = (id: string) => {
    setRightPanel((current) => (current === id ? "none" : (id as RightPanel)));
  };

  const effectivePhase = createMemo((): TurnPhase => {
    if (chat().phase !== "idle" || !activeSession()) return chat().phase;
    if (activeSession()!.status === "disconnected" || activeSession()!.status === "error") {
      return activeSession()!.status as TurnPhase;
    }
    return "idle";
  });

  const hasPendingPlan = createMemo(() => {
    if (!activeSession() || activeSession()!.mode !== "plan") return false;
    if (effectivePhase() !== "idle") return false;
    if (chat().items.length === 0) return false;

    for (let i = chat().items.length - 1; i >= 0; i--) {
      const item = chat().items[i]!;
      if (item.kind === "notice") return false;
      if (item.kind === "message" && item.role === "user") {
        return false;
      }
      if (item.kind === "tool") {
        return false;
      }
      if (item.kind === "message" && item.role === "assistant") {
        if (item.streaming) return false;
        return true;
      }
    }
    return false;
  });

  const appContent = createMemo(() => {
    if (booting()) return <LoadingScreen />;
    if (fatalError()) {
    return (
      <main class="fatal-screen">
        <Icon name="warning" size={28} />
        <h1>GeminUI konnte nicht gestartet werden</h1>
        <p>{fatalError()}</p>
        <button class="primary-button" type="button" onClick={() => void bootstrap()}><Icon name="refresh" size={16} /> Erneut versuchen</button>
      </main>
    );
    }
    if (!capabilities()) return null;
    if (!capabilities()!.gemini.available || !capabilities()!.gemini.acp) {
    return (
      <OnboardingScreen
        capabilities={capabilities()}
        onRetry={() => void bootstrap()}
        onPickGemini={window.gemUi.settings?.pickGeminiBinary || window.gemUi.settings?.chooseGeminiBinary
          ? () => {
              const picker = window.gemUi.settings.pickGeminiBinary ?? window.gemUi.settings.chooseGeminiBinary;
              void picker?.()
                .then((next) => {
                  if (next) setCapabilities(next);
                  else void bootstrap();
                })
                .catch((error) => setFatalError(messageFrom(error)));
            }
          : undefined}
      />
    );
    }

    return (
    <div class="app-shell">
      <Sidebar
        open={sidebarOpen()}
        capabilities={capabilities()}
        projects={projects().filter((project) => !project.archived)}
        activeProjectId={activeProjectId()}
        sessions={sessions()}
        activeSessionId={activeSessionId()}
        sessionsLoading={sessionsLoading()}
        onClose={() => setSidebarOpen(false)}
        onCreateProject={() => setProjectDialogOpen(true)}
        onEditProject={() => setProjectSettingsOpen(true)}
        onSelectProject={(projectId) => { setActiveProjectId(projectId); setSidebarOpen(false); }}
        onCreateSession={() => void createSession()}
        onSelectSession={(sessionId) => { setActiveSessionId(sessionId); setSidebarOpen(false); }}
        onUpdateSession={(sessionId, patch) => void updateSession(sessionId, patch)}
        onDeleteSession={(sessionId) => void deleteSession(sessionId)}
      />

      <section class="main-pane">
        {!projects().length ? (
          <EmptyWorkspace onCreateProject={() => setProjectDialogOpen(true)} />
        ) : activeProject() && !activeSession() ? (
          <div
            ref={workspaceRef}
            class={`chat-workspace ${rightPanelOpen() ? "chat-workspace--panel" : ""}`}
            style={{ "--right-panel-width": `${rightPanelWidth()}px` } as JSX.CSSProperties}
          >
            <div class="project-empty-host">
              <button type="button" class="icon-button mobile-empty-menu" onClick={() => setSidebarOpen(true)} aria-label="Seitenleiste öffnen"><Icon name="menu" size={19} /></button>
              <EmptyProject
                project={activeProject()!}
                onCreateSession={() => void createSession()}
              />
            </div>
            {changesOpen() ? (
              <ChangesPanel

                open={changesOpen()}
                project={activeProject()!}
                status={gitState.status()}
                loading={gitState.loading()}
                refreshing={gitState.refreshing()}
                choosingGit={gitState.choosingGit()}
                error={gitState.error()}
                selection={gitSelection()}
                onClose={() => setRightPanel("none")}
                onSelectionChange={setGitSelection}
                onRefresh={() => void gitState.refresh()}
                onChooseGit={() => void gitState.chooseGit()}
              />
            ) : attachmentsOpen() ? (
              <AttachmentsPanel
                open={attachmentsOpen()}
                project={activeProject()!}
                sessionId={null}
                list={contextAttachments.list()}
                loading={contextAttachments.loading()}
                refreshing={contextAttachments.refreshing()}
                error={contextAttachments.error()}
                onClose={() => setRightPanel("none")}
                onRefresh={contextAttachments.refresh}
                onApply={contextAttachments.apply}
                onError={(error) => showError("Anhang konnte nicht verarbeitet werden", error)}
                onOpenExternal={openExternal}
              />
            ) : rightPanel() === "todos" ? (
              <TodosPanel
                project={activeProject()!}
                list={todos.list()}
                loading={todos.loading()}
                error={todos.error()}
                hasActiveSession={false}
                onClose={() => setRightPanel("none")}
                onApply={todos.apply}
                onError={(error) => showError("Todo konnte nicht gespeichert werden", error)}
                onSendToSession={sendTodoToActiveSession}
                onSendToNewSession={sendTodoToNewSession}
                onOpenExternal={openExternal}
              />
            ) : rightPanel() === "skills" ? (
              <SkillsPanel projectId={activeProject()!.id} onClose={() => setRightPanel("none")} />
            ) : rightPanel() === "mcp" ? (
              <McpPanel projectId={activeProject()!.id} onClose={() => setRightPanel("none")} />
            ) : rightPanel() === "gitlab" && gitlabEnabled ? (
              <GitLabPanel
                projectId={activeProject()!.id}
                rootRevision={activeProject()!.rootRevision}
                activeSession={null}
                onClose={() => setRightPanel("none")}
                onSendExternalContextPrompt={async () => {
                  showError("Keine aktive Session", new Error("Bitte starte zuerst eine Session, um Review-Kontext zu senden."));
                }}
                onOpenExternal={openExternal}
                onOpenSettings={() => setProjectSettingsOpen(true)}
              />
            ) : null}
            {rightPanelOpen() && <RightPanelResizeHandle width={rightPanelWidth()} onChange={setRightPanelWidth} />}
            <PanelRail items={railItems} activeId={rightPanel} onToggle={toggleRightPanel} />
          </div>
        ) : activeProject() && activeSession() ? (
          <div
            ref={workspaceRef}
            class={`chat-workspace ${rightPanelOpen() ? "chat-workspace--panel" : ""}`}
            style={{ "--right-panel-width": `${rightPanelWidth()}px` } as JSX.CSSProperties}
          >
            <div class="chat-view">
              <ChatHeader
                project={activeProject()!}
                session={activeSession()!}
                chat={{ ...chat(), phase: effectivePhase() }}
                modelsSupported={capabilities().gemini.models}
                onOpenSidebar={() => setSidebarOpen(true)}
                onEditProject={() => setProjectSettingsOpen(true)}
                onSetMode={(mode) => void setSessionMode(activeSession()!.id, mode)}
                onSetModel={(model) => void setSessionModel(activeSession()!.id, model)}
              />
              {activeSession()!.status === "roots_changed" && <RootChangeBanner />}
              {Boolean(reconnectedSessions()[activeSession()!.id]) && (
                <ReconnectHistoryBanner
                  onChoose={(mode) => handleChooseReconnectMode(activeSession()!.id, mode)}
                />
              )}
              <Timeline
                items={chat().items}
                sessionTitle={activeSession()!.title}
                gitPreviewGroups={gitPreviewGroups()}
                onOpenExternal={openExternal}
                onOpenGitDiff={openGitDiff}
                onRespondToPermission={(request, option) => void respondToPermission(request, option)}
              />
              <Composer

                sessionId={activeSession()!.id}
                projectId={activeProject()!.id}
                rootRevision={activeProject()!.rootRevision}
                phase={effectivePhase()}
                imagesSupported={capabilities().gemini.images}
                contextAttachmentCount={contextAttachments.included().length}
                contextEstimatedTokens={contextAttachments.list()?.estimatedTotalTokens ?? 0}
                contextOverBudget={contextAttachments.list()?.overBudget ?? false}
                draft={composerDraft()}
                externalContexts={pendingExternalContexts()}
                sessionMode={activeSession()!.mode}
                hasPendingPlan={hasPendingPlan()}
                onDraftApplied={() => setComposerDraft(null)}
                onRemoveExternalContext={(refId) =>
                  setPendingExternalContexts((current) =>
                    current.filter((context) => context.ref.id !== refId),
                  )
                }
                onOpenContextAttachments={() => setRightPanel("attachments")}
                onSend={sendPrompt}
                onCancel={cancelTurn}
                onError={(error) => showError("Anhang konnte nicht verarbeitet werden", new Error(error))}
              />
            </div>
            {changesOpen() ? (
              <ChangesPanel

                open={changesOpen()}
                project={activeProject()!}
                status={gitState.status()}
                loading={gitState.loading()}
                refreshing={gitState.refreshing()}
                choosingGit={gitState.choosingGit()}
                error={gitState.error()}
                selection={gitSelection()}
                onClose={() => setRightPanel("none")}
                onSelectionChange={setGitSelection}
                onRefresh={() => void gitState.refresh()}
                onChooseGit={() => void gitState.chooseGit()}
              />
            ) : attachmentsOpen() ? (
              <AttachmentsPanel
                open={attachmentsOpen()}
                project={activeProject()!}
                sessionId={activeSession()!.id}
                list={contextAttachments.list()}
                loading={contextAttachments.loading()}
                refreshing={contextAttachments.refreshing()}
                error={contextAttachments.error()}
                onClose={() => setRightPanel("none")}
                onRefresh={contextAttachments.refresh}
                onApply={contextAttachments.apply}
                onError={(error) => showError("Anhang konnte nicht verarbeitet werden", error)}
                onOpenExternal={openExternal}
              />
            ) : rightPanel() === "todos" ? (
              <TodosPanel
                project={activeProject()!}
                list={todos.list()}
                loading={todos.loading()}
                error={todos.error()}
                hasActiveSession
                onClose={() => setRightPanel("none")}
                onApply={todos.apply}
                onError={(error) => showError("Todo konnte nicht gespeichert werden", error)}
                onSendToSession={sendTodoToActiveSession}
                onSendToNewSession={sendTodoToNewSession}
                onOpenExternal={openExternal}
              />
            ) : rightPanel() === "skills" ? (
              <SkillsPanel projectId={activeProject()!.id} onClose={() => setRightPanel("none")} />
            ) : rightPanel() === "mcp" ? (
              <McpPanel projectId={activeProject()!.id} onClose={() => setRightPanel("none")} />
            ) : rightPanel() === "gitlab" && gitlabEnabled ? (
              <GitLabPanel
                projectId={activeProject()!.id}
                rootRevision={activeProject()!.rootRevision}
                activeSession={activeSession()!}
                onClose={() => setRightPanel("none")}
                onSendExternalContextPrompt={deliverReviewContext}
                onOpenExternal={openExternal}
                onOpenSettings={() => setProjectSettingsOpen(true)}
              />
            ) : null}
            {/* The issue covers the workspace instead of replacing the chat
                view, so an unsent draft in the composer survives a look at
                Jira. Everything but the panel rail is behind it. */}
            {rightPanel() === "jira" && jiraIssue() && (
              <JiraIssueView
                issue={jiraIssue()!}
                attachError={jira.attachError()}
                onClose={() => setRightPanel("none")}
                onOpenExternal={openInExternalBrowser}
              />
            )}
            {rightPanelOpen() && <RightPanelResizeHandle width={rightPanelWidth()} onChange={setRightPanelWidth} />}
            <PanelRail items={railItems} activeId={rightPanel} onToggle={toggleRightPanel} />
          </div>
        ) : null}
      </section>

      <ProjectDialog
        open={projectDialogOpen()}
        maxAdditionalRoots={capabilities().gemini.maxAdditionalRoots || 5}
        onClose={closeProjectDialog}
        onCreate={createProject}
      />

      <ProjectSettingsDialog
        open={projectSettingsOpen()}
        project={activeProject()}
        maxAdditionalRoots={capabilities().gemini.maxAdditionalRoots || 5}
        onClose={() => setProjectSettingsOpen(false)}
        onSave={updateProject}
        onDelete={deleteProject}
      />

      <ReconnectHistoryModal
        open={Boolean(pendingPrompt())}
        onChoose={(mode) => {
          if (activeSession()) handleChooseReconnectMode(activeSession()!.id, mode);
        }}
        onCancel={() => setPendingPrompt(null)}
      />

      <LiveViewModal
        url={livePreviewUrl()}
        onClose={() => setLivePreviewUrl(null)}
        onOpenExternal={openInExternalBrowser}
      />

      {uiError() && (
        <div class="error-toast" role="alert">
          <span><Icon name="warning" size={17} /></span>
          <div><strong>{uiError().title}</strong><p class="error-details" tabIndex={0}>{uiError().message}</p></div>
          {uiError().retry && <button type="button" onClick={() => { setUiError(null); uiError().retry?.(); }}>Erneut</button>}
          <button class="toast-close" type="button" onClick={() => setUiError(null)} aria-label="Fehler schließen"><Icon name="x" size={15} /></button>
        </div>
      )}
    </div>
    );
  });

  return <>{appContent()}</>;
}
