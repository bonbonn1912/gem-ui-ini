import { createRenderEffect, createSignal, Show } from "solid-js";

import { Icon } from "../../components/Icon";

type AddLinkDialogProps = {
  open: boolean;
  scopeLabel: string;
  onClose: () => void;
  onSubmit: (url: string, title?: string) => Promise<void>;
};

export function AddLinkDialog(props: AddLinkDialogProps) {
  const [url, setUrl] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createRenderEffect(() => {
    if (!props.open) return;
    setUrl("");
    setTitle("");
    setError(null);
    void window.gemUi.linkPreview.close();
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    let targetUrl = url().trim();
    if (targetUrl && !/^https?:\/\//i.test(targetUrl) && !targetUrl.includes("://")) {
      targetUrl = `https://${targetUrl}`;
    }
    try {
      await props.onSubmit(targetUrl, title().trim() || undefined);
      props.onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Der Link konnte nicht hinzugefügt werden.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Show when={props.open}>
      <div class="modal-layer attachment-link-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) props.onClose();
    }}>
      <form
        class="project-dialog add-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-link-dialog-title"
        onSubmit={(event) => void submit(event)}
      >
        <header>
          <div>
            <p class="eyebrow">{props.scopeLabel}</p>
            <h2 id="add-link-dialog-title">Link hinzufügen</h2>
          </div>
          <button class="icon-button" type="button" onClick={props.onClose} aria-label="Dialog schließen">
            <Icon name="x" size={18} />
          </button>
        </header>
        <div class="dialog-body">
          <label class="field-label">
            HTTPS-Adresse
            <input
              autofocus
              required
              type="url"
              inputMode="url"
              placeholder="https://…"
              value={url()}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label class="field-label">
            Eigener Titel <span class="optional-label">optional</span>
            <input
              value={title()}
              maxLength={300}
              placeholder="Wird sonst aus der Seite gelesen"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <p class="link-security-note"><Icon name="shield" size={15} /> Nur öffentliche HTTPS-Adressen werden für die Vorschau abgerufen.</p>
          {error() && <p class="dialog-error"><Icon name="warning" size={14} />{error()}</p>}
        </div>
        <footer>
          <button class="secondary-button" type="button" onClick={props.onClose}>Abbrechen</button>
          <button class="primary-button" type="submit" disabled={submitting() || !url().trim()}>
            {submitting() ? <span class="mini-spinner" /> : <Icon name="link" size={16} />}
            Hinzufügen
          </button>
        </footer>
      </form>
      </div>
    </Show>
  );
}
