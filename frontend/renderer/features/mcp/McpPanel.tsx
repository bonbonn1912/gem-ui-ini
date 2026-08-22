import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { Icon } from "../../components/Icon";
import type { McpServer, McpServerList, McpTransport } from "../../types";

type McpPanelProps = {
  projectId: string | null;
  onClose: () => void;
};

const SEARCH_THRESHOLD = 8;

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: "stdio",
  http: "HTTP",
  sse: "SSE",
  unknown: "unbekannt",
};

function scopeLabel(server: McpServer): string {
  switch (server.scope) {
    case "project":
      return server.scopeLabel ? `Projekt · ${server.scopeLabel}` : "Projekt";
    case "builtin":
      return "Integriert";
    case "system":
      return "System";
    default:
      return "Nutzer";
  }
}

/** The one line that says how this server is actually reached. */
function endpointOf(server: McpServer): string {
  if (server.url) return server.url;
  if (server.command) return [server.command, ...server.args].join(" ");
  return "Kein Kommando und keine URL hinterlegt";
}

function messageFrom(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Die MCP-Server konnten nicht gelesen werden.";
}

export function McpPanel({ projectId, onClose }: McpPanelProps) {
  const [list, setList] = createSignal<McpServerList | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal("");
  const [reloadToken, setReloadToken] = createSignal(0);

  createEffect(() => {
    let current = true;
    setLoading(true);
    window.gemUi.agentExtensions
      .listMcpServers({ projectId })
      .then((next) => {
        if (!current) return;
        setList(next);
        setError(null);
      })
      .catch((cause) => {
        if (!current) return;
        setList(null);
        setError(messageFrom(cause));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    onCleanup(() => {
      current = false;
    });
  });

  const refresh = () => setReloadToken((token) => token + 1);

  const servers = list()?.servers ?? [];
  const filtered = createMemo(() => {
    const needle = query().trim().toLocaleLowerCase("de");
    if (!needle) return servers;
    return servers.filter((server) =>
      `${server.name} ${server.description ?? ""} ${endpointOf(server)}`
        .toLocaleLowerCase("de")
        .includes(needle),
    );
  });

  const subtitle = loading() && !list()
    ? "Konfiguration wird gelesen …"
    : servers.length === 1
      ? "1 Server"
      : `${servers.length} Server`;

  return (
    <aside class="extension-panel mcp-panel" aria-label="MCP-Server">
      <header class="extension-panel-header mcp-panel-header" data-tauri-drag-region>
        <div>
          <span class="extension-panel-icon mcp-panel-icon">
            <Icon name="server" size={17} />
          </span>
          <div>
            <strong>MCP</strong>
            <span>{subtitle}</span>
          </div>
        </div>
        <button
          class="icon-button"
          type="button"
          onClick={refresh}
          disabled={loading()}
          title="MCP-Server aktualisieren"
          aria-label="MCP-Server aktualisieren"
        >
          {loading() ? <span class="mini-spinner" /> : <Icon name="refresh" size={16} />}
        </button>
        <button
          class="icon-button"
          type="button"
          onClick={onClose}
          title="Panel schließen"
          aria-label="MCP schließen"
        >
          <Icon name="x" size={16} />
        </button>
      </header>

      <div class="extension-panel-body">
        {servers.length > SEARCH_THRESHOLD && (
          <div class="extension-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={query()}
              placeholder="MCP-Server durchsuchen"
              aria-label="MCP-Server durchsuchen"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}

        <div class="extension-panel-scroll">
          {error() && (
            <div class="extension-error" role="alert">
              <Icon name="warning" size={17} />
              <p>
                <strong>MCP-Server konnten nicht gelesen werden</strong>
                <span>{error()}</span>
              </p>
              <button type="button" onClick={refresh}>Erneut</button>
            </div>
          )}

          {loading() && !list() && (
            <div class="extension-loading">
              <span class="mini-spinner" /> Konfiguration wird gelesen …
            </div>
          )}

          {list() && servers.length === 0 && !error() && (
            <div class="extension-empty">
              <span><Icon name="server" size={20} /></span>
              <strong>Keine MCP-Server konfiguriert</strong>
              <p>
                Gemini CLI liest MCP-Server aus dem Schlüssel <code>mcpServers</code>
                in <code>~/.gemini/settings.json</code> und in
                <code>.gemini/settings.json</code> der Projektordner. Trage dort
                einen Server ein, damit er hier erscheint.
              </p>
            </div>
          )}

          {list() && servers.length > 0 && filtered.length === 0 && (
            <div class="extension-empty">
              <span><Icon name="search" size={20} /></span>
              <strong>Kein Treffer</strong>
              <p>Für „{query().trim()}“ wurde kein MCP-Server gefunden.</p>
            </div>
          )}

          {filtered().map((server) => (
            <article
              class={`extension-row ${server.enabled ? "" : "extension-row--off"}`}

            >
              <header>
                <strong title={server.name}>{server.name}</strong>
                <span class={`extension-badge extension-badge--transport-${server.transport}`}>
                  {TRANSPORT_LABELS[server.transport]}
                </span>
                <span class={`extension-badge extension-badge--${server.scope}`}>
                  {scopeLabel(server)}
                </span>
                {!server.enabled && (
                  <span class="extension-badge extension-badge--off">Deaktiviert</span>
                )}
                {server.trusted && (
                  <span class="extension-badge extension-badge--trusted">Vertraut</span>
                )}
              </header>
              {server.description && <p>{server.description}</p>}
              <code title={endpointOf(server)}>{endpointOf(server)}</code>
              {(server.envKeys.length > 0 || server.headerKeys.length > 0) && (
                <div class="extension-keys">
                  {server.envKeys.map((key) => (
                    <span  title="Umgebungsvariable (Wert bleibt im Hauptprozess)">
                      {key}
                    </span>
                  ))}
                  {server.headerKeys.map((key) => (
                    <span  title="HTTP-Header (Wert bleibt im Hauptprozess)">
                      {key}
                    </span>
                  ))}
                </div>
              )}
              <small title={server.configPath}>{server.configPath}</small>
            </article>
          ))}
        </div>

        {list() && list().truncated && (
          <p class="extension-footnote">
            Es wurden nicht alle gefundenen MCP-Server übernommen.
          </p>
        )}
      </div>
    </aside>
  );
}
