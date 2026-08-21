import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { AppCapabilities, AppUpdateInfo } from "../../types";

type AppInfoUpdatePopoverProps = {
  capabilities: AppCapabilities;
};

export function AppInfoUpdatePopover({ capabilities }: AppInfoUpdatePopoverProps) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<number | null>(null);

  const handleMouseEnter = () => {
    if (closeTimeoutRef.current) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimeoutRef.current = window.setTimeout(() => {
      setOpen(false);
    }, 250);
  };

  const toggleOpen = () => {
    setOpen((prev) => !prev);
  };

  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleDocumentClick);
    return () => {
      document.removeEventListener("mousedown", handleDocumentClick);
      if (closeTimeoutRef.current) {
        window.clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

  const handleCheckForUpdates = async () => {
    setChecking(true);
    try {
      const result = await window.gemUi.app.checkForUpdates();
      setUpdateInfo(result);
      setLastCheckedAt(new Date());
    } catch (err: unknown) {
      setUpdateInfo({
        currentVersion: "0.5.0",
        latestVersion: null,
        updateAvailable: false,
        error: (err as Error).message || "Fehler beim Prüfen auf Updates.",
      });
      setLastCheckedAt(new Date());
    } finally {
      setChecking(false);
    }
  };

  const handleOpenReleaseUrl = (url?: string | null) => {
    if (!url) return;
    void window.gemUi.openExternalHttpsUrl(url);
  };

  const geminiAvailable = capabilities.gemini.available && capabilities.gemini.acp;
  const currentAppVersion = updateInfo?.currentVersion ?? "0.5.0";

  return (
    <div
      ref={containerRef}
      className="app-info-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className={`app-info-trigger-button ${open ? "app-info-trigger-button--active" : ""}`}
        onClick={toggleOpen}
        aria-label="App-Informationen und Updates"
        title="App-Informationen & Nach Updates suchen"
      >
        <Icon name="info" size={14} />
      </button>

      {open && (
        <div className="app-info-popover" role="dialog" aria-label="GeminUI Informationen und Updates">
          <header className="app-info-popover-header">
            <div className="app-info-popover-brand">
              <span className="app-info-logo-badge">
                <Icon name="sparkle" size={14} />
              </span>
              <div>
                <strong>GeminUI</strong>
                <span className="app-version-tag">v{currentAppVersion}</span>
              </div>
            </div>
          </header>

          <div className="app-info-popover-body">
            <div className="app-info-cli-status">
              <span className={`agent-dot agent-dot--${geminiAvailable ? "ready" : "error"}`} />
              <span>
                Gemini CLI: {geminiAvailable ? (capabilities.gemini.version ? `v${capabilities.gemini.version}` : "bereit") : "nicht bereit"}
              </span>
            </div>

            {updateInfo?.updateAvailable && (
              <div className="update-available-banner">
                <div className="update-available-header">
                  <span className="update-pulse-icon">
                    <Icon name="download" size={14} />
                  </span>
                  <div>
                    <strong>Update verfügbar!</strong>
                    <p className="update-version-label">Version v{updateInfo.latestVersion}</p>
                  </div>
                </div>
                {updateInfo.releaseNotes && (
                  <p className="update-release-snippet">{updateInfo.releaseNotes.slice(0, 150)}...</p>
                )}
                <button
                  type="button"
                  className="primary-button update-action-button"
                  onClick={() => handleOpenReleaseUrl(updateInfo.downloadUrl || updateInfo.htmlUrl)}
                >
                  <Icon name="external" size={13} /> Release herunterladen
                </button>
              </div>
            )}

            {updateInfo && !updateInfo.updateAvailable && !updateInfo.error && (
              <div className="update-uptodate-banner">
                <Icon name="check" size={14} />
                <span>GeminUI ist auf dem neuesten Stand</span>
              </div>
            )}

            {updateInfo?.error && (
              <div className="update-error-banner">
                <Icon name="warning" size={14} />
                <span>{updateInfo.error}</span>
              </div>
            )}

            <div className="app-info-actions">
              <button
                type="button"
                className="secondary-button check-update-button"
                onClick={handleCheckForUpdates}
                disabled={checking}
              >
                {checking ? (
                  <>
                    <span className="mini-spinner" /> Suche nach Updates …
                  </>
                ) : (
                  <>
                    <Icon name="refresh" size={13} /> Nach Update suchen
                  </>
                )}
              </button>
              {lastCheckedAt && (
                <span className="last-checked-time">
                  Zuletzt geprüft: {lastCheckedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
