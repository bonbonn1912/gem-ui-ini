import { Icon } from "../../components/Icon";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
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

type UsagePresentation = {
  /** Caption and value of the single figure the pill shows. */
  caption: string | null;
  value: string | null;
  /** Set instead of caption/value when nothing has been reported yet. */
  placeholder: string | null;
  title: string;
  percent?: number;
};

/**
 * Presents exactly what the agent reported.
 *
 * The pill is always visible but says one thing only: how full the context
 * window is when the agent reported a size, otherwise how many tokens the
 * session has used. The full breakdown — input, output, cache, last turn and
 * where each number came from — lives in the tooltip, so a header that has to
 * stay readable is not asked to carry four counters at once.
 *
 * What is not reported is never invented: consumption is not dressed up as a
 * context percentage, and a counter the agent never sent shows a dash rather
 * than a zero.
 */
function usagePresentation(chat: ChatState, working: boolean): UsagePresentation {
  const snapshot = chat.usage;
  const context = snapshot?.context ?? null;
  const session = snapshot?.session ?? null;
  const lastTurn = snapshot?.lastTurn ?? null;

  const lines: string[] = [];
  let percent: number | undefined;
  let caption: string | null = null;
  let value: string | null = null;

  if (context) {
    percent = Math.round((context.used / context.size) * 100);
    caption = "Kontext";
    value = `${percent} %`;
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
    // The context percentage wins the pill when both are known: it answers the
    // question a running session actually raises.
    if (caption === null) {
      caption = "Token";
      value = session.tokens.total === null
        ? "–"
        : `${atLeast}${exactNumber(session.tokens.total)}`;
    }

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

  if (value === null) {
    return {
      caption: null,
      value: null,
      placeholder: "Token: –",
      title: ["Gemini hat für diese Session noch keine Nutzung gemeldet.", ...lines.slice(1)].join("\n"),
    };
  }

  return {
    caption,
    value,
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
  onSetMode,
  onSetModel,
}: ChatHeaderProps) {
  const menuRef = useDismissOnOutsideClick<HTMLDetailsElement>();
  // Two sources, both incomplete on their own: the cached lists carry display
  // names and are there from app start, the live event carries only IDs but is
  // the fresher one once a session runs. The current selection is appended so
  // it can never be missing from its own picker.
  const modes = mergeOptions(session.availableModes, chat.modes, session.mode, optionLabel);
  const models = mergeOptions(session.availableModels, chat.models, session.model, (id) => id);
  const working = ["running", "awaiting_permission", "cancelling"].includes(chat.phase);
  const usage = usagePresentation(chat, working);
  // The button carries the two facts the popover would otherwise hide. Both can
  // be unknown, and an empty button would be worse than an honest fallback.
  const summaryLabel = [
    models.find((model) => model.id === session.model)?.name ?? session.model,
    modes.find((mode) => mode.id === session.mode)?.name ?? session.mode,
  ].filter(Boolean).join(" · ") || "Session";

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
            <span className="usage-metric">
              {usage.caption && <span>{usage.caption}</span>}
              <strong>{usage.value}</strong>
            </span>
          )}
        </span>

        {/* Model, mode and the project roots describe how this session runs.
            They are read far more often than they are changed, so the button
            states them and the popover is where they are edited. */}
        <details ref={menuRef} className="session-settings-menu">
          <summary title="Sessioneinstellungen">
            <Icon name="settings" size={15} />
            <span>{summaryLabel}</span>
            <Icon name="chevron-down" size={13} />
          </summary>
          <div className="session-settings-popover">
            <div className="session-settings-row">
              <span className="session-settings-label">Modell</span>
              {modelsSupported && models.length > 1 ? (
                <label className="model-select">
                  <span className="sr-only">Gemini-Modell</span>
                  <select
                    value={session.model ?? ""}
                    onChange={(event) => onSetModel(event.target.value)}
                    disabled={working}
                    aria-label="Gemini-Modell"
                  >
                    {!session.model && <option value="" disabled>Modell wählen</option>}
                    {models.map((model) => (
                      <option key={model.id} value={model.id} title={model.description}>{model.name}</option>
                    ))}
                  </select>
                  <Icon name="chevron-down" size={13} />
                </label>
              ) : (
                /* One entry means the merge only recovered the current model — a
                   dropdown that cannot change anything would promise a choice
                   that does not exist, so the value is stated instead. */
                <span
                  className="model-pill"
                  title={modelsSupported
                    ? "Gemini hat noch keine auswählbaren Modelle gemeldet."
                    : "Diese Gemini-ACP-Anbindung stellt keinen Modellwechsel bereit."
                  }
                >
                  <strong>{session.model ?? NOT_REPORTED}</strong>
                </span>
              )}
            </div>

            <div className="session-settings-row">
              <span className="session-settings-label">Modus</span>
              {modes.length ? (
                <label className="mode-select">
                  <span className="sr-only">Gemini-Modus</span>
                  <select
                    value={session.mode ?? modes[0]?.id ?? ""}
                    onChange={(event) => onSetMode(event.target.value)}
                    disabled={working}
                  >
                    {modes.map((mode) => (
                      <option key={mode.id} value={mode.id} title={mode.description}>{mode.name}</option>
                    ))}
                  </select>
                  <Icon name="chevron-down" size={13} />
                </label>
              ) : (
                <span className="model-pill"><strong>{session.mode ?? NOT_REPORTED}</strong></span>
              )}
            </div>

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
      </div>
    </header>
  );
}
