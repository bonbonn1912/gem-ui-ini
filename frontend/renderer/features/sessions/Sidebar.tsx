import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
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

function HighlightText(props: { text: string; query: string | (() => string) }) {
  const parts = createMemo(() => {
    const trimmed = (typeof props.query === "function" ? props.query() : props.query).trim();
    if (!trimmed) return [props.text];
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return props.text.split(new RegExp(`(${escaped})`, "gi"));
  });

  return (
    <>
      {parts().map((part) =>
        (() => {
          const trimmed = (typeof props.query === "function" ? props.query() : props.query).trim();
          const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return trimmed && new RegExp(`^${escaped}$`, "i").test(part);
        })() ? (
          <mark  class="search-highlight">
            {part}
          </mark>
        ) : (
            part
        ),
      )}
    </>
  );
}

function SessionRow(props: {
  session: AppSession;
  active: boolean;
  searchQuery?: string | (() => string);
  matchedSnippet?: string | null;
  onSelect: () => void;
  onUpdate: (patch: Partial<SessionPatch>) => void;
  onDelete: () => void;
}) {
  const menuRef = useDismissOnOutsideClick<HTMLDetailsElement>();
  const [renaming, setRenaming] = createSignal(false);
  const [title, setTitle] = createSignal(props.session.title);

  const commitTitle = () => {
    const trimmed = title().trim();
    setRenaming(false);
    if (trimmed && trimmed !== props.session.title) props.onUpdate({ title: trimmed });
    else setTitle(props.session.title);
  };

  const onRenameKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") commitTitle();
    if (event.key === "Escape") {
      setTitle(props.session.title);
      setRenaming(false);
    }
  };

  return (
    <div class={`session-row ${props.active ? "session-row--active" : ""}`}>
      <button
        class="session-main"
        type="button"
        onClick={props.onSelect}
        onDblClick={() => setRenaming(true)}
        aria-current={props.active ? "page" : undefined}
      >
        <span class={`session-status session-status--${props.session.status}`} title={statusLabel(props.session.status)} />
        <span class="session-copy">
          {renaming() ? (
            <input
              class="session-rename"
              value={title()}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={onRenameKeyDown}
              onClick={(event) => event.stopPropagation()}
              autofocus
              aria-label="Session umbenennen"
            />
          ) : (
            <span class="session-title">
              <HighlightText text={props.session.title} query={() => typeof props.searchQuery === "function" ? props.searchQuery() : props.searchQuery ?? ""} />
            </span>
          )}
          {props.matchedSnippet && (
            <span class="session-search-snippet" title={props.matchedSnippet}>
              <HighlightText text={props.matchedSnippet} query={() => typeof props.searchQuery === "function" ? props.searchQuery() : props.searchQuery ?? ""} />
            </span>
          )}
          <span class="session-meta">
            {props.session.status !== "idle" ? statusLabel(props.session.status) : relativeTime(props.session.updatedAt)}
          </span>
        </span>
        {props.session.pinned && <Icon name="pin" size={12} class="session-pin" />}
      </button>
      <details ref={menuRef} class="session-menu">
        <summary aria-label={`Aktionen für ${props.session.title}`}><Icon name="more" size={17} /></summary>
        <div class="session-menu-popover">
          <button type="button" onClick={() => setRenaming(true)}>Umbenennen</button>
          <button type="button" onClick={() => props.onUpdate({ pinned: !props.session.pinned })}>
            <Icon name="pin" size={14} /> {props.session.pinned ? "Lösen" : "Anpinnen"}
          </button>
          <button type="button" onClick={() => props.onUpdate({ archived: !props.session.archived })}>
            <Icon name="archive" size={14} /> {props.session.archived ? "Wiederherstellen" : "Archivieren"}
          </button>
          <button class="danger-menu-item" type="button" onClick={props.onDelete}>
            <Icon name="trash" size={14} /> Löschen
          </button>
        </div>
      </details>
    </div>
  );
}

function SessionGroup(props: {
  label: string;
  sessions: AppSession[];
  activeSessionId: string | null;
  searchQuery?: string | (() => string);
  contentMatches?: Map<string, string>;
  onSelectSession: (sessionId: string) => void;
  onUpdateSession: (sessionId: string, patch: Partial<SessionPatch>) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  if (!props.sessions.length) return null;
  return (
    <section class="session-group">
      {props.label ? <h2>{props.label}</h2> : null}
      <div class="session-list">
        {props.sessions.map((session) => (
          <SessionRow

            session={session}
            active={session.id === props.activeSessionId}
            searchQuery={props.searchQuery}
            matchedSnippet={props.contentMatches?.get(session.id)}
            onSelect={() => props.onSelectSession(session.id)}
            onUpdate={(patch) => props.onUpdateSession(session.id, patch)}
            onDelete={() => props.onDeleteSession(session.id)}
          />
        ))}
      </div>
    </section>
  );
}

export function Sidebar(props: SidebarProps) {
  const [query, setQuery] = createSignal("");
  const [searchContent, setSearchContent] = createSignal(false);
  const [contentMatches, setContentMatches] = createSignal<Map<string, string>>(new Map());

  createEffect(() => {
    const trimmed = query().trim();
    if (!searchContent() || !trimmed || !props.activeProjectId) {
      setContentMatches(new Map());
      return;
    }

    let active = true;
    const timeoutId = window.setTimeout(() => {
      window.gemUi.sessions
        .search({ projectId: props.activeProjectId, query: trimmed, searchContent: true })
        .then((result) => {
          if (!active) return;
          const map = new Map<string, string>();
          for (const res of result.results) {
            if (res.matchedSnippet) {
              map.set(res.sessionId, res.matchedSnippet);
            }
          }
          setContentMatches(map);
        })
        .catch(() => {
          if (active) setContentMatches(new Map());
        });
    }, 150);

    onCleanup(() => {
      active = false;
      window.clearTimeout(timeoutId);
    });
  });

  const normalizedQuery = createMemo(() => query().trim().toLocaleLowerCase("de"));
  const filtered = createMemo(() => {
    if (!normalizedQuery()) return props.sessions;
    return props.sessions.filter((session) => {
      const titleMatch = session.title.toLocaleLowerCase("de").includes(normalizedQuery());
      const contentMatch = searchContent() && contentMatches().has(session.id);
      return titleMatch || contentMatch;
    });
  });

  const active = createMemo(() => filtered().filter((session) => !session.archived));
  const pinned = createMemo(() => active().filter((session) => session.pinned));
  const recent = createMemo(() => active().filter((session) => !session.pinned));
  const archived = createMemo(() => filtered().filter((session) => session.archived));
  const currentProject = createMemo(() => props.projects.find((project) => project.id === props.activeProjectId));

  return (
    <>
      <button
        type="button"
        class={`sidebar-backdrop ${props.open ? "sidebar-backdrop--visible" : ""}`}
        aria-label="Seitenleiste schließen"
        onClick={props.onClose}
        tabIndex={props.open ? 0 : -1}
      />
      <aside class={`sidebar ${props.open ? "sidebar--open" : ""}`} aria-label="Projekte und Sessions">
        <div class="sidebar-drag-region" data-tauri-drag-region>
          <div class="brand-mark"><Icon name="sparkle" size={18} /></div>
          <span class="brand-name">GeminUI</span>
          <button type="button" class="icon-button sidebar-close" onClick={props.onClose} aria-label="Seitenleiste schließen">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div class="project-switcher-row">
          <label class="project-switcher">
            <span class="sr-only">Projekt auswählen</span>
            <Icon name="folder" size={16} />
            <select
              value={props.activeProjectId ?? ""}
              onChange={(event) => props.onSelectProject(event.target.value)}
              disabled={!props.projects.length}
            >
              {!props.projects.length && <option value="">Kein Projekt</option>}
              {props.projects.map((project) => <option value={project.id}>{project.name}</option>)}
            </select>
            <Icon name="chevron-down" size={14} />
          </label>
          <button type="button" class="icon-button" onClick={props.onCreateProject} aria-label="Projekt anlegen">
            <Icon name="plus" size={18} />
          </button>
        </div>

        {currentProject() && (
          <div class="project-root-summary" title={currentProject()!.roots.map((root) => root.path).join("\n")}>
            <span>{currentProject()!.roots.length} {currentProject()!.roots.length === 1 ? "Ordner" : "Ordner"}</span>
            <span class="root-summary-dot" />
            <span>Revision {currentProject()!.rootRevision}</span>
            <button type="button" onClick={props.onEditProject} aria-label="Projekt bearbeiten">
              <Icon name="settings" size={13} />
            </button>
          </div>
        )}

        <button class="new-session-button" type="button" onClick={props.onCreateSession} disabled={!props.activeProjectId}>
          <Icon name="plus" size={17} />
          Neue Session
          <span class="shortcut">⌘ N</span>
        </button>

        <div class="session-search-wrapper">
          <label class="session-search">
            <Icon name="search" size={15} />
            <span class="sr-only">Sessions durchsuchen</span>
            <input
              type="search"
              placeholder={searchContent() ? "Inhalt & Titel suchen…" : "Sessions suchen…"}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query() && (
              <button type="button" onClick={() => setQuery("")} aria-label="Suche leeren"><Icon name="x" size={13} /></button>
            )}
          </label>
          <label class="session-search-toggle" title="Durchsucht auch alle Nachrichten und Antworten innerhalb der Sessions">
            <input
              type="checkbox"
              checked={searchContent()}
              onChange={(event) => setSearchContent(event.target.checked)}
            />
            <span>Inhalt durchsuchen</span>
          </label>
        </div>

        <div class="sessions-scroll">
          {props.sessionsLoading ? (
            <div class="sidebar-skeleton" aria-label="Sessions werden geladen">
              <i /><i /><i /><i />
            </div>
          ) : filtered().length ? (
            <>
              <SessionGroup
                label="Angepinnt"
                sessions={pinned()}
                activeSessionId={props.activeSessionId}
                searchQuery={() => normalizedQuery() ? query() : ""}
                contentMatches={contentMatches()}
                onSelectSession={props.onSelectSession}
                onUpdateSession={props.onUpdateSession}
                onDeleteSession={props.onDeleteSession}
              />
              <SessionGroup
                label={pinned().length ? "Zuletzt" : "Sessions"}
                sessions={recent()}
                activeSessionId={props.activeSessionId}
                searchQuery={() => normalizedQuery() ? query() : ""}
                contentMatches={contentMatches()}
                onSelectSession={props.onSelectSession}
                onUpdateSession={props.onUpdateSession}
                onDeleteSession={props.onDeleteSession}
              />
              {archived().length > 0 && (
                <details class="archived-sessions">
                  <summary><Icon name="archive" size={13} /> Archiviert <span>{archived().length}</span></summary>
                  <SessionGroup
                    label=""
                    sessions={archived()}
                    activeSessionId={props.activeSessionId}
                    searchQuery={() => normalizedQuery() ? query() : ""}
                    contentMatches={contentMatches()}
                    onSelectSession={props.onSelectSession}
                    onUpdateSession={props.onUpdateSession}
                    onDeleteSession={props.onDeleteSession}
                  />
                </details>
              )}
            </>
          ) : props.sessions.length ? (
            <div class="sidebar-empty"><Icon name="search" size={20} /><p>Keine passende Session</p></div>
          ) : (
            <div class="sidebar-empty"><Icon name="chat" size={20} /><p>Noch keine Sessions</p><button type="button" onClick={props.onCreateSession}>Erste Session starten</button></div>
          )}
        </div>

        <div class="sidebar-footer">
          <div class="sidebar-footer-cli">
            <span class={`agent-dot agent-dot--${props.capabilities.gemini.available && props.capabilities.gemini.acp ? "ready" : "error"}`} />
            <span>{props.capabilities.gemini.available && props.capabilities.gemini.acp ? `Gemini ${props.capabilities.gemini.version ?? "bereit"}` : "Gemini nicht bereit"}</span>
          </div>
          <AppInfoUpdatePopover capabilities={props.capabilities} />
        </div>
      </aside>
    </>
  );
}
