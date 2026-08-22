import { createEffect, createSignal, onCleanup } from "solid-js";
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
  const [open, setOpen] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  const [updateInfo, setUpdateInfo] = createSignal<AppUpdateInfo | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = createSignal<Date | null>(null);

  // In-App Update State
  const [downloading, setDownloading] = createSignal(false);
  const [downloadProgress, setDownloadProgress] = createSignal<AppUpdateDownloadProgress | null>(null);
  const [downloadedFilePath, setDownloadedFilePath] = createSignal<string | null>(null);
  const [installing, setInstalling] = createSignal(false);
  const [downloadError, setDownloadError] = createSignal<string | null>(null);

  let containerRef!: HTMLDivElement;
  let closeTimeoutRef: number | null = null;

  const handleMouseEnter = () => {
    if (closeTimeoutRef) {
      window.clearTimeout(closeTimeoutRef);
      closeTimeoutRef = null;
    }
    setOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimeoutRef = window.setTimeout(() => {
      setOpen(false);
    }, 250);
  };

  const toggleOpen = () => {
    setOpen((prev) => !prev);
  };

  createEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (containerRef && !containerRef.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleDocumentClick);
    onCleanup(() => {
      document.removeEventListener("mousedown", handleDocumentClick);
      if (closeTimeoutRef) {
        window.clearTimeout(closeTimeoutRef);
      }
    });
  });

  createEffect(() => {
    const unsubscribe = window.gemUi?.app?.onDownloadProgress?.((progress) => {
      setDownloadProgress(progress);
    });
    onCleanup(() => {
      unsubscribe?.();
    });
  });

  const handleCheckForUpdates = async () => {
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
    const downloadUrl = updateInfo()?.downloadUrl;
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
    if (!downloadedFilePath()) return;

    setInstalling(true);
    setDownloadError(null);
    try {
      await window.gemUi.app.installUpdate({ filePath: downloadedFilePath() });
    } catch (err: unknown) {
      setDownloadError((err as Error).message || "Fehler beim Starten der Installation.");
      setInstalling(false);
    }
  };

  const geminiAvailable = capabilities.gemini.available && capabilities.gemini.acp;
  const currentAppVersion = capabilities.appVersion || updateInfo()?.currentVersion || "0.5.0";

  return (
    <div
      ref={containerRef}
      class="app-info-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        class={`app-info-trigger-button ${open() ? "app-info-trigger-button--active" : ""}`}
        onClick={toggleOpen}
        aria-label="App-Informationen und Updates"
        title={`GeminUI v${currentAppVersion} - App-Informationen & Updates`}
      >
        <Icon name="info" size={14} />
        <span class="app-info-trigger-version">v{currentAppVersion}</span>
      </button>

      {open() && (
        <div class="app-info-popover" role="dialog" aria-label="GeminUI Informationen und Updates">
          <header class="app-info-popover-header">
            <div class="app-info-popover-brand">
              <span class="app-info-logo-badge">
                <Icon name="sparkle" size={14} />
              </span>
              <div class="app-info-title-group">
                <strong>GeminUI</strong>
                <span class="app-version-tag">v{currentAppVersion}</span>
              </div>
            </div>
            <button
              type="button"
              class="app-info-close-button"
              onClick={() => setOpen(false)}
              aria-label="Schließen"
            >
              <Icon name="x" size={12} />
            </button>
          </header>

          <div class="app-info-popover-body">
            <div class="app-info-status-card">
              <div class="app-info-cli-status">
                <span class={`agent-dot agent-dot--${geminiAvailable ? "ready" : "error"}`} />
                <span class="app-info-cli-label">
                  Gemini CLI: <strong>{geminiAvailable ? (capabilities.gemini.version ? `v${capabilities.gemini.version}` : "bereit") : "nicht bereit"}</strong>
                </span>
              </div>
            </div>

            {updateInfo()?.updateAvailable && (
              <div class="update-available-banner">
                <div class="update-available-header">
                  <span class="update-pulse-icon">
                    <Icon name="download" size={14} />
                  </span>
                  <div>
                    <div class="update-badge">Update verfügbar</div>
                    <strong class="update-version-title">Version v{updateInfo().latestVersion}</strong>
                  </div>
                </div>

                {cleanReleaseNotes(updateInfo().releaseNotes) && (
                  <p class="update-release-snippet">{cleanReleaseNotes(updateInfo().releaseNotes)!.slice(0, 140)}...</p>
                )}

                {downloadedFilePath() ? (
                  <div class="update-ready-box">
                    <div class="update-ready-status">
                      <span class="update-ready-dot" />
                      <div>
                        <strong>Update heruntergeladen</strong>
                        <span class="update-ready-subtext">Wird direkt mit der neuen Version neu gestartet.</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      class="primary-button update-install-now-button"
                      onClick={handleInstallUpdate}
                      disabled={installing()}
                    >
                      {installing() ? (
                        <>
                          <span class="mini-spinner" /> Starte Aktualisierung …
                        </>
                      ) : (
                        <>
                          <Icon name="refresh" size={13} /> Jetzt neu starten & installieren
                        </>
                      )}
                    </button>
                  </div>
                ) : downloading() ? (
                  <div class="update-downloading-box">
                    <div class="update-progress-info">
                      <span>Herunterladen …</span>
                      <strong class="update-progress-percent">
                        {downloadProgress() ? `${downloadProgress().percent}%` : "0%"}
                      </strong>
                    </div>
                    <div class="update-progress-bar-track">
                      <div
                        class="update-progress-bar-fill"
                        style={{ width: `${downloadProgress()?.percent ?? 5}%` }}
                      />
                    </div>
                    {downloadProgress() && downloadProgress().totalBytes > 0 && (
                      <span class="update-progress-bytes">
                        {(downloadProgress().receivedBytes / (1024 * 1024)).toFixed(1)} MB von{" "}
                        {(downloadProgress().totalBytes / (1024 * 1024)).toFixed(1)} MB
                      </span>
                    )}
                  </div>
                ) : (
                  <div class="update-action-group">
                    <button
                      type="button"
                      class="primary-button update-action-button"
                      onClick={handleDownloadUpdate}
                      disabled={downloading() || !updateInfo()?.downloadUrl}
                    >
                      <Icon name="download" size={13} /> Update herunterladen & installieren
                    </button>
                  </div>
                )}

                {downloadError() && (
                  <div class="update-error-banner">
                    <Icon name="warning" size={14} />
                    <span>{downloadError()}</span>
                  </div>
                )}
              </div>
            )}

            {updateInfo() && !updateInfo().updateAvailable && !updateInfo().error && (
              <div class="update-uptodate-banner">
                <Icon name="check" size={14} />
                <span>GeminUI ist auf dem neuesten Stand</span>
              </div>
            )}

            {updateInfo()?.error && (
              <div class="update-error-banner">
                <Icon name="warning" size={14} />
                <span>{updateInfo().error}</span>
              </div>
            )}

            <div class="app-info-actions">
              <button
                type="button"
                class="secondary-button check-update-button"
                onClick={handleCheckForUpdates}
                disabled={checking() || downloading() || installing()}
              >
                {checking() ? (
                  <>
                    <span class="mini-spinner" /> Suche nach Updates …
                  </>
                ) : (
                  <>
                    <Icon name="refresh" size={13} /> Nach Updates suchen
                  </>
                )}
              </button>
              {lastCheckedAt() && (
                <span class="last-checked-time">
                  Zuletzt geprüft: {lastCheckedAt().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
