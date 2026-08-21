import { useEffect, useState } from "react";

import { Icon } from "../../components/Icon";
import type { ContextAttachment } from "../../types";
import { LinkPreviewSurface } from "./LinkPreviewSurface";

type AttachmentDetailProps = {
  attachment: ContextAttachment;
  onBack: () => void;
  onOpenExternal: (url: string) => void;
  onOpenFile: (attachmentId: string) => Promise<void>;
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
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
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
    return () => {
      current = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.file?.mimeType, variant]);

  if (failed) return null;
  return url
    ? <img className="attachment-detail-image" src={url} alt={`Vorschau von ${attachment.title}`} />
    : <div className="attachment-preview-loading"><span className="mini-spinner" />Vorschau wird geladen …</div>;
}

function TextPreview({ attachment }: { attachment: ContextAttachment }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setText(null);
    setError(null);
    window.gemUi.contextAttachments.getBytes({ attachmentId: attachment.id, variant: "text_excerpt" })
      .then((bytes) => current && setText(bytesToText(bytes)))
      .catch((reason) => current && setError(reason instanceof Error ? reason.message : "Text ist nicht verfügbar."));
    return () => { current = false; };
  }, [attachment.id]);

  if (error) return <p className="attachment-detail-error"><Icon name="warning" size={15} />{error}</p>;
  if (text === null) return <div className="attachment-preview-loading"><span className="mini-spinner" />Text wird geladen …</div>;
  return (
    <section className="attachment-text-preview">
      <header>
        <span>{text.length.toLocaleString("de-DE")} Zeichen Vorschau</span>
        <button type="button" onClick={() => void navigator.clipboard.writeText(text)}><Icon name="copy" size={13} />Kopieren</button>
      </header>
      <pre>{text || "Diese Datei enthält keinen auslesbaren Text."}</pre>
    </section>
  );
}

export function AttachmentDetail({
  attachment,
  onBack,
  onOpenExternal,
  onOpenFile,
}: AttachmentDetailProps) {
  const [live, setLive] = useState(false);

  useEffect(() => {
    setLive(false);
    void window.gemUi.linkPreview.close();
  }, [attachment.id]);

  const file = attachment.file;
  const link = attachment.link;
  const isImage = Boolean(file?.mimeType.startsWith("image/") && file.renderable);
  const hasText = Boolean(file && ["ready", "empty"].includes(file.extractionState));

  return (
    <div className="attachment-detail">
      <header className="attachment-detail-header">
        <button type="button" onClick={onBack} aria-label="Zurück zur Anhangsliste"><Icon name="arrow-left" size={17} /></button>
        <span className="attachment-detail-kind"><Icon name={attachment.kind === "link" ? "link" : isImage ? "image" : "file-text"} size={17} /></span>
        <div><strong>{attachment.title}</strong><span>{attachment.scope === "project" ? "Projektanhang" : "Sessionanhang"}</span></div>
      </header>

      {attachment.note && <p className="attachment-detail-note">{attachment.note}</p>}

      {isImage && <PreviewImage attachment={attachment} variant="original" />}
      {file && hasText && !isImage && <TextPreview attachment={attachment} />}
      {file && !hasText && !isImage && (
        <p className="attachment-binary-note">
          <Icon name={file.extractionState === "failed" ? "warning" : "file-text"} size={18} />
          <span><strong>Keine Textvorschau verfügbar</strong>{file.extractionError || `${file.mimeType} · ${readableSize(file.size)}`}</span>
        </p>
      )}
      {file && (
        <button className="secondary-button attachment-open-file" type="button" onClick={() => void onOpenFile(attachment.id)}>
          <Icon name="external" size={15} /> Im Standardprogramm öffnen
        </button>
      )}

      {link && (
        <>
          <article className={`link-metadata-card link-metadata-card--${link.previewState}`}>
            {link.hasPreviewImage && <PreviewImage attachment={attachment} variant="link_image" />}
            <div>
              <span className="link-site"><Icon name="globe" size={13} />{link.previewSiteName || link.host}</span>
              <h3>{link.previewTitle || attachment.title}</h3>
              {link.previewDescription && <p>{link.previewDescription}</p>}
              {link.previewState === "pending" && <p><span className="mini-spinner" /> Vorschau wird geladen …</p>}
              {link.previewState === "unauthorized" && <p>Anmeldung erforderlich. Öffne die Live-Ansicht und erneuere danach die Vorschau.</p>}
              {link.previewState === "blocked" && <p>Diese Adresse ist nicht erreichbar.</p>}
              {link.previewState === "failed" && <p>Für diesen Link ist keine Vorschau verfügbar.</p>}
              <button type="button" onClick={() => onOpenExternal(link.url)}><Icon name="external" size={13} />Im Browser öffnen</button>
            </div>
          </article>
          {!live ? (
            <button className="secondary-button attachment-live-button" type="button" onClick={() => setLive(true)}>
              <Icon name="globe" size={15} /> Live-Ansicht öffnen
            </button>
          ) : (
            <LinkPreviewSurface
              attachmentId={attachment.id}
              host={link.host}
              url={link.url}
              onOpenExternal={onOpenExternal}
              onClose={() => setLive(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
