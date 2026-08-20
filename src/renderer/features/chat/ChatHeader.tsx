import { Icon } from "../../components/Icon";
import type { AppProject, AppSession, SessionMode } from "../../types";
import type { ChatState } from "./reducer";

type ChatHeaderProps = {
  project: AppProject;
  session: AppSession;
  chat: ChatState;
  modelsSupported: boolean;
  onOpenSidebar: () => void;
  onEditProject: () => void;
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

function usagePresentation(chat: ChatState): { label: string; title: string; percent?: number } | null {
  if (!chat.usage) return null;
  const used = chat.usage.used ?? chat.usage.totalTokens;
  if (used === undefined) return null;

  const details: string[] = [];
  if (chat.usage.inputTokens !== undefined) details.push(`Eingabe: ${chat.usage.inputTokens.toLocaleString("de-DE")} Token`);
  if (chat.usage.outputTokens !== undefined) details.push(`Ausgabe: ${chat.usage.outputTokens.toLocaleString("de-DE")} Token`);
  if (chat.usage.cost) details.push(`Kosten: ${chat.usage.cost.amount} ${chat.usage.cost.currency}`);

  if (chat.usage.size !== undefined && chat.usage.size > 0) {
    const percent = Math.round((used / chat.usage.size) * 100);
    return {
      label: `${used.toLocaleString("de-DE")} / ${chat.usage.size.toLocaleString("de-DE")} · ${percent} %`,
      title: [`Kontext: ${used.toLocaleString("de-DE")} von ${chat.usage.size.toLocaleString("de-DE")} Token (${percent} %)`, ...details].join("\n"),
      percent,
    };
  }

  return {
    label: `${compactNumber(used)} Token`,
    title: [`Gemeldete Tokennutzung: ${used.toLocaleString("de-DE")}. Die Kontextfenstergröße wurde nicht gemeldet.`, ...details].join("\n"),
  };
}

export function ChatHeader({
  project,
  session,
  chat,
  modelsSupported,
  onOpenSidebar,
  onEditProject,
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
  const usage = usagePresentation(chat);

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
        {usage && (
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
        )}
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
