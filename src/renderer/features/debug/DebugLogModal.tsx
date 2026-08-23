import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { debugLogger, type DebugLogEntry, type DebugLogLevel } from "./debug-logger";

interface DebugLogModalProps {
  open: boolean;
  onClose: () => void;
}

export function DebugLogModal({ open, onClose }: DebugLogModalProps) {
  const [logs, setLogs] = useState<DebugLogEntry[]>(() => debugLogger.getLogs());
  const [levelFilter, setLevelFilter] = useState<DebugLogLevel | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return debugLogger.subscribe((nextLogs) => {
      setLogs(nextLogs);
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return logs.filter((log) => {
      if (levelFilter !== "all" && log.level !== levelFilter) return false;
      if (!q) return true;
      const msgMatch = log.message.toLowerCase().includes(q);
      const srcMatch = log.source.toLowerCase().includes(q);
      const detailsMatch =
        log.details && JSON.stringify(log.details).toLowerCase().includes(q);
      return msgMatch || srcMatch || detailsMatch;
    });
  }, [logs, levelFilter, searchQuery]);

  useEffect(() => {
    if (autoScroll && scrollRef.current && open) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredLogs, autoScroll, open]);

  if (!open) return null;

  const errorCount = logs.filter((l) => l.level === "error").length;
  const warnCount = logs.filter((l) => l.level === "warn").length;
  const streamCount = logs.filter((l) => l.level === "stream").length;
  const ipcCount = logs.filter((l) => l.level === "ipc").length;
  const infoCount = logs.filter((l) => l.level === "info").length;

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCopyAll = () => {
    const text = filteredLogs
      .map(
        (l) =>
          `[${l.timestamp.toISOString()}] [${l.level.toUpperCase()}] [${l.source}]: ${l.message}${
            l.details ? "\n" + JSON.stringify(l.details, null, 2) : ""
          }`,
      )
      .join("\n\n");
    navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1800);
  };

  const handleCopyEntry = (entry: DebugLogEntry) => {
    const text = `[${entry.timestamp.toISOString()}] [${entry.level.toUpperCase()}] [${entry.source}]: ${entry.message}${
      entry.details ? "\n" + JSON.stringify(entry.details, null, 2) : ""
    }`;
    navigator.clipboard.writeText(text);
    setCopiedId(entry.id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleClear = () => {
    debugLogger.clear();
    setExpandedIds(new Set());
  };

  return (
    <div
      className="modal-layer debug-modal-layer"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="debug-log-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="debug-log-title"
      >
        {/* macOS Style Window Header */}
        <header className="debug-log-header">
          <div className="debug-log-header-left">
            <div className="debug-log-header-icon">
              <Icon name="terminal" size={17} />
            </div>
            <div className="debug-log-header-text">
              <h2 id="debug-log-title">Debug- & System-Logs</h2>
              <p className="debug-log-header-subtitle">
                Echtzeit-Mitschnitt von Gemini-Streams, IPC-Events, Git-Operationen und Fehlern
              </p>
            </div>
          </div>
          <div className="debug-log-header-right">
            <span className="debug-log-stat-pill">
              {logs.length} {logs.length === 1 ? "Eintrag" : "Einträge"}
            </span>
            {errorCount > 0 && (
              <span className="debug-log-stat-pill debug-log-stat-pill--error">
                {errorCount} {errorCount === 1 ? "Fehler" : "Fehler"}
              </span>
            )}
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              aria-label="Schließen"
              title="Schließen (ESC)"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>

        {/* Toolbar & Filter Bar */}
        <div className="debug-log-toolbar">
          <div className="debug-log-segmented">
            <button
              type="button"
              className={`debug-segment-btn ${levelFilter === "all" ? "debug-segment-btn--active" : ""}`}
              onClick={() => setLevelFilter("all")}
            >
              Alle ({logs.length})
            </button>
            <button
              type="button"
              className={`debug-segment-btn debug-segment-btn--error ${levelFilter === "error" ? "debug-segment-btn--active" : ""}`}
              onClick={() => setLevelFilter("error")}
            >
              Fehler ({errorCount})
            </button>
            <button
              type="button"
              className={`debug-segment-btn debug-segment-btn--warn ${levelFilter === "warn" ? "debug-segment-btn--active" : ""}`}
              onClick={() => setLevelFilter("warn")}
            >
              Warnungen ({warnCount})
            </button>
            <button
              type="button"
              className={`debug-segment-btn ${levelFilter === "stream" ? "debug-segment-btn--active" : ""}`}
              onClick={() => setLevelFilter("stream")}
            >
              Stream ({streamCount})
            </button>
            <button
              type="button"
              className={`debug-segment-btn ${levelFilter === "ipc" ? "debug-segment-btn--active" : ""}`}
              onClick={() => setLevelFilter("ipc")}
            >
              IPC ({ipcCount})
            </button>
            <button
              type="button"
              className={`debug-segment-btn ${levelFilter === "info" ? "debug-segment-btn--active" : ""}`}
              onClick={() => setLevelFilter("info")}
            >
              Info ({infoCount})
            </button>
          </div>

          <div className="debug-log-search-box">
            <Icon name="search" size={14} />
            <input
              type="text"
              placeholder="Logs und Details durchsuchen…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="debug-search-clear-btn"
                onClick={() => setSearchQuery("")}
                aria-label="Suche leeren"
              >
                <Icon name="x" size={11} />
              </button>
            )}
          </div>

          <div className="debug-log-actions">
            <label className="debug-autoscroll-toggle">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
              />
              <span>Auto-Scroll</span>
            </label>
            <button
              type="button"
              className="debug-action-btn"
              onClick={handleCopyAll}
              disabled={filteredLogs.length === 0}
              title="Alle gefilterten Logs in die Zwischenablage kopieren"
            >
              <Icon name={copiedAll ? "check" : "copy"} size={13} />
              <span>{copiedAll ? "Kopiert" : "Alle Kopieren"}</span>
            </button>
            <button
              type="button"
              className="debug-action-btn debug-action-btn--danger"
              onClick={handleClear}
              disabled={logs.length === 0}
              title="Alle Logs leeren"
            >
              <Icon name="trash" size={13} />
              <span>Leeren</span>
            </button>
          </div>
        </div>

        {/* Structured Column Headers */}
        <div className="debug-table-header">
          <span className="debug-col-time">Zeit</span>
          <span className="debug-col-level">Level</span>
          <span className="debug-col-source">Quelle</span>
          <span className="debug-col-msg">Nachricht</span>
          <span className="debug-col-actions">Aktionen</span>
        </div>

        {/* Log Entries Container */}
        <div ref={scrollRef} className="debug-table-body">
          {filteredLogs.length === 0 ? (
            <div className="debug-empty-state">
              <span className="debug-empty-icon">
                <Icon name="terminal" size={32} />
              </span>
              <h3>Keine Einträge gefunden</h3>
              <p>
                {searchQuery || levelFilter !== "all"
                  ? "Passe den Suchbegriff oder die Filtereinstellungen an."
                  : "Ereignisse, Gemini-Stream-Nachrichten und Fehler werden hier in Echtzeit aufgezeichnet."}
              </p>
            </div>
          ) : (
            <div className="debug-log-list">
              {filteredLogs.map((log) => {
                const isExpanded = expandedIds.has(log.id);
                const hasDetails = Boolean(log.details);
                const isCopied = copiedId === log.id;
                const timeStr = log.timestamp.toLocaleTimeString("de-DE", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  fractionalSecondDigits: 3,
                });

                return (
                  <div
                    key={log.id}
                    className={`debug-log-card debug-log-card--${log.level} ${
                      isExpanded ? "debug-log-card--expanded" : ""
                    }`}
                  >
                    <div
                      className="debug-log-card-main"
                      onClick={() => hasDetails && toggleExpand(log.id)}
                    >
                      <span className="debug-cell-time">{timeStr}</span>
                      <span className="debug-cell-level">
                        <span className={`debug-level-pill-badge debug-level-pill-badge--${log.level}`}>
                          {log.level.toUpperCase()}
                        </span>
                      </span>
                      <span className="debug-cell-source">
                        <span className="debug-source-badge">{log.source}</span>
                      </span>
                      <span className="debug-cell-msg">{log.message}</span>
                      <div className="debug-cell-actions">
                        <button
                          type="button"
                          className="debug-row-btn"
                          title="Eintrag kopieren"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyEntry(log);
                          }}
                        >
                          <Icon name={isCopied ? "check" : "copy"} size={13} />
                        </button>
                        {hasDetails && (
                          <button
                            type="button"
                            className="debug-row-btn"
                            aria-label={isExpanded ? "Details einklappen" : "Details ausklappen"}
                            title={isExpanded ? "Details einklappen" : "Details ausklappen"}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpand(log.id);
                            }}
                          >
                            <Icon name={isExpanded ? "chevron-up" : "chevron-down"} size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                    {Boolean(isExpanded && log.details) && (
                      <div className="debug-log-card-details">
                        <pre>
                          {typeof log.details === "string"
                            ? log.details
                            : JSON.stringify(log.details, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
