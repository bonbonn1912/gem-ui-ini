import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Icon } from "../components/Icon";
import { Composer, type ComposerAttachment } from "../features/attachments/Composer";
import { ChatHeader } from "../features/chat/ChatHeader";
import { Timeline } from "../features/chat/Timeline";
import { chatReducer, createChatState, type TurnPhase } from "../features/chat/reducer";
import { ProjectDialog } from "../features/projects/ProjectDialog";
import { ProjectSettingsDialog } from "../features/projects/ProjectSettingsDialog";
import { Sidebar } from "../features/sessions/Sidebar";
import type {
  AppCapabilities,
  AppProject,
  AppSession,
  ProjectRootCandidate,
  UiError,
  StreamEnvelope,
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
    <main className="boot-screen" aria-label="GeminUI wird geladen">
      <div className="boot-brand"><span><Icon name="sparkle" size={25} /></span><strong>GeminUI</strong></div>
      <div className="boot-progress"><i /></div>
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
    <main className="onboarding-screen">
      <section className="onboarding-card">
        <div className="onboarding-logo"><Icon name="sparkle" size={28} /></div>
        <p className="eyebrow">Lokaler Desktop-Client</p>
        <h1>{title}</h1>
        <p className="onboarding-copy">{body}</p>
        <div className="onboarding-steps">
          <div><span>1</span><p><strong>Gemini CLI installieren</strong><code>npm install -g @google/gemini-cli</code></p></div>
          <div><span>2</span><p><strong>Einmal anmelden</strong><code>gemini</code></p></div>
          <div><span>3</span><p><strong>Hier erneut prüfen</strong><small>GeminUI verwendet deine bestehende lokale Anmeldung.</small></p></div>
        </div>
        <div className="onboarding-actions">
          <button className="primary-button" type="button" onClick={onPickGemini} disabled={!onPickGemini} title={onPickGemini ? "Installierte Gemini CLI auswählen" : "Die Dateiauswahl ist in diesem Build noch nicht verfügbar"}>
            <Icon name="folder" size={16} /> Gemini auswählen
          </button>
          <button className="secondary-button onboarding-retry" type="button" onClick={onRetry}>
            <Icon name="refresh" size={16} /> Erneut prüfen
          </button>
        </div>
        {!onPickGemini && <p className="binary-picker-hint">Die Binary-Auswahl ist noch nicht verfügbar. Prüfe stattdessen deinen PATH und versuche es erneut.</p>}
        {capabilities.gemini.version && <p className="detected-version">Erkannt: Gemini {capabilities.gemini.version}</p>}
      </section>
    </main>
  );
}

function EmptyWorkspace({ onCreateProject }: { onCreateProject: () => void }) {
  return (
    <main className="workspace-empty">
      <div className="empty-illustration" aria-hidden="true">
        <span className="empty-folder empty-folder--back"><Icon name="folder" size={42} /></span>
        <span className="empty-folder empty-folder--front"><Icon name="folder-plus" size={48} /></span>
        <i /><i /><i />
      </div>
      <p className="eyebrow">Willkommen bei GeminUI</p>
      <h1>Dein erster Workspace</h1>
      <p>Verbinde einen Hauptordner und bei Bedarf weitere Ordner. Alle werden Teil desselben Gemini-Kontexts.</p>
      <button className="primary-button" type="button" onClick={onCreateProject}><Icon name="folder-plus" size={17} /> Projekt anlegen</button>
      <div className="empty-benefits">
        <span><Icon name="shield" size={15} /> Lokal auf deinem Rechner</span>
        <span><Icon name="chat" size={15} /> Mehrere Sessions</span>
        <span><Icon name="image" size={15} /> Bilder im Prompt</span>
      </div>
    </main>
  );
}

function EmptyProject({ project, onCreateSession }: { project: AppProject; onCreateSession: () => void }) {
  return (
    <main className="project-empty">
      <div className="project-empty-icon"><Icon name="chat" size={27} /></div>
      <p className="eyebrow">{project.name}</p>
      <h1>Starte eine neue Session</h1>
      <p>Gemini erhält Zugriff auf den gemeinsamen Kontext dieser Projektordner:</p>
      <div className="empty-root-list">
        {project.roots.map((root) => (
          <span key={root.id}><Icon name="folder" size={14} /> {root.label || root.path.split(/[\\/]/).at(-1)} {root.kind === "primary" && <i>Primär</i>}</span>
        ))}
      </div>
      <button className="primary-button" type="button" onClick={onCreateSession}><Icon name="plus" size={17} /> Neue Session</button>
    </main>
  );
}

function RootChangeBanner() {
  return (
    <div className="root-change-banner" role="alert">
      <Icon name="warning" size={17} />
      <p><strong>Projektordner wurden geändert.</strong><span>Prüfe die aktuelle Root-Liste, bevor du diese Session fortsetzt.</span></p>
    </div>
  );
}

export function App() {
  const [booting, setBooting] = useState(true);
  const [capabilities, setCapabilities] = useState<AppCapabilities | null>(null);
  const [projects, setProjects] = useState<AppProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AppSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [uiError, setUiError] = useState<UiError | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [chat, dispatch] = useReducer(chatReducer, null, () => createChatState());

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;

  const showError = useCallback((title: string, error: unknown, retry?: () => void) => {
    setUiError({ title, message: messageFrom(error), retry });
  }, []);
  const closeProjectDialog = useCallback(() => setProjectDialogOpen(false), []);

  const bootstrap = useCallback(async () => {
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
  }, []);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  useEffect(() => {
    if (!activeProjectId) {
      setSessions([]);
      setActiveSessionId(null);
      return;
    }
    let current = true;
    setSessionsLoading(true);
    window.gemUi.sessions.list({ projectId: activeProjectId, includeArchived: true })
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
    return () => { current = false; };
  }, [activeProjectId, showError]);

  useEffect(() => {
    dispatch({ type: "reset", sessionId: activeSessionId });
    if (!activeSessionId) return;
    let current = true;
    let unsubscribe: (() => void) | undefined;
    window.gemUi.subscribeSessionEvents(
      { sessionId: activeSessionId, afterSeq: 0 },
      (events) => {
        if (!current) return;
        dispatch({ type: "events", events });
        const status = sessionStatusFromEvents(events);
        if (status) {
          setSessions((currentSessions) => currentSessions.map((session) =>
            session.id === activeSessionId ? { ...session, status } : session,
          ));
        }
      },
    )
      .then((dispose) => {
        if (current) unsubscribe = dispose;
        else dispose();
      })
      .catch((error) => {
        if (current) showError("Live-Verbindung fehlgeschlagen", error);
      });
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [activeSessionId, showError]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "n") return;
      event.preventDefault();
      if (activeProjectId) void createSession();
      else setProjectDialogOpen(true);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
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
    if (!activeProjectId) return;
    try {
      const session = await window.gemUi.sessions.create({ projectId: activeProjectId, clientRequestId: createClientRequestId() });
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
    if (!activeProject) return;
    let updated = activeProject;
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
    if (!activeProject) return;
    const projectId = activeProject.id;
    await window.gemUi.projects.delete({
      projectId,
      clientRequestId: createClientRequestId(),
    });
    const remaining = projects.filter((project) => project.id !== projectId);
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
    const session = sessions.find((item) => item.id === sessionId);
    if (!window.confirm(`„${session?.title ?? "Session"}“ aus GeminUI löschen? Projektdateien werden nicht gelöscht.`)) return;
    try {
      await window.gemUi.sessions.delete({ sessionId, clientRequestId: createClientRequestId() });
      const remaining = sessions.filter((item) => item.id !== sessionId);
      setSessions(remaining);
      if (activeSessionId === sessionId) setActiveSessionId(remaining.find((item) => !item.archived)?.id ?? null);
    } catch (error) {
      showError("Session konnte nicht gelöscht werden", error);
    }
  };

  const sendPrompt = async (text: string, attachments: ComposerAttachment[]) => {
    if (!activeSession) return;
    const clientRequestId = createClientRequestId();
    dispatch({
      type: "optimistic-user",
      clientRequestId,
      text,
      attachments,
      timestamp: new Date().toISOString(),
    });
    setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, status: "running" } : session));
    try {
      const result = await window.gemUi.sessions.sendPrompt({
        sessionId: activeSession.id,
        text,
        attachmentIds: attachments.map((attachment) => attachment.id),
        expectedRootRevision: activeProject?.rootRevision ?? 1,
        clientRequestId,
      });
      dispatch({ type: "turn-started", turnId: result.turnId });
    } catch (error) {
      const message = messageFrom(error);
      dispatch({ type: "prompt-failed", clientRequestId, message });
      setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, status: "error" } : session));
      if (isProjectRootAccessError(error)) setProjectSettingsOpen(true);
      showError("Nachricht konnte nicht gesendet werden", error);
      throw error;
    }
  };

  const cancelTurn = async () => {
    if (!activeSession || !chat.activeTurnId) return;
    dispatch({ type: "cancelling" });
    try {
      await window.gemUi.sessions.cancel({ sessionId: activeSession.id, turnId: chat.activeTurnId, clientRequestId: createClientRequestId() });
    } catch (error) {
      showError("Antwort konnte nicht gestoppt werden", error);
      throw error;
    }
  };

  const respondToPermission = async (requestIdValue: string, optionId: string) => {
    if (!activeSession) return;
    dispatch({ type: "permission-submitting", requestId: requestIdValue, optionId });
    try {
      await window.gemUi.sessions.respondToPermission({
        sessionId: activeSession.id,
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
    window.gemUi.openExternalHttpsUrl(url).catch((error) => showError("Link konnte nicht geöffnet werden", error));
  };

  const effectivePhase: TurnPhase = useMemo(() => {
    if (chat.phase !== "idle" || !activeSession) return chat.phase;
    if (["running", "awaiting_permission", "cancelling"].includes(activeSession.status)) {
      return activeSession.status as TurnPhase;
    }
    if (activeSession.status === "disconnected" || activeSession.status === "error") return activeSession.status;
    return "idle";
  }, [activeSession, chat.phase]);

  if (booting) return <LoadingScreen />;
  if (fatalError) {
    return (
      <main className="fatal-screen">
        <Icon name="warning" size={28} />
        <h1>GeminUI konnte nicht gestartet werden</h1>
        <p>{fatalError}</p>
        <button className="primary-button" type="button" onClick={() => void bootstrap()}><Icon name="refresh" size={16} /> Erneut versuchen</button>
      </main>
    );
  }
  if (!capabilities) return null;
  if (!capabilities.gemini.available || !capabilities.gemini.acp) {
    return (
      <OnboardingScreen
        capabilities={capabilities}
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
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        capabilities={capabilities}
        projects={projects.filter((project) => !project.archived)}
        activeProjectId={activeProjectId}
        sessions={sessions}
        activeSessionId={activeSessionId}
        sessionsLoading={sessionsLoading}
        onClose={() => setSidebarOpen(false)}
        onCreateProject={() => setProjectDialogOpen(true)}
        onEditProject={() => setProjectSettingsOpen(true)}
        onSelectProject={(projectId) => { setActiveProjectId(projectId); setSidebarOpen(false); }}
        onCreateSession={() => void createSession()}
        onSelectSession={(sessionId) => { setActiveSessionId(sessionId); setSidebarOpen(false); }}
        onUpdateSession={(sessionId, patch) => void updateSession(sessionId, patch)}
        onDeleteSession={(sessionId) => void deleteSession(sessionId)}
      />

      <section className="main-pane">
        {!projects.length ? (
          <EmptyWorkspace onCreateProject={() => setProjectDialogOpen(true)} />
        ) : activeProject && !activeSession ? (
          <>
            <button type="button" className="icon-button mobile-empty-menu" onClick={() => setSidebarOpen(true)} aria-label="Seitenleiste öffnen"><Icon name="menu" size={19} /></button>
            <EmptyProject project={activeProject} onCreateSession={() => void createSession()} />
          </>
        ) : activeProject && activeSession ? (
          <div className="chat-view">
            <ChatHeader
              project={activeProject}
              session={activeSession}
              chat={{ ...chat, phase: effectivePhase }}
              modelsSupported={capabilities.gemini.models}
              onOpenSidebar={() => setSidebarOpen(true)}
              onEditProject={() => setProjectSettingsOpen(true)}
              onSetMode={(mode) => void setSessionMode(activeSession.id, mode)}
              onSetModel={(model) => void setSessionModel(activeSession.id, model)}
            />
            {activeSession.status === "roots_changed" && <RootChangeBanner />}
            <Timeline
              items={chat.items}
              sessionTitle={activeSession.title}
              onOpenExternal={openExternal}
              onRespondToPermission={(request, option) => void respondToPermission(request, option)}
            />
            <Composer
              key={activeSession.id}
              sessionId={activeSession.id}
              phase={effectivePhase}
              imagesSupported={capabilities.gemini.images}
              onSend={sendPrompt}
              onCancel={cancelTurn}
              onError={(error) => showError("Anhang konnte nicht verarbeitet werden", new Error(error))}
            />
          </div>
        ) : null}
      </section>

      <ProjectDialog
        open={projectDialogOpen}
        maxAdditionalRoots={capabilities.gemini.maxAdditionalRoots || 5}
        onClose={closeProjectDialog}
        onCreate={createProject}
      />

      <ProjectSettingsDialog
        open={projectSettingsOpen}
        project={activeProject}
        maxAdditionalRoots={capabilities.gemini.maxAdditionalRoots || 5}
        onClose={() => setProjectSettingsOpen(false)}
        onSave={updateProject}
        onDelete={deleteProject}
      />

      {uiError && (
        <div className="error-toast" role="alert">
          <span><Icon name="warning" size={17} /></span>
          <div><strong>{uiError.title}</strong><p className="error-details" tabIndex={0}>{uiError.message}</p></div>
          {uiError.retry && <button type="button" onClick={() => { setUiError(null); uiError.retry?.(); }}>Erneut</button>}
          <button className="toast-close" type="button" onClick={() => setUiError(null)} aria-label="Fehler schließen"><Icon name="x" size={15} /></button>
        </div>
      )}
    </div>
  );
}
