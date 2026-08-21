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
  attachmentsOpen: boolean;
  attachmentsCount: number;
  attachmentsIncludedCount: number;
  onToggleAttachments: () => void;
  changesOpen: boolean;
  changesCount: number;
  onToggleChanges: () => void;
  onSetMode: (mode: string) => void;
  onSetModel: (model: string) => void;
};

function optionLabel(id: string): string {
  return id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Merges the cached picker list with the IDs of the running session, keeping
 * the cached order and never dropping the current selection. `label` names an
 * entry that exists only as an ID: mode IDs read well once prettified, model
 * IDs are shown verbatim rather than dressed up into something Gemini never
 * said.
 */
function mergeOptions(
  cached: readonly SessionMode[] | undefined,
  live: readonly string[],
  current: string | null,
  label: (id: string) => string,
): SessionMode[] {
  const merged: SessionMode[] = [];
  const seen = new Set<string>();
  const add = (option: SessionMode) => {
    if (seen.has(option.id)) return;
    seen.add(option.id);
    merged.push(option);
  };

  for (const option of cached ?? []) add(option);
  for (const id of live) add({ id, name: label(id) });
  if (current) add({ id: current, name: label(current) });
  return merged;
}

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

const NOT_REPORTED = "nicht gemeldet";

function tokenLine(label: string, value: number | null, suffix = ""): string {
  return value === null
    ? `${label}: ${NOT_REPORTED}`
    : `${label}: ${exactNumber(value)} Token${suffix}`;
}

/**
 * Tooltip breakdown of one counter set.
 *
 * `verbose` spells out every counter including the ones the agent did not send.
 * That is what makes "Gemini reports no cache tokens" visible instead of the
 * value simply being absent and looking like zero.
 */
function counterLines(tokens: TokenCounters, verbose = false): string[] {
  const lines: string[] = [];
  if (verbose || tokens.input !== null) lines.push(tokenLine("Eingabe", tokens.input));
  if (verbose || tokens.output !== null) lines.push(tokenLine("Ausgabe", tokens.output));
  if (verbose || tokens.cachedRead !== null) {
    lines.push(tokenLine("Cache gelesen", tokens.cachedRead));
  }
  if (tokens.cachedWrite !== null) lines.push(tokenLine("Cache geschrieben", tokens.cachedWrite));
  if (verbose || tokens.thought !== null) lines.push(tokenLine("Gedanken", tokens.thought));
  if (tokens.tool !== null) lines.push(tokenLine("Werkzeuge", tokens.tool));
  lines.push(
    tokenLine(
      "Gesamt",
      tokens.total,
      tokens.totalKind === "derived_input_plus_output"
        ? " (aus Eingabe + Ausgabe berechnet)"
        : "",
    ),
  );
  return lines;
}

export type UsageMetric = {
  key: string;
  label: string;
  value: string;
};

type UsagePresentation = {
  /** Segments rendered inside the pill. Empty means nothing was reported yet. */
  metrics: UsageMetric[];
  placeholder: string | null;
  title: string;
  percent?: number;
};

/**
 * Presents exactly what the agent reported.
 *
 * The pill is always visible and names each counter separately: context
 * occupancy, session input, session output and session cache. A counter the
 * agent never sent shows a dash instead of a zero, and consumption is never
 * rendered as a context percentage.
 */
function usagePresentation(chat: ChatState, working: boolean): UsagePresentation {
  const snapshot = chat.usage;
  const context = snapshot?.context ?? null;
  const session = snapshot?.session ?? null;
  const lastTurn = snapshot?.lastTurn ?? null;

  const metrics: UsageMetric[] = [];
  const lines: string[] = [];
  let percent: number | undefined;

  if (context) {
    percent = Math.round((context.used / context.size) * 100);
    metrics.push({ key: "context", label: "Kontext", value: `${percent} %` });
    lines.push(
      `Kontextfenster: ${exactNumber(context.used)} von ${exactNumber(context.size)} Token belegt (${percent} %).`,
    );
  } else {
    lines.push("Kontextbelegung wurde von Gemini nicht gemeldet, deshalb gibt es keinen Prozentwert.");
  }

  if (session) {
    // "≥" is literal, not decorative: with partial coverage the true session
    // total is at least this large, because turns before tracking are missing.
    const atLeast = session.coverage === "partial" ? "≥ " : "";
    const value = (count: number | null) =>
      count === null ? "–" : `${atLeast}${exactNumber(count)}`;
    metrics.push(
      { key: "input", label: "In", value: value(session.tokens.input) },
      { key: "output", label: "Out", value: value(session.tokens.output) },
      { key: "cache", label: "Cache", value: value(session.tokens.cachedRead) },
    );

    lines.push(
      `Sessionverbrauch (${TOKEN_SOURCE_LABELS[session.source] ?? session.source}):`,
      ...counterLines(session.tokens, true).map((line) => `  ${line}`),
      session.coverage === "partial"
        ? "≥ bedeutet: erfasst seit Aktivierung der Zählung, nicht die vollständige Sessionhistorie."
        : session.coverage === "provider_reported"
          ? "Vom Agenten kumulativ für die Session gemeldet."
          : "Vollständig für alle von GeminUI beobachteten Turns.",
    );
  }

  if (lastTurn) {
    lines.push(
      `Letzter Turn (${TOKEN_SOURCE_LABELS[lastTurn.source] ?? lastTurn.source}):`,
      ...counterLines(lastTurn.tokens).map((line) => `  ${line}`),
      ...lastTurn.byModel.map(
        (model) =>
          `  ${model.model}: ${exactNumber(model.input)} ein / ${exactNumber(model.output)} aus`,
      ),
    );
  }

  if (snapshot?.cost) {
    lines.push(`Kosten: ${snapshot.cost.amount} ${snapshot.cost.currency}`);
  }
  if (working) {
    lines.push(
      "Der laufende Turn ist noch nicht enthalten. Gemini CLI meldet Tokenzahlen erst nach Abschluss des Turns.",
    );
  }

  if (metrics.length === 0) {
    return {
      metrics,
      placeholder: "Token: –",
      title: ["Gemini hat für diese Session noch keine Nutzung gemeldet.", ...lines.slice(1)].join("\n"),
    };
  }

  return {
    metrics,
    placeholder: null,
    title: lines.join("\n"),
    ...(percent !== undefined ? { percent } : {}),
  };
}

export function ChatHeader({
  project,
  session,
  chat,
  modelsSupported,
  onOpenSidebar,
  onEditProject,
  attachmentsOpen,
  attachmentsCount,
  attachmentsIncludedCount,
  onToggleAttachments,
  changesOpen,
  changesCount,
  onToggleChanges,
  onSetMode,
  onSetModel,
}: ChatHeaderProps) {
  // Two sources, both incomplete on their own: the cached lists carry display
  // names and are there from app start, the live event carries only IDs but is
  // the fresher one once a session runs. The current selection is appended so
  // it can never be missing from its own picker.
  const modes = mergeOptions(session.availableModes, chat.modes, session.mode, optionLabel);
  const models = mergeOptions(session.availableModels, chat.models, session.model, (id) => id);
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
          {usage.placeholder !== null ? (
            <span>{usage.placeholder}</span>
          ) : (
            usage.metrics.map((metric) => (
              <span className={`usage-metric usage-metric--${metric.key}`} key={metric.key}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </span>
            ))
          )}
        </span>
        <button
          className={`attachments-toggle ${attachmentsOpen ? "attachments-toggle--active" : ""}`}
          type="button"
          onClick={onToggleAttachments}
          aria-pressed={attachmentsOpen}
          aria-label={`Anhänge ${attachmentsOpen ? "schließen" : "öffnen"}${
            attachmentsCount > 0 ? `, ${attachmentsCount} Anhänge, ${attachmentsIncludedCount} im Kontext` : ""
          }`}
        >
          <Icon name="paperclip" size={15} />
          <span>Anhänge</span>
          {attachmentsCount > 0 && <i>{attachmentsCount > 99 ? "99+" : attachmentsCount}</i>}
          {attachmentsIncludedCount > 0 && <em>{attachmentsIncludedCount}</em>}
        </button>
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
              {modes.map((mode) => (
                <option key={mode.id} value={mode.id} title={mode.description}>{mode.name}</option>
              ))}
            </select>
            <Icon name="chevron-down" size={13} />
          </label>
        ) : session.mode ? (
          <span className="mode-pill">{session.mode}</span>
        ) : null}

        {/* One entry means the merge only recovered the current model — a
            dropdown that cannot change anything would promise a choice that
            does not exist, so the pill states the model instead. */}
        {modelsSupported && models.length > 1 ? (
          <label className="model-select">
            <span className="sr-only">Gemini-Modell</span>
            <select value={session.model ?? ""} onChange={(event) => onSetModel(event.target.value)} disabled={working} aria-label="Gemini-Modell">
              {!session.model && <option value="" disabled>Modell wählen</option>}
              {models.map((model) => (
                <option key={model.id} value={model.id} title={model.description}>{model.name}</option>
              ))}
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
