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
    <div class="modal-backdrop" onClick={onCancel} role="presentation">
      <div
        class="modal-card reconnect-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reconnect-dialog-title"
      >
        <header class="modal-header">
          <div class="reconnect-modal-badge">
            <Icon name="refresh" size={18} />
          </div>
          <div>
            <h3 id="reconnect-dialog-title">Gemini-Sitzung neu gestartet</h3>
            <p class="modal-subtitle">
              Die Hintergrundverbindung zur Gemini CLI wurde neu aufgebaut. Wie möchtest du fortfahren?
            </p>
          </div>
        </header>

        <div class="reconnect-modal-body">
          <button
            type="button"
            class="reconnect-option-card reconnect-option-card--primary"
            onClick={() => onChoose("compressed")}
            autofocus
          >
            <div class="reconnect-option-icon">
              <Icon name="brain" size={18} />
            </div>
            <div class="reconnect-option-content">
              <strong>Bisherigen Verlauf mitsenden (Empfohlen)</strong>
              <p>
                GeminUI fasst die bisherigen Fragen und Antworten dieser Session komprimiert zusammen und übergibt sie an Gemini, damit das Modell den Kontext kennt.
              </p>
            </div>
          </button>

          <button
            type="button"
            class="reconnect-option-card"
            onClick={() => onChoose("fresh")}
          >
            <div class="reconnect-option-icon">
              <Icon name="sparkle" size={18} />
            </div>
            <div class="reconnect-option-content">
              <strong>Als frischen Kontext starten</strong>
              <p>
                Startet die Gemini-Sitzung ohne vorherigen Verlauf. Alle bisherigen Nachrichten bleiben in GeminUI weiterhin sichtbar.
              </p>
            </div>
          </button>
        </div>

        <footer class="modal-footer">
          <button type="button" class="ghost-button" onClick={onCancel}>
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
    <aside class="reconnect-banner" aria-label="Gemini Sitzungsstatus">
      <div class="reconnect-banner-info">
        <span class="reconnect-banner-icon">
          <Icon name="refresh" size={15} />
        </span>
        <div class="reconnect-banner-text">
          <strong>Gemini-Sitzung neu gestartet</strong>
          <span>Möchtest du den bisherigen Verlauf komprimiert mitsenden oder mit frischem Kontext fortfahren?</span>
        </div>
      </div>
      <div class="reconnect-banner-actions">
        <button
          type="button"
          class="reconnect-banner-btn reconnect-banner-btn--primary"
          onClick={() => onChoose("compressed")}
        >
          <Icon name="brain" size={13} /> Verlauf komprimiert mitsenden
        </button>
        <button
          type="button"
          class="reconnect-banner-btn"
          onClick={() => onChoose("fresh")}
        >
          <Icon name="sparkle" size={13} /> Frischer Kontext
        </button>
      </div>
    </aside>
  );
}
