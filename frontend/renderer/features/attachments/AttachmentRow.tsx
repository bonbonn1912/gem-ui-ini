import { Icon } from "../../components/Icon";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
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

export function AttachmentRow(props: AttachmentRowProps) {
  const menuRef = useDismissOnOutsideClick<HTMLDetailsElement>();
  const processing = processingLabel(props.attachment);
  const disabledReason = !props.sessionId ? "Die Kontextauswahl gilt pro Session." : cannotInclude(props.attachment);
  const meta = props.attachment.file
    ? `${readableSize(props.attachment.file.size)} · ${props.attachment.file.mimeType}`
    : props.attachment.link?.host ?? "Link";
  const icon = props.attachment.kind === "link"
    ? "link"
    : props.attachment.file?.mimeType.startsWith("image/")
      ? "image"
      : "file-text";

  const rename = async () => {
    const title = window.prompt("Titel des Anhangs", props.attachment.title)?.trim();
    if (title && title !== props.attachment.title) await props.onUpdate(props.attachment, { title });
  };
  const editNote = async () => {
    const note = window.prompt("Notiz zum Anhang", props.attachment.note ?? "");
    if (note !== null && note.trim() !== (props.attachment.note ?? "")) {
      await props.onUpdate(props.attachment, { note: note.trim() || null });
    }
  };
  const move = async () => {
    if (!props.sessionId) return;
    if (props.attachment.scope === "project") {
      await props.onUpdate(props.attachment, { scope: "session", sessionId: props.sessionId });
    } else {
      await props.onUpdate(props.attachment, { scope: "project", sessionId: null });
    }
  };
  const remove = async () => {
    if (window.confirm(`„${props.attachment.title}“ aus GeminUI entfernen?`)) await props.onRemove(props.attachment);
  };

  return (
    <article class={`context-attachment-row ${props.selected ? "context-attachment-row--selected" : ""}`}>
      <label class="context-attachment-check" title={disabledReason ?? "Im Kontext verwenden"}>
        <input
          type="checkbox"
          checked={props.attachment.includedInContext}
          disabled={Boolean(disabledReason)}
          onChange={(event) => void props.onToggle(props.attachment, event.currentTarget.checked)}
          aria-label={`${props.attachment.title} ${props.attachment.includedInContext ? "aus dem Kontext entfernen" : "in den Kontext aufnehmen"}`}
        />
      </label>
      <button class="context-attachment-main" type="button" onClick={props.onSelect}>
        <span class={`context-attachment-type context-attachment-type--${props.attachment.kind}`}><Icon name={icon} size={17} /></span>
        <span class="context-attachment-copy">
          <strong>{props.attachment.title}</strong>
          <small>{processing ? <><span class="mini-spinner" />{processing}</> : meta}</small>
        </span>
        {props.attachment.estimatedTokens !== null && <span class="context-attachment-tokens">~{props.attachment.estimatedTokens.toLocaleString("de-DE")}</span>}
        {disabledReason && props.attachment.file?.extractionState === "failed" && <span title={disabledReason}><Icon name="warning" size={15} /></span>}
      </button>
      <details ref={menuRef} class="context-attachment-menu">
        <summary aria-label={`Aktionen für ${props.attachment.title}`}><Icon name="more" size={16} /></summary>
        <div>
          <button type="button" onClick={() => void rename()}>Umbenennen</button>
          <button type="button" onClick={() => void editNote()}>Notiz bearbeiten</button>
          <button type="button" disabled={!props.sessionId} onClick={() => void move()}>{props.attachment.scope === "project" ? "In diese Session verschieben" : "Ins Projekt verschieben"}</button>
          {props.attachment.link && <button type="button" onClick={() => void props.onRefresh(props.attachment)}>Vorschau erneuern</button>}
          {props.attachment.link && <button type="button" onClick={() => props.onOpenExternal(props.attachment.link!.url)}>Im Browser öffnen</button>}
          {props.attachment.file && <button type="button" onClick={() => void props.onOpenFile(props.attachment.id)}>Im Standardprogramm öffnen</button>}
          <button class="danger-menu-item" type="button" onClick={() => void remove()}><Icon name="trash" size={13} />Entfernen</button>
        </div>
      </details>
    </article>
  );
}
