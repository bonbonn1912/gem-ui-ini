import { Icon } from "../../components/Icon";

type ReconnectHistoryModalProps = {
  open: boolean;
  onChoose: (mode: "compressed" | "fresh") => void;
  onCancel: () => void;
};

export function ReconnectHistoryModal({
  open,
  onChoose,
  onCancel,
}: ReconnectHistoryModalProps) {
  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        className="modal-card reconnect-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reconnect-dialog-title"
      >
        <header className="modal-header">
          <div className="reconnect-modal-badge">
            <Icon name="refresh" size={18} />
          </div>
          <div>
            <h3 id="reconnect-dialog-title">Gemini-Sitzung neu gestartet</h3>
            <p className="modal-subtitle">
              Die Hintergrundverbindung zur Gemini CLI wurde neu aufgebaut. Wie möchtest du fortfahren?
            </p>
          </div>
        </header>

        <div className="reconnect-modal-body">
          <button
            type="button"
            className="reconnect-option-card reconnect-option-card--primary"
            onClick={() => onChoose("compressed")}
            autoFocus
          >
            <div className="reconnect-option-icon">
              <Icon name="brain" size={18} />
            </div>
            <div className="reconnect-option-content">
              <strong>Bisherigen Verlauf mitsenden (Empfohlen)</strong>
              <p>
                GeminUI fasst die bisherigen Fragen und Antworten dieser Session komprimiert zusammen und übergibt sie an Gemini, damit das Modell den Kontext kennt.
              </p>
            </div>
          </button>

          <button
            type="button"
            className="reconnect-option-card"
            onClick={() => onChoose("fresh")}
          >
            <div className="reconnect-option-icon">
              <Icon name="sparkle" size={18} />
            </div>
            <div className="reconnect-option-content">
              <strong>Als frischen Kontext starten</strong>
              <p>
                Startet die Gemini-Sitzung ohne vorherigen Verlauf. Alle bisherigen Nachrichten bleiben in GeminUI weiterhin sichtbar.
              </p>
            </div>
          </button>
        </div>

        <footer className="modal-footer">
          <button type="button" className="ghost-button" onClick={onCancel}>
            Abbrechen
          </button>
        </footer>
      </div>
    </div>
  );
}

type ReconnectHistoryBannerProps = {
  onChoose: (mode: "compressed" | "fresh") => void;
};

export function ReconnectHistoryBanner({
  onChoose,
}: ReconnectHistoryBannerProps) {
  return (
    <aside className="reconnect-banner" aria-label="Gemini Sitzungsstatus">
      <div className="reconnect-banner-info">
        <span className="reconnect-banner-icon">
          <Icon name="refresh" size={15} />
        </span>
        <div className="reconnect-banner-text">
          <strong>Gemini-Sitzung neu gestartet</strong>
          <span>Möchtest du den bisherigen Verlauf komprimiert mitsenden oder mit frischem Kontext fortfahren?</span>
        </div>
      </div>
      <div className="reconnect-banner-actions">
        <button
          type="button"
          className="reconnect-banner-btn reconnect-banner-btn--primary"
          onClick={() => onChoose("compressed")}
        >
          <Icon name="brain" size={13} /> Verlauf komprimiert mitsenden
        </button>
        <button
          type="button"
          className="reconnect-banner-btn"
          onClick={() => onChoose("fresh")}
        >
          <Icon name="sparkle" size={13} /> Frischer Kontext
        </button>
      </div>
    </aside>
  );
}
