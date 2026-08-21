import { useEffect } from "react";
import { Icon } from "../../components/Icon";
import { LinkPreviewSurface } from "./LinkPreviewSurface";

type LiveViewModalProps = {
  url: string | null;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
};

export function LiveViewModal({ url, onClose, onOpenExternal }: LiveViewModalProps) {
  useEffect(() => {
    if (!url) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [url, onClose]);

  if (!url) return null;

  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // ignore
  }

  return (
    <div className="modal-backdrop live-view-backdrop" onClick={onClose}>
      <div
        className="live-view-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Live-Ansicht von ${host}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="live-view-header">
          <div className="live-view-header-info">
            <span className="live-view-globe-icon">
              <Icon name="globe" size={15} />
            </span>
            <div className="live-view-titles">
              <strong>{host}</strong>
              <span className="live-view-url-sub" title={url}>{url}</span>
            </div>
          </div>

          <div className="live-view-header-actions">
            <button
              type="button"
              className="secondary-button live-view-browser-button"
              onClick={() => onOpenExternal(url)}
              title="In externem Webbrowser öffnen"
            >
              <Icon name="external" size={13} />
              <span>Im Browser öffnen</span>
            </button>
            <button
              type="button"
              className="icon-button live-view-close-button"
              onClick={onClose}
              aria-label="Live-Ansicht schließen"
              title="Schließen (Esc)"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>

        <div className="live-view-body">
          <LinkPreviewSurface
            url={url}
            host={host}
            showHeader={false}
            isExpanded={true}
            onOpenExternal={onOpenExternal}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}
