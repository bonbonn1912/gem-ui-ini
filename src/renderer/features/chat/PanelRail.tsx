import { Icon, type IconName } from "../../components/Icon";

/**
 * The right-hand panels used to sit as six labelled buttons in the chat header,
 * which grew unreadable as panels were added. They live in a rail instead: one
 * fixed column at the edge of the workspace where a new panel costs one icon
 * rather than another word in an already full line.
 */
export type PanelRailItem = {
  id: string;
  icon: IconName;
  /** Shown in the tooltip. */
  label: string;
  /**
   * The name used in the accessible label, which is not always the visible one:
   * the tooltip says "GitLab" where the screen reader says "GitLab Review".
   */
  name?: string;
  /** Extra detail for the accessible label, e.g. "2 Anhänge, 1 im Kontext". */
  detail?: string;
  badge?: number;
  /** A count worth showing even when the panel is closed, e.g. included attachments. */
  subBadge?: number;
};

type PanelRailProps = {
  items: PanelRailItem[];
  activeId: string;
  theme?: "light" | "dark";
  statsOpen?: boolean;
  logsOpen?: boolean;
  debugMode?: boolean;
  errorCount?: number;
  onToggle: (id: string) => void;
  onToggleTheme?: () => void;
  onToggleStats?: () => void;
  onToggleLogs?: () => void;
  resourceProfile?: "economy" | "balanced" | "performance";
  onResourceProfileChange?: (profile: "economy" | "balanced" | "performance") => void;
};

function cap(value: number, limit: number): string {
  return value > limit ? `${limit}+` : String(value);
}

export function PanelRail({
  items,
  activeId,
  theme = "light",
  statsOpen = false,
  logsOpen = false,
  debugMode = false,
  errorCount = 0,
  onToggle,
  onToggleTheme,
  onToggleStats,
  onToggleLogs,
  resourceProfile,
  onResourceProfileChange,
}: PanelRailProps) {
  return (
    <nav className="panel-rail" aria-label="Panels">
      <div className="panel-rail-items">
        {items.map((item) => {
          const open = !statsOpen && !logsOpen && activeId === item.id;
          const name = item.name ?? item.label;
          return (
            <button
              key={item.id}
              className={`panel-rail-button ${open ? "panel-rail-button--active" : ""}`}
              type="button"
              aria-pressed={open}
              aria-label={`${name} ${open ? "schließen" : "öffnen"}${item.detail ? `, ${item.detail}` : ""}`}
              title={item.label}
              onClick={() => onToggle(item.id)}
            >
              <Icon name={item.icon} size={18} />
              <span className="panel-rail-label" aria-hidden="true">{item.label}</span>
              {Boolean(item.badge) && <i>{cap(item.badge!, 99)}</i>}
              {Boolean(item.subBadge) && <em>{cap(item.subBadge!, 99)}</em>}
            </button>
          );
        })}
      </div>

      <div className="panel-rail-bottom">
        {resourceProfile && onResourceProfileChange && (
          <label className="resource-profile-control" title="Ressourcenprofil">
            <Icon name="settings" size={17} />
            <select aria-label="Ressourcenprofil" value={resourceProfile} onChange={(event) => onResourceProfileChange(event.target.value as "economy" | "balanced" | "performance")}>
              <option value="economy">Sparmodus</option>
              <option value="balanced">Ausgewogen</option>
              <option value="performance">Leistung</option>
            </select>
          </label>
        )}
        {onToggleStats && (
          <button
            className={`panel-rail-button panel-rail-stats-toggle ${statsOpen ? "panel-rail-button--active" : ""}`}
            type="button"
            aria-pressed={statsOpen}
            aria-label={statsOpen ? "Statistiken schließen" : "Statistiken öffnen"}
            title="App-Statistiken"
            onClick={onToggleStats}
          >
            <Icon name="chart" size={18} />
            <span className="panel-rail-label" aria-hidden="true">
              Stats
            </span>
          </button>
        )}

        {debugMode && onToggleLogs && (
          <button
            className={`panel-rail-button panel-rail-logs-toggle ${logsOpen ? "panel-rail-button--active" : ""}`}
            type="button"
            aria-pressed={logsOpen}
            aria-label={logsOpen ? "Debug-Logs schließen" : "Debug-Logs öffnen"}
            title="Debug-Logs"
            onClick={onToggleLogs}
          >
            <Icon name="terminal" size={18} />
            <span className="panel-rail-label" aria-hidden="true">
              Logs
            </span>
          </button>
        )}

        {onToggleTheme && (
          <button
            className="panel-rail-button panel-rail-theme-toggle"
            type="button"
            aria-label={theme === "dark" ? "Hellen Modus aktivieren" : "Dunklen Modus aktivieren"}
            title={theme === "dark" ? "Hellen Modus aktivieren" : "Dunklen Modus aktivieren"}
            onClick={onToggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
            <span className="panel-rail-label" aria-hidden="true">
              {theme === "dark" ? "Hell" : "Dunkel"}
            </span>
          </button>
        )}
      </div>
    </nav>
  );
}
