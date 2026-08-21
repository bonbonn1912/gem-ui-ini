import { Icon } from "../../components/Icon";
import type { ContextAttachment } from "../../types";

type AttachmentRowProps = {
  attachment: ContextAttachment;
  sessionId: string | null;
  selected: boolean;
  onSelect: () => void;
  onToggle: (attachment: ContextAttachment, included: boolean) => Promise<void>;
  onUpdate: (attachment: ContextAttachment, patch: {
    title?: string;
    note?: string | null;
    scope?: "project" | "session";
    sessionId?: string | null;
  }) => Promise<void>;
  onRemove: (attachment: ContextAttachment) => Promise<void>;
  onRefresh: (attachment: ContextAttachment) => Promise<void>;
  onOpenExternal: (url: string) => void;
  onOpenFile: (attachmentId: string) => Promise<void>;
};

function readableSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function processingLabel(attachment: ContextAttachment): string | null {
  if (attachment.file && ["pending", "running"].includes(attachment.file.extractionState)) return "Text wird ausgelesen …";
  if (attachment.link?.previewState === "pending") return "Vorschau wird geladen …";
  return null;
}

function cannotInclude(attachment: ContextAttachment): string | null {
  const state = attachment.file?.extractionState;
  if (state === "failed") return attachment.file?.extractionError || "Die Textextraktion ist fehlgeschlagen.";
  if (state === "too_large") return "Die Datei überschreitet die erlaubte Größe.";
  return null;
}

export function AttachmentRow({
  attachment,
  sessionId,
  selected,
  onSelect,
  onToggle,
  onUpdate,
  onRemove,
  onRefresh,
  onOpenExternal,
  onOpenFile,
}: AttachmentRowProps) {
  const processing = processingLabel(attachment);
  const disabledReason = !sessionId ? "Die Kontextauswahl gilt pro Session." : cannotInclude(attachment);
  const meta = attachment.file
    ? `${readableSize(attachment.file.size)} · ${attachment.file.mimeType}`
    : attachment.link?.host ?? "Link";
  const icon = attachment.kind === "link"
    ? "link"
    : attachment.file?.mimeType.startsWith("image/")
      ? "image"
      : "file-text";

  const rename = async () => {
    const title = window.prompt("Titel des Anhangs", attachment.title)?.trim();
    if (title && title !== attachment.title) await onUpdate(attachment, { title });
  };
  const editNote = async () => {
    const note = window.prompt("Notiz zum Anhang", attachment.note ?? "");
    if (note !== null && note.trim() !== (attachment.note ?? "")) {
      await onUpdate(attachment, { note: note.trim() || null });
    }
  };
  const move = async () => {
    if (!sessionId) return;
    if (attachment.scope === "project") {
      await onUpdate(attachment, { scope: "session", sessionId });
    } else {
      await onUpdate(attachment, { scope: "project", sessionId: null });
    }
  };
  const remove = async () => {
    if (window.confirm(`„${attachment.title}“ aus GeminUI entfernen?`)) await onRemove(attachment);
  };

  return (
    <article className={`context-attachment-row ${selected ? "context-attachment-row--selected" : ""}`}>
      <label className="context-attachment-check" title={disabledReason ?? "Im Kontext verwenden"}>
        <input
          type="checkbox"
          checked={attachment.includedInContext}
          disabled={Boolean(disabledReason)}
          onChange={(event) => void onToggle(attachment, event.target.checked)}
          aria-label={`${attachment.title} ${attachment.includedInContext ? "aus dem Kontext entfernen" : "in den Kontext aufnehmen"}`}
        />
      </label>
      <button className="context-attachment-main" type="button" onClick={onSelect}>
        <span className={`context-attachment-type context-attachment-type--${attachment.kind}`}><Icon name={icon} size={17} /></span>
        <span className="context-attachment-copy">
          <strong>{attachment.title}</strong>
          <small>{processing ? <><span className="mini-spinner" />{processing}</> : meta}</small>
        </span>
        {attachment.estimatedTokens !== null && <span className="context-attachment-tokens">~{attachment.estimatedTokens.toLocaleString("de-DE")}</span>}
        {disabledReason && attachment.file?.extractionState === "failed" && <span title={disabledReason}><Icon name="warning" size={15} /></span>}
      </button>
      <details className="context-attachment-menu">
        <summary aria-label={`Aktionen für ${attachment.title}`}><Icon name="more" size={16} /></summary>
        <div>
          <button type="button" onClick={() => void rename()}>Umbenennen</button>
          <button type="button" onClick={() => void editNote()}>Notiz bearbeiten</button>
          <button type="button" disabled={!sessionId} onClick={() => void move()}>{attachment.scope === "project" ? "In diese Session verschieben" : "Ins Projekt verschieben"}</button>
          {attachment.link && <button type="button" onClick={() => void onRefresh(attachment)}>Vorschau erneuern</button>}
          {attachment.link && <button type="button" onClick={() => onOpenExternal(attachment.link!.url)}>Im Browser öffnen</button>}
          {attachment.file && <button type="button" onClick={() => void onOpenFile(attachment.id)}>Im Standardprogramm öffnen</button>}
          <button className="danger-menu-item" type="button" onClick={() => void remove()}><Icon name="trash" size={13} />Entfernen</button>
        </div>
      </details>
    </article>
  );
}
