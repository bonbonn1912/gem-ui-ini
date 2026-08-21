import { useMemo, useState, type KeyboardEvent } from "react";
import { Icon } from "../../components/Icon";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
import type { AppCapabilities, AppProject, AppSession } from "../../types";
import { AppInfoUpdatePopover } from "../updates/AppInfoUpdatePopover";

type SessionPatch = Pick<AppSession, "title" | "pinned" | "archived">;

type SidebarProps = {
  open: boolean;
  capabilities: AppCapabilities;
  projects: AppProject[];
  activeProjectId: string | null;
  sessions: AppSession[];
  activeSessionId: string | null;
  sessionsLoading: boolean;
  onClose: () => void;
  onCreateProject: () => void;
  onEditProject: () => void;
  onSelectProject: (projectId: string) => void;
  onCreateSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onUpdateSession: (sessionId: string, patch: Partial<SessionPatch>) => void;
  onDeleteSession: (sessionId: string) => void;
};

function relativeTime(value: string): string {
  const date = new Date(value);
  const delta = date.getTime() - Date.now();
  const minutes = Math.round(delta / 60_000);
  if (Math.abs(minutes) < 1) return "Gerade eben";
  if (Math.abs(minutes) < 60) return new Intl.RelativeTimeFormat("de", { numeric: "auto" }).format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return new Intl.RelativeTimeFormat("de", { numeric: "auto" }).format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return new Intl.RelativeTimeFormat("de", { numeric: "auto" }).format(days, "day");
  return new Intl.DateTimeFormat("de", { day: "2-digit", month: "short" }).format(date);
}

function statusLabel(status: AppSession["status"]): string {
  switch (status) {
    case "running": return "Gemini antwortet";
    case "starting": return "Wird gestartet";
    case "awaiting_permission": return "Freigabe erforderlich";
    case "cancelling": return "Wird gestoppt";
    case "queued": return "In Warteschlange";
    case "roots_changed": return "Ordner geändert";
    case "error": return "Fehler";
    case "disconnected": return "Getrennt";
    default: return "Bereit";
  }
}

function SessionRow({
  session,
  active,
  onSelect,
  onUpdate,
  onDelete,
}: {
  session: AppSession;
  active: boolean;
  onSelect: () => void;
  onUpdate: (patch: Partial<SessionPatch>) => void;
  onDelete: () => void;
}) {
  const menuRef = useDismissOnOutsideClick<HTMLDetailsElement>();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session.title);

  const commitTitle = () => {
    const trimmed = title.trim();
    setRenaming(false);
    if (trimmed && trimmed !== session.title) onUpdate({ title: trimmed });
    else setTitle(session.title);
  };

  const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commitTitle();
    if (event.key === "Escape") {
      setTitle(session.title);
      setRenaming(false);
    }
  };

  return (
    <div className={`session-row ${active ? "session-row--active" : ""}`}>
      <button
        className="session-main"
        type="button"
        onClick={onSelect}
        onDoubleClick={() => setRenaming(true)}
        aria-current={active ? "page" : undefined}
      >
        <span className={`session-status session-status--${session.status}`} title={statusLabel(session.status)} />
        <span className="session-copy">
          {renaming ? (
            <input
              className="session-rename"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={onRenameKeyDown}
              onClick={(event) => event.stopPropagation()}
              autoFocus
              aria-label="Session umbenennen"
            />
          ) : (
            <span className="session-title">{session.title}</span>
          )}
          <span className="session-meta">
            {session.status !== "idle" ? statusLabel(session.status) : relativeTime(session.updatedAt)}
          </span>
        </span>
        {session.pinned && <Icon name="pin" size={12} className="session-pin" />}
      </button>
      <details ref={menuRef} className="session-menu">
        <summary aria-label={`Aktionen für ${session.title}`}><Icon name="more" size={17} /></summary>
        <div className="session-menu-popover">
          <button type="button" onClick={() => setRenaming(true)}>Umbenennen</button>
          <button type="button" onClick={() => onUpdate({ pinned: !session.pinned })}>
            <Icon name="pin" size={14} /> {session.pinned ? "Lösen" : "Anpinnen"}
          </button>
          <button type="button" onClick={() => onUpdate({ archived: !session.archived })}>
            <Icon name="archive" size={14} /> {session.archived ? "Wiederherstellen" : "Archivieren"}
          </button>
          <button className="danger-menu-item" type="button" onClick={onDelete}>
            <Icon name="trash" size={14} /> Löschen
          </button>
        </div>
      </details>
    </div>
  );
}

function SessionGroup({
  label,
  sessions,
  activeSessionId,
  onSelectSession,
  onUpdateSession,
  onDeleteSession,
}: {
  label: string;
  sessions: AppSession[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onUpdateSession: (sessionId: string, patch: Partial<SessionPatch>) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  if (!sessions.length) return null;
  return (
    <section className="session-group">
      <h2>{label}</h2>
      <div className="session-list">
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            active={session.id === activeSessionId}
            onSelect={() => onSelectSession(session.id)}
            onUpdate={(patch) => onUpdateSession(session.id, patch)}
            onDelete={() => onDeleteSession(session.id)}
          />
        ))}
      </div>
    </section>
  );
}

export function Sidebar({
  open,
  capabilities,
  projects,
  activeProjectId,
  sessions,
  activeSessionId,
  sessionsLoading,
  onClose,
  onCreateProject,
  onEditProject,
  onSelectProject,
  onCreateSession,
  onSelectSession,
  onUpdateSession,
  onDeleteSession,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("de");
  const filtered = useMemo(
    () => sessions.filter((session) => session.title.toLocaleLowerCase("de").includes(normalizedQuery)),
    [normalizedQuery, sessions],
  );
  const active = filtered.filter((session) => !session.archived);
  const pinned = active.filter((session) => session.pinned);
  const recent = active.filter((session) => !session.pinned);
  const archived = filtered.filter((session) => session.archived);
  const currentProject = projects.find((project) => project.id === activeProjectId);

  return (
    <>
      <button
        type="button"
        className={`sidebar-backdrop ${open ? "sidebar-backdrop--visible" : ""}`}
        aria-label="Seitenleiste schließen"
        onClick={onClose}
        tabIndex={open ? 0 : -1}
      />
      <aside className={`sidebar ${open ? "sidebar--open" : ""}`} aria-label="Projekte und Sessions">
        <div className="sidebar-drag-region">
          <div className="brand-mark"><Icon name="sparkle" size={18} /></div>
          <span className="brand-name">GeminUI</span>
          <button type="button" className="icon-button sidebar-close" onClick={onClose} aria-label="Seitenleiste schließen">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="project-switcher-row">
          <label className="project-switcher">
            <span className="sr-only">Projekt auswählen</span>
            <Icon name="folder" size={16} />
            <select
              value={activeProjectId ?? ""}
              onChange={(event) => onSelectProject(event.target.value)}
              disabled={!projects.length}
            >
              {!projects.length && <option value="">Kein Projekt</option>}
              {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
            </select>
            <Icon name="chevron-down" size={14} />
          </label>
          <button type="button" className="icon-button" onClick={onCreateProject} aria-label="Projekt anlegen">
            <Icon name="plus" size={18} />
          </button>
        </div>

        {currentProject && (
          <div className="project-root-summary" title={currentProject.roots.map((root) => root.path).join("\n")}>
            <span>{currentProject.roots.length} {currentProject.roots.length === 1 ? "Ordner" : "Ordner"}</span>
            <span className="root-summary-dot" />
            <span>Revision {currentProject.rootRevision}</span>
            <button type="button" onClick={onEditProject} aria-label="Projekt bearbeiten">
              <Icon name="settings" size={13} />
            </button>
          </div>
        )}

        <button className="new-session-button" type="button" onClick={onCreateSession} disabled={!activeProjectId}>
          <Icon name="plus" size={17} />
          Neue Session
          <span className="shortcut">⌘ N</span>
        </button>

        <label className="session-search">
          <Icon name="search" size={15} />
          <span className="sr-only">Sessions durchsuchen</span>
          <input
            type="search"
            placeholder="Sessions suchen"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Suche leeren"><Icon name="x" size={13} /></button>
          )}
        </label>

        <div className="sessions-scroll">
          {sessionsLoading ? (
            <div className="sidebar-skeleton" aria-label="Sessions werden geladen">
              <i /><i /><i /><i />
            </div>
          ) : filtered.length ? (
            <>
              <SessionGroup label="Angepinnt" sessions={pinned} activeSessionId={activeSessionId} onSelectSession={onSelectSession} onUpdateSession={onUpdateSession} onDeleteSession={onDeleteSession} />
              <SessionGroup label={pinned.length ? "Zuletzt" : "Sessions"} sessions={recent} activeSessionId={activeSessionId} onSelectSession={onSelectSession} onUpdateSession={onUpdateSession} onDeleteSession={onDeleteSession} />
              {archived.length > 0 && (
                <details className="archived-sessions">
                  <summary><Icon name="archive" size={13} /> Archiviert <span>{archived.length}</span></summary>
                  <SessionGroup label="" sessions={archived} activeSessionId={activeSessionId} onSelectSession={onSelectSession} onUpdateSession={onUpdateSession} onDeleteSession={onDeleteSession} />
                </details>
              )}
            </>
          ) : sessions.length ? (
            <div className="sidebar-empty"><Icon name="search" size={20} /><p>Keine passende Session</p></div>
          ) : (
            <div className="sidebar-empty"><Icon name="chat" size={20} /><p>Noch keine Sessions</p><button type="button" onClick={onCreateSession}>Erste Session starten</button></div>
          )}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-footer-cli">
            <span className={`agent-dot agent-dot--${capabilities.gemini.available && capabilities.gemini.acp ? "ready" : "error"}`} />
            <span>{capabilities.gemini.available && capabilities.gemini.acp ? `Gemini ${capabilities.gemini.version ?? "bereit"}` : "Gemini nicht bereit"}</span>
          </div>
          <AppInfoUpdatePopover capabilities={capabilities} />
        </div>
      </aside>
    </>
  );
}
