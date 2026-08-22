import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { AppCapabilities, AppUpdateDownloadProgress, AppUpdateInfo } from "../../types";

type AppInfoUpdatePopoverProps = {
  capabilities: AppCapabilities;
};

function cleanReleaseNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const filtered = notes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const lower = line.toLowerCase();
      if (lower.includes("bonbonn1912") || lower.includes("bonbon1912") || lower.includes("gem-ui-ini")) return false;
      if (lower.includes("github.com") || lower.includes("gitlab.com")) return false;
      if (lower.includes("changelog") || lower.includes("compare/")) return false;
      if (lower.startsWith("http://") || lower.startsWith("https://")) return false;
      return true;
    })
    .join("\n")
    .trim();
  return filtered || null;
}

export function AppInfoUpdatePopover({ capabilities }: AppInfoUpdatePopoverProps) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  // In-App Update State
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<AppUpdateDownloadProgress | null>(null);
  const [downloadedFilePath, setDownloadedFilePath] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

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

  useEffect(() => {
    const unsubscribe = window.gemUi?.app?.onDownloadProgress?.((progress) => {
      setDownloadProgress(progress);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  // Automatische Suche 1x pro Stunde nach Updates (und direkt bei App-Start)
  useEffect(() => {
    void handleCheckForUpdates();

    const intervalId = window.setInterval(() => {
      void handleCheckForUpdates();
    }, 60 * 60 * 1000); // 1 Stunde

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const handleCheckForUpdates = async () => {
    if (!window.gemUi?.app?.checkForUpdates) return;
    setChecking(true);
    setDownloadError(null);
    setDownloadedFilePath(null);
    setDownloadProgress(null);
    try {
      const result = await window.gemUi.app.checkForUpdates();
      setUpdateInfo(result);
      setLastCheckedAt(new Date());
    } catch (err: unknown) {
      setUpdateInfo({
        currentVersion: capabilities.appVersion ?? "0.5.0",
        latestVersion: null,
        updateAvailable: false,
        error: (err as Error).message || "Fehler beim Prüfen auf Updates.",
      });
      setLastCheckedAt(new Date());
    } finally {
      setChecking(false);
    }
  };

  const handleDownloadUpdate = async () => {
    const downloadUrl = updateInfo?.downloadUrl;
    if (!downloadUrl) return;

    setDownloading(true);
    setDownloadError(null);
    setDownloadProgress(null);
    try {
      const result = await window.gemUi.app.downloadUpdate({ downloadUrl });
      setDownloadedFilePath(result.filePath);
    } catch (err: unknown) {
      setDownloadError((err as Error).message || "Fehler beim Herunterladen des Updates.");
    } finally {
      setDownloading(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!downloadedFilePath) return;

    setInstalling(true);
    setDownloadError(null);
    try {
      await window.gemUi.app.installUpdate({ filePath: downloadedFilePath });
    } catch (err: unknown) {
      setDownloadError((err as Error).message || "Fehler beim Starten der Installation.");
      setInstalling(false);
    }
  };

  const geminiAvailable = capabilities.gemini.available && capabilities.gemini.acp;
  const currentAppVersion = capabilities.appVersion || updateInfo?.currentVersion || "0.5.0";

  return (
    <div
      ref={containerRef}
      className="app-info-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className={`app-info-trigger-button ${open ? "app-info-trigger-button--active" : ""} ${
          updateInfo?.updateAvailable ? "app-info-trigger-button--update-available" : ""
        }`}
        onClick={toggleOpen}
        aria-label={
          updateInfo?.updateAvailable
            ? `Update verfügbar: v${updateInfo.latestVersion}. App-Informationen und Updates`
            : "App-Informationen und Updates"
        }
        title={
          updateInfo?.updateAvailable
            ? `Update verfügbar: v${updateInfo.latestVersion} (GeminUI v${currentAppVersion})`
            : `GeminUI v${currentAppVersion} - App-Informationen & Updates`
        }
      >
        <span
          className={`app-info-trigger-icon ${
            updateInfo?.updateAvailable ? "app-info-trigger-icon--pulse" : ""
          }`}
        >
          <Icon name="info" size={14} />
          {updateInfo?.updateAvailable && <span className="update-available-dot" />}
        </span>
        <span className="app-info-trigger-version">v{currentAppVersion}</span>
      </button>

      {open && (
        <div className="app-info-popover" role="dialog" aria-label="GeminUI Informationen und Updates">
          <header className="app-info-popover-header">
            <div className="app-info-popover-brand">
              <span className="app-info-logo-badge">
                <Icon name="sparkle" size={14} />
              </span>
              <div className="app-info-title-group">
                <strong>GeminUI</strong>
                <span className="app-version-tag">v{currentAppVersion}</span>
              </div>
            </div>
            <button
              type="button"
              className="app-info-close-button"
              onClick={() => setOpen(false)}
              aria-label="Schließen"
            >
              <Icon name="x" size={12} />
            </button>
          </header>

          <div className="app-info-popover-body">
            <div className="app-info-status-card">
              <div className="app-info-cli-status">
                <span className={`agent-dot agent-dot--${geminiAvailable ? "ready" : "error"}`} />
                <span className="app-info-cli-label">
                  Gemini CLI: <strong>{geminiAvailable ? (capabilities.gemini.version ? `v${capabilities.gemini.version}` : "bereit") : "nicht bereit"}</strong>
                </span>
              </div>
            </div>

            {updateInfo?.updateAvailable && (
              <div className="update-available-banner">
                <div className="update-available-header">
                  <span className="update-pulse-icon">
                    <Icon name="download" size={14} />
                  </span>
                  <div>
                    <div className="update-badge">Update verfügbar</div>
                    <strong className="update-version-title">Version v{updateInfo.latestVersion}</strong>
                  </div>
                </div>

                {cleanReleaseNotes(updateInfo.releaseNotes) && (
                  <p className="update-release-snippet">{cleanReleaseNotes(updateInfo.releaseNotes)!.slice(0, 140)}...</p>
                )}

                {downloadedFilePath ? (
                  <div className="update-ready-box">
                    <div className="update-ready-status">
                      <span className="update-ready-dot" />
                      <div>
                        <strong>Update heruntergeladen</strong>
                        <span className="update-ready-subtext">Wird direkt mit der neuen Version neu gestartet.</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="primary-button update-install-now-button"
                      onClick={handleInstallUpdate}
                      disabled={installing}
                    >
                      {installing ? (
                        <>
                          <span className="mini-spinner" /> Starte Aktualisierung …
                        </>
                      ) : (
                        <>
                          <Icon name="refresh" size={13} /> Jetzt neu starten & installieren
                        </>
                      )}
                    </button>
                  </div>
                ) : downloading ? (
                  <div className="update-downloading-box">
                    <div className="update-progress-info">
                      <span>Herunterladen …</span>
                      <strong className="update-progress-percent">
                        {downloadProgress ? `${downloadProgress.percent}%` : "0%"}
                      </strong>
                    </div>
                    <div className="update-progress-bar-track">
                      <div
                        className="update-progress-bar-fill"
                        style={{ width: `${downloadProgress?.percent ?? 5}%` }}
                      />
                    </div>
                    {downloadProgress && downloadProgress.totalBytes > 0 && (
                      <span className="update-progress-bytes">
                        {(downloadProgress.receivedBytes / (1024 * 1024)).toFixed(1)} MB von{" "}
                        {(downloadProgress.totalBytes / (1024 * 1024)).toFixed(1)} MB
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="update-action-group">
                    <button
                      type="button"
                      className="primary-button update-action-button"
                      onClick={handleDownloadUpdate}
                      disabled={downloading || !updateInfo?.downloadUrl}
                    >
                      <Icon name="download" size={13} /> Update herunterladen & installieren
                    </button>
                  </div>
                )}

                {downloadError && (
                  <div className="update-error-banner">
                    <Icon name="warning" size={14} />
                    <span>{downloadError}</span>
                  </div>
                )}
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
                disabled={checking || downloading || installing}
              >
                {checking ? (
                  <>
                    <span className="mini-spinner" /> Suche nach Updates …
                  </>
                ) : (
                  <>
                    <Icon name="refresh" size={13} /> Nach Updates suchen
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
