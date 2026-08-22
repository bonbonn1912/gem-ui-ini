import { createMemo, createSignal } from "solid-js";
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

function TokenUsageDetails(props: {
  chat: ChatState;
  working: boolean;
  usage: UsagePresentation;
}) {
  const [open, setOpen] = createSignal(false);
  let timeoutRef: number | null = null;

  const handleMouseEnter = () => {
    if (timeoutRef) {
      window.clearTimeout(timeoutRef);
      timeoutRef = null;
    }
    setOpen(true);
  };

  const handleMouseLeave = () => {
    timeoutRef = window.setTimeout(() => {
      setOpen(false);
    }, 200);
  };

  const snapshot = createMemo(() => props.chat.usage);
  const sessionTokens = createMemo(() => snapshot()?.session?.tokens);
  const lastTurnTokens = createMemo(() => snapshot()?.lastTurn?.tokens);
  const context = createMemo(() => snapshot()?.context);

  const inTokens = createMemo(() => sessionTokens()?.input ?? lastTurnTokens()?.input ?? null);
  const outTokens = createMemo(() => sessionTokens()?.output ?? lastTurnTokens()?.output ?? null);
  const cachedTokens = createMemo(() => sessionTokens()?.cachedRead ?? sessionTokens()?.cachedWrite ?? lastTurnTokens()?.cachedRead ?? null);
  const totalTokens = createMemo(() => sessionTokens()?.total ?? lastTurnTokens()?.total ?? null);

  return (
    <div
      class="token-usage-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        class="usage-pill"
        role="button"
        tabIndex={0}
        title={props.usage.title}
        onClick={() => setOpen((prev: boolean) => !prev)}
        aria-label={props.usage.title.replaceAll("\n", ". ")}
      >
        {props.usage.percent !== undefined && (
          <i aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, props.usage.percent))}%` }} /></i>
        )}
        {props.usage.placeholder !== null ? (
          <span>{props.usage.placeholder}</span>
        ) : (
          <span class="usage-metric">
            {props.usage.caption && <span>{props.usage.caption}</span>}
            <strong>{props.usage.value}</strong>
          </span>
        )}
      </div>

      {open() && (
        <div class="token-details-popover" role="dialog" aria-label="Token-Nutzung Details">
          <header class="token-details-header">
            <div class="token-details-title">
              <Icon name="sparkle" size={14} />
              <strong>Token-Nutzung</strong>
            </div>
            <span class={`token-details-status-badge ${props.working ? "token-details-status-badge--working" : ""}`}>
              {props.working ? "Turn läuft …" : "Session"}
            </span>
          </header>

          <div class="token-details-grid">
            <div class="token-metric-card">
              <span class="token-metric-label">Input</span>
              <strong class="token-metric-value">{inTokens() !== null ? exactNumber(inTokens()) : "–"}</strong>
              <small class="token-metric-sub">Eingabe</small>
            </div>
            <div class="token-metric-card">
              <span class="token-metric-label">Output</span>
              <strong class="token-metric-value">{outTokens() !== null ? exactNumber(outTokens()) : "–"}</strong>
              <small class="token-metric-sub">Ausgabe</small>
            </div>
            <div class="token-metric-card">
              <span class="token-metric-label">Cached</span>
              <strong class="token-metric-value">{cachedTokens() !== null ? exactNumber(cachedTokens()) : "0"}</strong>
              <small class="token-metric-sub">Cache</small>
            </div>
          </div>

          <div class="token-details-total-row">
            <span>Gesamtverbrauch:</span>
            <strong>{totalTokens() !== null ? `${exactNumber(totalTokens())} Token` : "–"}</strong>
          </div>

          {context() && (
            <div class="token-details-context-box">
              <div class="token-details-context-header">
                <span>Kontextfenster-Belegung</span>
                <strong>{Math.round((context()!.used / context()!.size) * 100)} %</strong>
              </div>
              <div class="token-context-bar-track">
                <div
                  class="token-context-bar-fill"
                  style={{ width: `${Math.min(100, (context()!.used / context()!.size) * 100)}%` }}
                />
              </div>
              <div class="token-details-context-numbers">
                <span>{exactNumber(context()!.used)} belegt</span>
                <span>{exactNumber(context()!.size)} max</span>
              </div>
            </div>
          )}

          {snapshot()?.lastTurn && (
            <div class="token-details-last-turn">
              <div class="token-last-turn-title">Letzter Turn:</div>
              <div class="token-last-turn-stats">
                <span>In: <strong>{lastTurnTokens()?.input !== null && lastTurnTokens()?.input !== undefined ? exactNumber(lastTurnTokens()!.input) : "–"}</strong></span>
                <span>Out: <strong>{lastTurnTokens()?.output !== null && lastTurnTokens()?.output !== undefined ? exactNumber(lastTurnTokens()!.output) : "–"}</strong></span>
                <span>Cache: <strong>{lastTurnTokens()?.cachedRead !== null && lastTurnTokens()?.cachedRead !== undefined ? exactNumber(lastTurnTokens()!.cachedRead) : "–"}</strong></span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatHeader(props: ChatHeaderProps) {
  const menuRef = useDismissOnOutsideClick<HTMLDetailsElement>();
  const modes = createMemo(() => {
    const available = mergeOptions(props.session.availableModes, props.chat.modes, props.session.mode, optionLabel);
    return available.length <= 1 ? mergeOptions([...available, ...FALLBACK_MODES], [], props.session.mode, optionLabel) : available;
  });
  const models = createMemo(() => {
    const available = mergeOptions(props.session.availableModels, props.chat.models, props.session.model, (id) => id);
    return available.length <= 1 ? mergeOptions([...available, ...FALLBACK_MODELS], [], props.session.model, (id) => id) : available;
  });
  const working = createMemo(() => ["running", "awaiting_permission", "cancelling"].includes(props.chat.phase));
  const usage = createMemo(() => usagePresentation(props.chat, working()));
  const summaryLabel = createMemo(() => [
    models().find((model) => model.id === props.session.model)?.name ?? props.session.model,
    modes().find((mode) => mode.id === props.session.mode)?.name ?? props.session.mode,
  ].filter(Boolean).join(" · ") || "Session");

  return (
    <header class="chat-header" data-tauri-drag-region>
      <button type="button" class="icon-button mobile-menu-button" onClick={props.onOpenSidebar} aria-label="Seitenleiste öffnen">
        <Icon name="menu" size={19} />
      </button>
      <div class="chat-heading">
        <h1>{props.session.title}</h1>
        <div class="chat-subtitle">
          <span>{props.project.name}</span>
          <span class="subtitle-separator">/</span>
          <span class={`live-state live-state--${working() ? "working" : props.chat.phase}`}>
            <i />{stateLabel(props.session, props.chat)}
          </span>
        </div>
      </div>

      <div class="header-actions">
        <TokenUsageDetails chat={props.chat} working={working()} usage={usage()} />

        {/* Model, mode and the project roots describe how this session runs.
            They are read far more often than they are changed, so the button
            states them and the popover is where they are edited. */}
        <details ref={menuRef} class="session-settings-menu">
          <summary title="Sessioneinstellungen">
            <Icon name="settings" size={15} />
            <span>{summaryLabel()}</span>
            <Icon name="chevron-down" size={13} />
          </summary>
          <div class="session-settings-popover">
            <div class="session-settings-row">
              <span class="session-settings-label">Modell</span>
              {props.modelsSupported ? (
                <label class="model-select">
                  <span class="sr-only">Gemini-Modell</span>
                  <select
                    onChange={(event) => props.onSetModel(event.target.value)}
                    aria-label="Gemini-Modell"
                  >
                    {!props.session.model && <option value="" disabled>Modell wählen</option>}
                    {models().map((model) => (
                      <option
                        value={model.id}
                        title={model.description}
                        selected={model.id === (props.session.model ?? models()[0]?.id)}
                      >
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <Icon name="chevron-down" size={13} />
                </label>
              ) : (
                <span
                  class="model-pill"
                  title="Diese Gemini-ACP-Anbindung stellt keinen Modellwechsel bereit."
                >
                  <strong>{props.session.model ?? NOT_REPORTED}</strong>
                </span>
              )}
            </div>

            <div class="session-settings-row">
              <span class="session-settings-label">Modus</span>
              <label class="mode-select">
                <span class="sr-only">Gemini-Modus</span>
                <select
                  value={props.session.mode ?? modes()[0]?.id ?? ""}
                  onChange={(event) => props.onSetMode(event.target.value)}
                  aria-label="Gemini-Modus"
                >
                  {modes().map((mode) => (
                    <option value={mode.id} title={mode.description}>{mode.name}</option>
                  ))}
                </select>
                <Icon name="chevron-down" size={13} />
              </label>
            </div>

            <div class="roots-popover-heading">
              <div><strong>Projektordner</strong><span>Gemini-Kontext dieser Session</span></div>
              <span class="revision-badge">r{props.project.rootRevision}</span>
            </div>
            <div class="roots-popover-list">
              {props.project.roots.map((root) => (
                <div class="root-popover-item" >
                  <span class="root-kind-icon"><Icon name="folder" size={16} /></span>
                  <div><strong>{rootName(root.path, root.label)}</strong><span>{root.path}</span></div>
                  {root.kind === "primary" && <span class="primary-badge">Primär</span>}
                </div>
              ))}
            </div>
            <p><Icon name="shield" size={14} /> Änderungen bleiben Geminis Freigaberegeln unterworfen.</p>
            <button class="roots-edit-button" type="button" onClick={props.onEditProject}>
              <Icon name="settings" size={14} /> Projektordner bearbeiten
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
