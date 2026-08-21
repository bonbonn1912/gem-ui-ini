import { Icon } from "../../components/Icon";
import type {
  AppProject,
  AppSession,
  SessionMode,
  TokenCounters,
} from "../../types";
import type { ChatState } from "./reducer";

type ChatHeaderProps = {
  project: AppProject;
  session: AppSession;
  chat: ChatState;
  modelsSupported: boolean;
  onOpenSidebar: () => void;
  onEditProject: () => void;
  changesOpen: boolean;
  changesCount: number;
  onToggleChanges: () => void;
  onSetMode: (mode: string) => void;
  onSetModel: (model: string) => void;
};

function stateLabel(session: AppSession, chat: ChatState): string {
  const status = chat.phase === "idle" ? session.status : chat.phase;
  switch (status) {
    case "running": return "Gemini arbeitet";
    case "awaiting_permission": return "Wartet auf Freigabe";
    case "cancelling": return "Wird gestoppt";
    case "starting": return "Session startet";
    case "queued": return "In Warteschlange";
    case "roots_changed": return "Ordner geändert";
    case "error": return "Fehler";
    case "disconnected": return "Verbindung getrennt";
    default: return "Bereit";
  }
}

function rootName(path: string, label?: string): string {
  return label || path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function exactNumber(value: number): string {
  return value.toLocaleString("de-DE");
}

const TOKEN_SOURCE_LABELS: Record<string, string> = {
  acp_prompt_usage: "ACP PromptResponse.usage",
  gemini_meta_quota: "Gemini _meta.quota",
  legacy_event: "ältere GeminUI-Aufzeichnung",
  geminui_aggregate: "von GeminUI summiert",
  acp_usage_update: "ACP usage_update",
};

function counterLines(tokens: TokenCounters): string[] {
  const lines: string[] = [];
  if (tokens.input !== null) lines.push(`Eingabe: ${exactNumber(tokens.input)} Token`);
  if (tokens.output !== null) lines.push(`Ausgabe: ${exactNumber(tokens.output)} Token`);
  if (tokens.total !== null) {
    lines.push(
      tokens.totalKind === "derived_input_plus_output"
        ? `Gesamt: ${exactNumber(tokens.total)} Token (aus Eingabe + Ausgabe berechnet)`
        : `Gesamt: ${exactNumber(tokens.total)} Token`,
    );
  }
  if (tokens.thought !== null) lines.push(`Gedanken: ${exactNumber(tokens.thought)} Token`);
  if (tokens.cachedRead !== null) lines.push(`Cache gelesen: ${exactNumber(tokens.cachedRead)} Token`);
  if (tokens.tool !== null) lines.push(`Werkzeuge: ${exactNumber(tokens.tool)} Token`);
  return lines;
}

type UsagePresentation = {
  label: string;
  title: string;
  percent?: number;
};

/**
 * Presents exactly what the agent reported.
 *
 * The pill is always visible: an empty display means "not reported yet", not a
 * broken feature. Consumption is never shown as a context percentage, and no
 * context-window size is invented when the agent did not send one.
 */
function usagePresentation(chat: ChatState, working: boolean): UsagePresentation {
  const snapshot = chat.usage;
  const pending = working
    ? "Der laufende Turn ist noch nicht enthalten. Gemini CLI meldet Tokenzahlen erst nach Abschluss des Turns."
    : null;

  const lastTurn = snapshot?.lastTurn;
  const details: string[] = [];
  if (lastTurn) {
    details.push(
      `Letzter Turn (${TOKEN_SOURCE_LABELS[lastTurn.source] ?? lastTurn.source}):`,
      ...counterLines(lastTurn.tokens).map((line) => `  ${line}`),
    );
    for (const model of lastTurn.byModel) {
      details.push(`  ${model.model}: ${exactNumber(model.input)} ein / ${exactNumber(model.output)} aus`);
    }
  }
  if (snapshot?.cost) {
    details.push(`Kosten: ${snapshot.cost.amount} ${snapshot.cost.currency}`);
  }

  const session = snapshot?.session ?? null;
  const coverageNote = session
    ? session.coverage === "partial"
      ? "Erfasst seit Aktivierung der Zählung, nicht die vollständige Sessionhistorie."
      : session.coverage === "provider_reported"
        ? "Vom Agenten kumulativ für die Session gemeldet."
        : "Vollständig für alle von GeminUI beobachteten Turns."
    : null;

  if (session) {
    details.push(
      `Sessionverbrauch (${TOKEN_SOURCE_LABELS[session.source] ?? session.source}):`,
      ...counterLines(session.tokens).map((line) => `  ${line}`),
    );
    if (coverageNote) details.push(coverageNote);
  }

  const context = snapshot?.context ?? null;
  if (context) {
    const percent = Math.round((context.used / context.size) * 100);
    return {
      label: `Kontext ${exactNumber(context.used)} / ${exactNumber(context.size)} · ${percent} %`,
      title: [
        `Kontextfenster: ${exactNumber(context.used)} von ${exactNumber(context.size)} Token belegt (${percent} %).`,
        ...details,
        ...(pending ? [pending] : []),
      ].join("\n"),
      percent,
    };
  }

  const sessionTotal = session?.tokens.total ?? session?.tokens.input ?? null;
  if (session && sessionTotal !== null) {
    return {
      label: `${session.coverage === "partial" ? "Seit Erfassung" : "Session"} ${compactNumber(sessionTotal)} Token`,
      title: [
        "Kontextbelegung wurde von Gemini nicht gemeldet, deshalb gibt es keinen Prozentwert.",
        ...details,
        ...(pending ? [pending] : []),
      ].join("\n"),
    };
  }

  return {
    label: "Token: –",
    title: [
      "Gemini hat für diese Session noch keine Nutzung gemeldet.",
      ...details,
      ...(pending ? [pending] : []),
    ].join("\n"),
  };
}

export function ChatHeader({
  project,
  session,
  chat,
  modelsSupported,
  onOpenSidebar,
  onEditProject,
  changesOpen,
  changesCount,
  onToggleChanges,
  onSetMode,
  onSetModel,
}: ChatHeaderProps) {
  const modes: SessionMode[] = session.availableModes ?? chat.modes.map((mode) => ({
    id: mode,
    name: mode.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
  }));
  const models = Array.from(new Set([
    ...chat.models,
    ...(session.model ? [session.model] : []),
  ]));
  const working = ["running", "awaiting_permission", "cancelling"].includes(chat.phase);
  const usage = usagePresentation(chat, working);

  return (
    <header className="chat-header">
      <button type="button" className="icon-button mobile-menu-button" onClick={onOpenSidebar} aria-label="Seitenleiste öffnen">
        <Icon name="menu" size={19} />
      </button>
      <div className="chat-heading">
        <h1>{session.title}</h1>
        <div className="chat-subtitle">
          <span>{project.name}</span>
          <span className="subtitle-separator">/</span>
          <span className={`live-state live-state--${working ? "working" : chat.phase}`}>
            <i />{stateLabel(session, chat)}
          </span>
        </div>
      </div>

      <div className="header-actions">
        <span
          className="usage-pill"
          title={usage.title}
          aria-label={usage.title.replaceAll("\n", ". ")}
        >
          {usage.percent !== undefined && (
            <i aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, usage.percent))}%` }} /></i>
          )}
          <span>{usage.label}</span>
        </span>
        <button
          className={`changes-toggle ${changesOpen ? "changes-toggle--active" : ""}`}
          type="button"
          onClick={onToggleChanges}
          aria-pressed={changesOpen}
          aria-label={`Änderungen ${changesOpen ? "schließen" : "öffnen"}${changesCount > 0 ? `, ${changesCount} Dateien` : ""}`}
        >
          <Icon name="changes" size={15} />
          <span>Änderungen</span>
          {changesCount > 0 && <i>{changesCount > 999 ? "999+" : changesCount}</i>}
        </button>
        <details className="roots-menu">
          <summary>
            <Icon name="folder" size={15} />
            <span>{project.roots.length} {project.roots.length === 1 ? "Root" : "Roots"}</span>
            <Icon name="chevron-down" size={13} />
          </summary>
          <div className="roots-popover">
            <div className="roots-popover-heading">
              <div><strong>Projektordner</strong><span>Gemini-Kontext dieser Session</span></div>
              <span className="revision-badge">r{project.rootRevision}</span>
            </div>
            <div className="roots-popover-list">
              {project.roots.map((root) => (
                <div className="root-popover-item" key={root.id}>
                  <span className="root-kind-icon"><Icon name="folder" size={16} /></span>
                  <div><strong>{rootName(root.path, root.label)}</strong><span>{root.path}</span></div>
                  {root.kind === "primary" && <span className="primary-badge">Primär</span>}
                </div>
              ))}
            </div>
            <p><Icon name="shield" size={14} /> Änderungen bleiben Geminis Freigaberegeln unterworfen.</p>
            <button className="roots-edit-button" type="button" onClick={onEditProject}>
              <Icon name="settings" size={14} /> Projektordner bearbeiten
            </button>
          </div>
        </details>

        {modes.length ? (
          <label className="mode-select">
            <span className="sr-only">Gemini-Modus</span>
            <select value={session.mode ?? modes[0]?.id ?? ""} onChange={(event) => onSetMode(event.target.value)} disabled={working}>
              {modes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
            </select>
            <Icon name="chevron-down" size={13} />
          </label>
        ) : session.mode ? (
          <span className="mode-pill">{session.mode}</span>
        ) : null}

        {modelsSupported && chat.models.length ? (
          <label className="model-select">
            <span className="sr-only">Gemini-Modell</span>
            <select value={session.model ?? ""} onChange={(event) => onSetModel(event.target.value)} disabled={working} aria-label="Gemini-Modell">
              {!session.model && <option value="" disabled>Modell wählen</option>}
              {models.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
            <Icon name="chevron-down" size={13} />
          </label>
        ) : (
          <span
            className="model-pill"
            title={modelsSupported
              ? "Gemini hat noch keine auswählbaren Modelle gemeldet."
              : "Diese Gemini-ACP-Anbindung stellt keinen Modellwechsel bereit."
            }
          >
            <span>Modell</span>
            <strong>{session.model ?? "nicht gemeldet"}</strong>
          </span>
        )}
      </div>
    </header>
  );
}
