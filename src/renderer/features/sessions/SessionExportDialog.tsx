import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type { AppSession, ExportSessionInput } from "../../types";

type SessionExportDialogProps = {
  session: AppSession;
  onClose: () => void;
};

const RATING_OPTIONS = [
  { value: 1, emoji: "😡", label: "Sehr unzufrieden", color: "#ef4444" },
  { value: 2, emoji: "🙁", label: "Unzufrieden", color: "#f97316" },
  { value: 3, emoji: "😐", label: "Neutral", color: "#eab308" },
  { value: 4, emoji: "🙂", label: "Zufrieden", color: "#84cc16" },
  { value: 5, emoji: "😃", label: "Sehr zufrieden", color: "#10b981" },
] as const;

export function SessionExportDialog({ session, onClose }: SessionExportDialogProps) {
  const [format, setFormat] = useState<"pdf" | "png">("pdf");
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [rating, setRating] = useState<number | null>(null);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successPath, setSuccessPath] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isExporting) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, isExporting]);

  const handleExport = async () => {
    setError(null);
    setSuccessPath(null);
    setIsExporting(true);

    try {
      const input: ExportSessionInput = {
        sessionId: session.id,
        format,
        mode,
        theme,
        includeMetadata,
        rating: rating ?? undefined,
        feedbackNote: feedbackNote.trim() || undefined,
      };

      const result = await window.gemUi.sessions.export(input);
      if (!result.canceled && result.filePath) {
        setSuccessPath(result.filePath);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fehler beim Exportieren der Session.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div
      className="modal-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !isExporting) {
          onClose();
        }
      }}
    >
      <section
        className="project-dialog session-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-export-dialog-title"
      >
        <header>
          <div>
            <p className="eyebrow">Exportieren</p>
            <h2 id="session-export-dialog-title">Chat exportieren</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            disabled={isExporting}
            aria-label="Dialog schließen"
          >
            <Icon name="x" size={19} />
          </button>
        </header>

        <div className="dialog-body export-dialog-body">
          {error && <div className="export-alert export-alert--error">{error}</div>}
          {successPath && (
            <div className="export-alert export-alert--success">
              <Icon name="check" size={16} />
              <div>
                <strong>Erfolgreich exportiert!</strong>
                <div className="export-path-preview">{successPath}</div>
              </div>
            </div>
          )}

          <div className="session-export-meta-preview">
            <span className="meta-preview-title">{session.title}</span>
            <span className="meta-preview-model">{session.model || "gemini"}</span>
          </div>

          {/* 1. Dateiformat */}
          <div className="export-form-section">
            <label className="export-section-label">Dateiformat</label>
            <div className="export-choice-grid">
              <button
                type="button"
                className={`export-choice-card ${format === "pdf" ? "export-choice-card--active" : ""}`}
                onClick={() => setFormat("pdf")}
              >
                <div className="export-choice-icon">
                  <Icon name="file-text" size={22} />
                </div>
                <div className="export-choice-copy">
                  <span className="export-choice-title">PDF Dokument</span>
                  <span className="export-choice-desc">
                    Paginierter Report mit durchsuchbarem Vektortext
                  </span>
                </div>
              </button>

              <button
                type="button"
                className={`export-choice-card ${format === "png" ? "export-choice-card--active" : ""}`}
                onClick={() => setFormat("png")}
              >
                <div className="export-choice-icon">
                  <Icon name="image" size={22} />
                </div>
                <div className="export-choice-copy">
                  <span className="export-choice-title">PNG Bild</span>
                  <span className="export-choice-desc">
                    Gesamter Chat als hochauflösendes Bild
                  </span>
                </div>
              </button>
            </div>
          </div>

          {/* 2. Darstellungsmodus */}
          <div className="export-form-section">
            <label className="export-section-label">Darstellungsmodus</label>
            <div className="export-choice-grid">
              <button
                type="button"
                className={`export-choice-card ${mode === "rendered" ? "export-choice-card--active" : ""}`}
                onClick={() => setMode("rendered")}
              >
                <div className="export-choice-icon">
                  <Icon name="sparkle" size={22} />
                </div>
                <div className="export-choice-copy">
                  <span className="export-choice-title">Gerendert (UI-Ansicht)</span>
                  <span className="export-choice-desc">
                    Layout wie in der App mit <b>allen Arbeitsschritten voll ausgeklappt</b>
                  </span>
                </div>
              </button>

              <button
                type="button"
                className={`export-choice-card ${mode === "raw" ? "export-choice-card--active" : ""}`}
                onClick={() => setMode("raw")}
              >
                <div className="export-choice-icon">
                  <Icon name="tool" size={22} />
                </div>
                <div className="export-choice-copy">
                  <span className="export-choice-title">Raw (JSON-Events)</span>
                  <span className="export-choice-desc">
                    Lückenlose Kette aller Rohdaten, Events und JSON-Payloads
                  </span>
                </div>
              </button>
            </div>
          </div>

          {/* 3. Session-Bewertung (Smiley-Skala) */}
          <div className="export-form-section">
            <div className="export-section-header-row">
              <label className="export-section-label">Bewertung</label>
              {rating !== null && (
                <button
                  type="button"
                  className="export-clear-rating"
                  onClick={() => setRating(null)}
                >
                  Entfernen
                </button>
              )}
            </div>

            <div className="export-smiley-bar">
              {RATING_OPTIONS.map((opt) => {
                const isSelected = rating === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`export-smiley-btn ${isSelected ? "export-smiley-btn--active" : ""}`}
                    style={{
                      borderColor: isSelected ? opt.color : undefined,
                      background: isSelected ? `color-mix(in srgb, ${opt.color} 20%, transparent)` : undefined,
                    }}
                    onClick={() => setRating(opt.value)}
                    title={`${opt.emoji} ${opt.label} (${opt.value}/5)`}
                  >
                    <span className="export-smiley-emoji">{opt.emoji}</span>
                    <span className="export-smiley-label" style={{ color: isSelected ? opt.color : undefined }}>
                      {opt.label}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Optionales Feedback / Notiz */}
            <div className="export-feedback-input-wrapper">
              <textarea
                className="export-feedback-textarea"
                placeholder="Optionale Notiz / Feedback zur Session"
                value={feedbackNote}
                onChange={(e) => setFeedbackNote(e.target.value)}
                rows={2}
                maxLength={2000}
              />
            </div>
          </div>

          {/* 4. Optionen & Design */}
          <div className="export-form-section">
            <label className="export-section-label">Optionen & Design</label>

            <label className="export-checkbox-row">
              <input
                type="checkbox"
                checked={includeMetadata}
                onChange={(e) => setIncludeMetadata(e.target.checked)}
              />
              <div className="export-checkbox-copy">
                <span>Mit Metadaten exportieren</span>
                <small>
                  Fügt bei jedem Turn die Tokenanzahl, das Modell, die Antwortdauer und Zeitstempel hinzu.
                </small>
              </div>
            </label>

            <div className="export-theme-selector">
              <span className="export-theme-label">Farbschema:</span>
              <div className="export-theme-pills">
                <button
                  type="button"
                  className={`export-theme-pill ${theme === "light" ? "export-theme-pill--active" : ""}`}
                  onClick={() => setTheme("light")}
                >
                  <Icon name="sun" size={14} /> Hell
                </button>
                <button
                  type="button"
                  className={`export-theme-pill ${theme === "dark" ? "export-theme-pill--active" : ""}`}
                  onClick={() => setTheme("dark")}
                >
                  <Icon name="moon" size={14} /> Dunkel
                </button>
              </div>
            </div>
          </div>
        </div>

        <footer>
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={isExporting}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className="primary-button export-submit-btn"
            onClick={handleExport}
            disabled={isExporting}
          >
            {isExporting ? (
              <>
                <span className="mini-spinner" />
                Wird exportiert...
              </>
            ) : (
              <>
                <Icon name="download" size={15} />
                Exportieren & Speichern…
              </>
            )}
          </button>
        </footer>
      </section>
    </div>
  );
}
