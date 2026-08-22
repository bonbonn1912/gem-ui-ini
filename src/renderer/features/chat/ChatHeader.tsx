import { useMemo, useRef, useState } from "react";
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
  if (id.toLowerCase() === "yolo") return "Developer";
  return id.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatModeName(id: string, name?: string): string {
  if (id.toLowerCase() === "yolo" || name?.toLowerCase() === "yolo") {
    return "Developer";
  }
  return name || optionLabel(id);
}

function getModeExplanation(id: string, description?: string): string {
  if (description) return description;
  switch (id.toLowerCase()) {
    case "yolo":
    case "developer":
      return "Führt Aktionen und Befehle direkt ohne manuelle Freigabeabfragen aus.";
    case "plan":
      return "Erstellt strukturierte Pläne zur Aufgabenanalyse vor der Umsetzung.";
    case "ask":
      return "Reiner Frage- und Diskussionsmodus ohne Dateiänderungen oder Werkzeuge.";
    case "auto_edit":
      return "Automatisiertes Bearbeiten und Anpassen von Dateien im Workspace.";
    case "default":
    case "auto":
      return "Standardmodus mit Sicherheitsabfragen für sensible Werkzeuge und Dateiänderungen.";
    default:
      return "Modus-spezifisches Verhalten für die Interaktion mit Gemini.";
  }
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

const FALLBACK_MODELS: readonly SessionMode[] = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" },
  { id: "auto", name: "Auto" },
];

const FALLBACK_MODES: readonly SessionMode[] = [
  { id: "auto", name: "Auto" },
  { id: "plan", name: "Plan" },
  { id: "ask", name: "Ask" },
];

function TokenUsageDetails({
  chat,
  working,
  usage,
  activeModel,
}: {
  chat: ChatState;
  working: boolean;
  usage: UsagePresentation;
  activeModel: string | null;
}) {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setOpen(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = window.setTimeout(() => {
      setOpen(false);
    }, 200);
  };

  const snapshot = chat.usage;
  const sessionTokens = snapshot?.session?.tokens;
  const lastTurnTokens = snapshot?.lastTurn?.tokens;
  const context = snapshot?.context;

  const inTokens = sessionTokens?.input ?? lastTurnTokens?.input ?? null;
  const outTokens = sessionTokens?.output ?? lastTurnTokens?.output ?? null;
  const cachedTokens = sessionTokens?.cachedRead ?? sessionTokens?.cachedWrite ?? lastTurnTokens?.cachedRead ?? null;
  const totalTokens = sessionTokens?.total ?? lastTurnTokens?.total ?? null;

  const byModel = snapshot?.session?.byModel && snapshot.session.byModel.length > 0
    ? snapshot.session.byModel
    : snapshot?.lastTurn?.byModel && snapshot.lastTurn.byModel.length > 0
      ? snapshot.lastTurn.byModel
      : (activeModel && (inTokens !== null || outTokens !== null)
          ? [{
              model: activeModel,
              input: inTokens ?? 0,
              output: outTokens ?? 0,
            }]
          : []);

  return (
    <div
      className="token-usage-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className="usage-pill"
        role="button"
        tabIndex={0}
        title={usage.title}
        onClick={() => setOpen((prev: boolean) => !prev)}
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
      </div>

      {open && (
        <div className="token-details-popover" role="dialog" aria-label="Token-Nutzung Details">
          <header className="token-details-header">
            <div className="token-details-title">
              <Icon name="sparkle" size={14} />
              <strong>Token-Nutzung</strong>
            </div>
            <span className={`token-details-status-badge ${working ? "token-details-status-badge--working" : ""}`}>
              {working ? "Turn läuft …" : "Session"}
            </span>
          </header>

          <div className="token-details-grid">
            <div className="token-metric-card">
              <span className="token-metric-label">Input</span>
              <strong className="token-metric-value">{inTokens !== null ? exactNumber(inTokens) : "–"}</strong>
              <small className="token-metric-sub">Eingabe</small>
            </div>
            <div className="token-metric-card">
              <span className="token-metric-label">Output</span>
              <strong className="token-metric-value">{outTokens !== null ? exactNumber(outTokens) : "–"}</strong>
              <small className="token-metric-sub">Ausgabe</small>
            </div>
            <div className="token-metric-card">
              <span className="token-metric-label">Cached</span>
              <strong className="token-metric-value">{cachedTokens !== null ? exactNumber(cachedTokens) : "0"}</strong>
              <small className="token-metric-sub">Cache</small>
            </div>
          </div>

          <div className="token-details-total-row">
            <span>Gesamtverbrauch:</span>
            <strong>{totalTokens !== null ? `${exactNumber(totalTokens)} Token` : "–"}</strong>
          </div>

          {byModel.length > 0 && (
            <div className="token-details-by-model">
              <div className="token-by-model-title">
                <Icon name="sparkle" size={12} />
                <span>Nutzung nach Modell</span>
              </div>
              <div className="token-by-model-list">
                {byModel.map((item) => (
                  <div key={item.model} className="token-by-model-row">
                    <div className="token-by-model-header">
                      <span className="token-by-model-name">{item.model}</span>
                      <strong className="token-by-model-total">
                        {exactNumber(item.input + item.output)} Token
                      </strong>
                    </div>
                    <div className="token-by-model-metrics">
                      <span>In: <strong>{exactNumber(item.input)}</strong></span>
                      <span className="token-by-model-divider">·</span>
                      <span>Out: <strong>{exactNumber(item.output)}</strong></span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {context && (
            <div className="token-details-context-box">
              <div className="token-details-context-header">
                <span>Kontextfenster-Belegung</span>
                <strong>{Math.round((context.used / context.size) * 100)} %</strong>
              </div>
              <div className="token-context-bar-track">
                <div
                  className="token-context-bar-fill"
                  style={{ width: `${Math.min(100, (context.used / context.size) * 100)}%` }}
                />
              </div>
              <div className="token-details-context-numbers">
                <span>{exactNumber(context.used)} belegt</span>
                <span>{exactNumber(context.size)} max</span>
              </div>
            </div>
          )}

          {snapshot?.lastTurn && (
            <div className="token-details-last-turn">
              <div className="token-last-turn-title">Letzter Turn:</div>
              <div className="token-last-turn-stats">
                <span>In: <strong>{lastTurnTokens?.input !== null && lastTurnTokens?.input !== undefined ? exactNumber(lastTurnTokens.input) : "–"}</strong></span>
                <span>Out: <strong>{lastTurnTokens?.output !== null && lastTurnTokens?.output !== undefined ? exactNumber(lastTurnTokens.output) : "–"}</strong></span>
                <span>Cache: <strong>{lastTurnTokens?.cachedRead !== null && lastTurnTokens?.cachedRead !== undefined ? exactNumber(lastTurnTokens.cachedRead) : "–"}</strong></span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProviderSessionHistoryButton({
  session,
  chat,
}: {
  session: AppSession;
  chat: ChatState;
}) {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setOpen(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = window.setTimeout(() => {
      setOpen(false);
    }, 200);
  };

  const historyEntries = useMemo(() => {
    if (chat.providerSessions && chat.providerSessions.length > 0) {
      return chat.providerSessions;
    }
    if (session.providerSessionId) {
      return [
        {
          providerSessionId: session.providerSessionId,
          startedAt: session.createdAt,
          transferredContext: false,
        },
      ];
    }
    return [
      {
        providerSessionId: session.id,
        startedAt: session.createdAt,
        transferredContext: false,
      },
    ];
  }, [chat.providerSessions, session.providerSessionId, session.createdAt, session.id]);

  return (
    <div
      className="session-history-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className="icon-button session-history-trigger"
        title="Gemini-Sitzungsverlauf (Session-IDs & Kontext)"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Gemini-Sitzungsverlauf anzeigen"
      >
        <Icon name="clock" size={15} />
        {historyEntries.length > 1 && (
          <span className="session-history-counter">{historyEntries.length}</span>
        )}
      </button>

      {open && (
        <div className="session-history-popover" role="dialog" aria-label="Gemini-Sitzungshistorie">
          <header className="session-history-header">
            <div className="session-history-title">
              <Icon name="clock" size={14} />
              <strong>Gemini-Sitzungsverlauf</strong>
            </div>
            <span className="session-history-count-badge">
              {historyEntries.length} {historyEntries.length === 1 ? "Sitzung" : "Sitzungen"}
            </span>
          </header>

          <p className="session-history-desc">
            Übersicht aller Gemini-Prozessinstanzen dieser GeminUI-Session.
          </p>

          <div className="session-history-list">
            {historyEntries.map((entry, index) => {
              const isLatest = index === historyEntries.length - 1;
              const dateStr = new Date(entry.startedAt).toLocaleString("de-DE", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });

              return (
                <div
                  key={`${entry.providerSessionId}-${index}`}
                  className={`session-history-item ${isLatest ? "session-history-item--active" : ""}`}
                >
                  <div className="session-history-item-top">
                    <div className="session-history-item-id">
                      <span className="session-history-num">#{index + 1}</span>
                      <code title={entry.providerSessionId}>
                        {entry.providerSessionId.length > 28
                          ? `${entry.providerSessionId.slice(0, 12)}…${entry.providerSessionId.slice(-10)}`
                          : entry.providerSessionId}
                      </code>
                    </div>
                    {isLatest && <span className="session-history-active-pill">Aktiv</span>}
                  </div>

                  <div className="session-history-item-bottom">
                    <span className="session-history-time">Gestartet: {dateStr}</span>
                    {entry.transferredContext && (
                      <span
                        className="session-history-badge session-history-badge--context"
                        title="Mit übergebenem Kontext (komprimiert)"
                      >
                        <Icon name="brain" size={13} />
                        <span>Kontext übergeben</span>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
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
  let modes = mergeOptions(session.availableModes, chat.modes, session.mode, optionLabel);
  if (modes.length <= 1) {
    modes = mergeOptions([...modes, ...FALLBACK_MODES], [], session.mode, optionLabel);
  }

  let models = mergeOptions(session.availableModels, chat.models, session.model, (id) => id);
  if (models.length <= 1) {
    models = mergeOptions([...models, ...FALLBACK_MODELS], [], session.model, (id) => id);
  }

  const working = ["running", "awaiting_permission", "cancelling"].includes(chat.phase);
  const usage = usagePresentation(chat, working);
  const activeModeObj = modes.find((mode) => mode.id === session.mode);
  const activeModeName = activeModeObj
    ? formatModeName(activeModeObj.id, activeModeObj.name)
    : (session.mode ? formatModeName(session.mode) : null);
  const summaryLabel = [
    models.find((model) => model.id === session.model)?.name ?? session.model,
    activeModeName,
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
        <ProviderSessionHistoryButton
          session={session}
          chat={chat}
        />
        <TokenUsageDetails
          chat={chat}
          working={working}
          usage={usage}
          activeModel={session.model ?? models[0]?.id ?? null}
        />

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
              {modelsSupported ? (
                <label className="model-select">
                  <span className="sr-only">Gemini-Modell</span>
                  <select
                    value={session.model ?? models[0]?.id ?? ""}
                    onChange={(event) => onSetModel(event.target.value)}
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
                <span
                  className="model-pill"
                  title="Diese Gemini-ACP-Anbindung stellt keinen Modellwechsel bereit."
                >
                  <strong>{session.model ?? NOT_REPORTED}</strong>
                </span>
              )}
            </div>

            <div className="session-settings-row">
              <div className="session-settings-label-with-info">
                <span className="session-settings-label">Modus</span>
                <span
                  className="mode-info-trigger"
                  tabIndex={0}
                  role="button"
                  aria-label="Informationen zu den verfügbaren Modi"
                >
                  <Icon name="info" size={13} />
                  <span className="mode-info-tooltip" role="tooltip">
                    <strong className="mode-info-tooltip-title">Gemini-Modi Übersicht</strong>
                    <span className="mode-info-list">
                      {modes.map((mode) => (
                        <span key={mode.id} className="mode-info-item">
                          <strong className="mode-info-name">{formatModeName(mode.id, mode.name)}</strong>
                          <span className="mode-info-desc">{getModeExplanation(mode.id, mode.description)}</span>
                        </span>
                      ))}
                    </span>
                  </span>
                </span>
              </div>
              <label className="mode-select">
                <span className="sr-only">Gemini-Modus</span>
                <select
                  value={session.mode ?? modes[0]?.id ?? ""}
                  onChange={(event) => onSetMode(event.target.value)}
                  aria-label="Gemini-Modus"
                >
                  {modes.map((mode) => (
                    <option key={mode.id} value={mode.id} title={mode.description}>
                      {formatModeName(mode.id, mode.name)}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" size={13} />
              </label>
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
