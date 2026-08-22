import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { Icon } from "../../components/Icon";
import { MarkdownContent } from "../../components/MarkdownContent";
import type { ContextAttachment } from "../../types";
import { LinkPreviewSurface } from "./LinkPreviewSurface";

type AttachmentDetailProps = {
  attachment: ContextAttachment;
  onBack: () => void;
  onOpenExternal: (url: string) => void;
  onOpenFile: (attachmentId: string) => Promise<void>;
  live?: boolean;
  onLiveToggle?: (live: boolean) => void;
};

function readableSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function PreviewImage({ attachment, variant }: {
  attachment: ContextAttachment;
  variant: "original" | "link_image";
}) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);

  createEffect(() => {
    let current = true;
    let objectUrl: string | null = null;
    window.gemUi.contextAttachments.getBytes({ attachmentId: attachment.id, variant })
      .then((bytes) => {
        if (!current) return;
        const copy = new Uint8Array(bytes);
        objectUrl = URL.createObjectURL(new Blob([copy], {
          type: attachment.file?.mimeType ?? "application/octet-stream",
        }));
        setUrl(objectUrl);
      })
      .catch(() => current && setFailed(true));
    onCleanup(() => {
      current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
  });

  if (failed()) return null;
  return url()
    ? <img class="attachment-detail-image" src={url()} alt={`Vorschau von ${attachment.title}`} />
    : <div class="attachment-preview-loading"><span class="mini-spinner" />Vorschau wird geladen …</div>;
}

function TextPreview({
  attachment,
  onOpenExternal,
}: {
  attachment: ContextAttachment;
  onOpenExternal: (url: string) => void;
}) {
  const [text, setText] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [rawView, setRawView] = createSignal(false);
  const isMarkdown =
    attachment.title.toLowerCase().endsWith(".md") ||
    attachment.title.toLowerCase().endsWith(".markdown") ||
    attachment.file?.mimeType === "text/markdown";

  createEffect(() => {
    let current = true;
    setText(null);
    setError(null);
    window.gemUi.contextAttachments.getBytes({ attachmentId: attachment.id, variant: "text_excerpt" })
      .then((bytes) => current && setText(bytesToText(bytes)))
      .catch((reason) => current && setError(reason instanceof Error ? reason.message : "Text ist nicht verfügbar."));
    onCleanup(() => { current = false; });
  });

  return (
    <Show when={!error()} fallback={<p class="attachment-detail-error"><Icon name="warning" size={15} />{error()}</p>}>
    <Show when={text() !== null} fallback={<div class="attachment-preview-loading"><span class="mini-spinner" />Text wird geladen …</div>}>
    <section class="attachment-text-preview">
      <header>
        <span>{text().length.toLocaleString("de-DE")} Zeichen Vorschau</span>
        <div class="preview-header-actions">
          {isMarkdown && (
            <button
              type="button"
              class="raw-toggle-btn"
              onClick={() => setRawView((v) => !v)}
              title={rawView() ? "Formatiertes Markdown anzeigen" : "Raw Markdown anzeigen"}
            >
              <Icon name={rawView() ? "sparkle" : "file-text"} size={13} />
              <span>{rawView() ? "Formatiert" : "Raw"}</span>
            </button>
          )}
          <button type="button" onClick={() => void navigator.clipboard.writeText(text())}><Icon name="copy" size={13} />Kopieren</button>
        </div>
      </header>
      {isMarkdown && !rawView() ? (
        <div class="attachment-markdown-container">
          <MarkdownContent onOpenExternal={onOpenExternal}>{text()}</MarkdownContent>
        </div>
      ) : (
        <pre>{text() || "Diese Datei enthält keinen auslesbaren Text."}</pre>
      )}
    </section>
    </Show>
    </Show>
  );
}

export function AttachmentDetail(props: AttachmentDetailProps) {
  const file = props.attachment.file;
  const link = props.attachment.link;
  const isImage = Boolean(file?.mimeType.startsWith("image/") && file.renderable);
  const hasText = Boolean(file && ["ready", "empty"].includes(file.extractionState));

  return (
    <div class="attachment-detail">
      <header class="attachment-detail-header">
        <button type="button" onClick={props.onBack} aria-label="Zurück zur Anhangsliste"><Icon name="arrow-left" size={17} /></button>
        <span class="attachment-detail-kind"><Icon name={props.attachment.kind === "link" ? "link" : isImage ? "image" : "file-text"} size={17} /></span>
        <div><strong>{props.attachment.title}</strong><span>{props.attachment.scope === "project" ? "Projektanhang" : "Sessionanhang"}</span></div>
      </header>

      {props.attachment.note && <p class="attachment-detail-note">{props.attachment.note}</p>}

      {isImage && <PreviewImage attachment={props.attachment} variant="original" />}
      {file && hasText && !isImage && <TextPreview attachment={props.attachment} onOpenExternal={props.onOpenExternal} />}
      {file && !hasText && !isImage && (
        <p class="attachment-binary-note">
          <Icon name={file.extractionState === "failed" ? "warning" : "file-text"} size={18} />
          <span><strong>Keine Textvorschau verfügbar</strong>{file.extractionError || `${file.mimeType} · ${readableSize(file.size)}`}</span>
        </p>
      )}
      {file && (
        <button class="secondary-button attachment-open-file" type="button" onClick={() => void props.onOpenFile(props.attachment.id)}>
          <Icon name="external" size={15} /> Im Standardprogramm öffnen
        </button>
      )}

      {link && (
        <>
          <article class={`link-metadata-card link-metadata-card--${link.previewState}`}>
            {link.hasPreviewImage && <PreviewImage attachment={props.attachment} variant="link_image" />}
            <div>
              <span class="link-site"><Icon name="globe" size={13} />{link.previewSiteName || link.host}</span>
              <h3>{link.previewTitle || props.attachment.title}</h3>
              {link.previewDescription && <p>{link.previewDescription}</p>}
              {link.previewState === "pending" && <p><span class="mini-spinner" /> Vorschau wird geladen …</p>}
              {link.previewState === "unauthorized" && <p>Anmeldung erforderlich. Öffne die Live-Ansicht und erneuere danach die Vorschau.</p>}
              {link.previewState === "blocked" && <p>Diese Adresse ist nicht erreichbar.</p>}
              {link.previewState === "failed" && <p>Für diesen Link ist keine Vorschau verfügbar.</p>}
              <button type="button" onClick={() => props.onOpenExternal(link.url)}><Icon name="external" size={13} />Im Browser öffnen</button>
            </div>
          </article>
          {!props.live ? (
            <button class="secondary-button attachment-live-button" type="button" onClick={() => props.onLiveToggle?.(true)}>
              <Icon name="globe" size={15} /> Live-Ansicht öffnen
            </button>
          ) : (
            <LinkPreviewSurface
              attachmentId={props.attachment.id}
              host={link.host}
              url={link.url}
              onOpenExternal={props.onOpenExternal}
              onClose={() => props.onLiveToggle?.(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
