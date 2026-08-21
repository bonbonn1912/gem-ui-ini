import { useLayoutEffect, useState, type FormEvent } from "react";

import { Icon } from "../../components/Icon";

type AddLinkDialogProps = {
  open: boolean;
  scopeLabel: string;
  onClose: () => void;
  onSubmit: (url: string, title?: string) => Promise<void>;
};

export function AddLinkDialog({ open, scopeLabel, onClose, onSubmit }: AddLinkDialogProps) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    setUrl("");
    setTitle("");
    setError(null);
    void window.gemUi.linkPreview.close();
  }, [open]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    let targetUrl = url.trim();
    if (targetUrl && !/^https?:\/\//i.test(targetUrl) && !targetUrl.includes("://")) {
      targetUrl = `https://${targetUrl}`;
    }
    try {
      await onSubmit(targetUrl, title.trim() || undefined);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Der Link konnte nicht hinzugefügt werden.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-layer attachment-link-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <form
        className="project-dialog add-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-link-dialog-title"
        onSubmit={(event) => void submit(event)}
      >
        <header>
          <div>
            <p className="eyebrow">{scopeLabel}</p>
            <h2 id="add-link-dialog-title">Link hinzufügen</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Dialog schließen">
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="dialog-body">
          <label className="field-label">
            HTTPS-Adresse
            <input
              autoFocus
              required
              type="url"
              inputMode="url"
              placeholder="https://…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label className="field-label">
            Eigener Titel <span className="optional-label">optional</span>
            <input
              value={title}
              maxLength={300}
              placeholder="Wird sonst aus der Seite gelesen"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <p className="link-security-note"><Icon name="shield" size={15} /> Nur öffentliche HTTPS-Adressen werden für die Vorschau abgerufen.</p>
          {error && <p className="dialog-error"><Icon name="warning" size={14} />{error}</p>}
        </div>
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>Abbrechen</button>
          <button className="primary-button" type="submit" disabled={submitting || !url.trim()}>
            {submitting ? <span className="mini-spinner" /> : <Icon name="link" size={16} />}
            Hinzufügen
          </button>
        </footer>
      </form>
    </div>
  );
}
