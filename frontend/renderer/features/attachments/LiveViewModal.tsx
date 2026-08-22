import { createEffect } from "solid-js";
import { Icon } from "../../components/Icon";
import { LinkPreviewSurface } from "./LinkPreviewSurface";

type LiveViewModalProps = {
  url: string | null;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
};

export function LiveViewModal({ url, onClose, onOpenExternal }: LiveViewModalProps) {
  createEffect(() => {
    if (!url) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  if (!url) return null;

  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // ignore
  }

  return (
    <div class="modal-backdrop live-view-backdrop" onClick={onClose}>
      <div
        class="live-view-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Live-Ansicht von ${host}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header class="live-view-header">
          <div class="live-view-header-info">
            <span class="live-view-globe-icon">
              <Icon name="globe" size={15} />
            </span>
            <div class="live-view-titles">
              <strong>{host}</strong>
              <span class="live-view-url-sub" title={url}>{url}</span>
            </div>
          </div>

          <div class="live-view-header-actions">
            <button
              type="button"
              class="secondary-button live-view-browser-button"
              onClick={() => onOpenExternal(url)}
              title="In externem Webbrowser öffnen"
            >
              <Icon name="external" size={13} />
              <span>Im Browser öffnen</span>
            </button>
            <button
              type="button"
              class="icon-button live-view-close-button"
              onClick={onClose}
              aria-label="Live-Ansicht schließen"
              title="Schließen (Esc)"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>

        <div class="live-view-body">
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
