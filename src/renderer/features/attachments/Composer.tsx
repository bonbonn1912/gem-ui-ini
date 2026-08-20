import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { Icon } from "../../components/Icon";
import type { Attachment } from "../../types";
import type { TurnPhase } from "../chat/reducer";
import { createClientRequestId } from "../../utils/client-request-id";

export type ComposerAttachment = Attachment & { previewUrl: string };

type ComposerProps = {
  sessionId: string;
  phase: TurnPhase;
  imagesSupported: boolean;
  disabled?: boolean;
  onSend: (text: string, attachments: ComposerAttachment[]) => Promise<void>;
  onCancel: () => Promise<void>;
  onError: (message: string) => void;
};

function readableSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Das Bild konnte nicht angehängt werden.";
}

const SUPPORTED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

function isSupportedImageMime(value: string): value is Attachment["mimeType"] {
  return (SUPPORTED_IMAGE_MIMES as readonly string[]).includes(value);
}

export function Composer({
  sessionId,
  phase,
  imagesSupported,
  disabled = false,
  onSend,
  onCancel,
  onError,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [staging, setStaging] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const running = ["running", "awaiting_permission", "cancelling"].includes(phase);
  const canSend = !disabled && !running && !sending && !staging && Boolean(text.trim() || attachments.length);

  const hydrate = useCallback(async (staged: Attachment[]): Promise<ComposerAttachment[]> => {
    return Promise.all(
      staged.map(async (attachment) => {
        const bytes = await window.gemUi.attachments.getPreviewBytes({ attachmentId: attachment.id });
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const previewUrl = URL.createObjectURL(new Blob([copy.buffer], { type: attachment.mimeType }));
        return { ...attachment, previewUrl };
      }),
    );
  }, []);

  const addStaged = useCallback(async (operation: () => Promise<Attachment[]>) => {
    if (!imagesSupported) {
      onError("Die installierte Gemini-Version unterstützt keine Bilder über ACP.");
      return;
    }
    setStaging(true);
    try {
      const staged = await operation();
      const hydrated = await hydrate(staged);
      setAttachments((current) => [...current, ...hydrated]);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setStaging(false);
    }
  }, [hydrate, imagesSupported, onError]);

  const addFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    void addStaged(() => window.gemUi.attachments.stageDroppedFiles(files, sessionId));
  }, [addStaged, sessionId]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(Array.from(event.dataTransfer?.files ?? []));
    };

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [addFiles]);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 190)}px`;
  }, [text]);

  const removeAttachment = async (attachment: ComposerAttachment) => {
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    URL.revokeObjectURL(attachment.previewUrl);
    try {
      await window.gemUi.attachments.remove({ attachmentId: attachment.id, clientRequestId: createClientRequestId() });
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const submit = async () => {
    if (!canSend) return;
    const submittedText = text.trim();
    const submittedAttachments = attachments;
    setSending(true);
    try {
      await onSend(submittedText, submittedAttachments);
      setText("");
      setAttachments([]);
      for (const attachment of submittedAttachments) URL.revokeObjectURL(attachment.previewUrl);
      textareaRef.current?.focus();
    } catch {
      // The parent presents the validated desktop error and keeps this draft retryable.
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (stopping || phase === "cancelling") return;
    setStopping(true);
    try {
      await onCancel();
    } catch {
      // The parent surfaces the error; keep the composer usable for another attempt.
    } finally {
      setStopping(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!imagesSupported) return;
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && isSupportedImageMime(item.type))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!images.length) return;
    event.preventDefault();
    setStaging(true);
    void Promise.all(
      images.map(async (file) => window.gemUi.attachments.stageClipboardImage({
        clientRequestId: createClientRequestId(),
        sessionId,
        displayName: file.name || `Zwischenablage-${Date.now()}.png`,
        mimeType: isSupportedImageMime(file.type) ? file.type : "image/png",
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    )
      .then(hydrate)
      .then((staged) => setAttachments((current) => [...current, ...staged]))
      .catch((error) => onError(errorMessage(error)))
      .finally(() => setStaging(false));
  };

  return (
    <>
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div><Icon name="image" size={28} /><strong>Bilder hier ablegen</strong><span>PNG, JPEG, WebP oder GIF</span></div>
        </div>
      )}
      <div className="composer-area">
        <div className={`composer ${running ? "composer--running" : ""}`}>
          {attachments.length > 0 && (
            <div className="attachment-strip" aria-label="Angehängte Bilder">
              {attachments.map((attachment) => (
                <figure className="attachment-chip" key={attachment.id}>
                  <img src={attachment.previewUrl} alt="" />
                  <figcaption><strong>{attachment.displayName}</strong><span>{readableSize(attachment.size)}</span></figcaption>
                  <button type="button" onClick={() => void removeAttachment(attachment)} aria-label={`${attachment.displayName} entfernen`}>
                    <Icon name="x" size={13} />
                  </button>
                </figure>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={running ? "Nächste Nachricht vorbereiten …" : "Nachricht an Gemini …"}
            aria-label="Nachricht an Gemini"
            aria-describedby={running ? "composer-running-status" : undefined}
            disabled={disabled}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <button
                className="composer-icon-button"
                type="button"
                disabled={!imagesSupported || disabled || staging}
                onClick={() => void addStaged(() => window.gemUi.attachments.pickImages({ sessionId, clientRequestId: createClientRequestId() }))}
                aria-label="Bilder anhängen"
                title={imagesSupported ? "Bilder anhängen" : "Bilder werden von dieser Gemini-Version nicht unterstützt"}
              >
                {staging ? <span className="mini-spinner" /> : <Icon name="paperclip" size={19} />}
              </button>
              <span className="composer-context" id={running ? "composer-running-status" : undefined}>
                <span className={`context-dot ${running ? "context-dot--working" : ""}`} />
                {running ? "Antwort läuft · Entwurf bleibt erhalten" : "Kontext: alle Projektordner"}
              </span>
            </div>
            {running ? (
              <button className="stop-button" type="button" onClick={() => void stop()} disabled={stopping || phase === "cancelling"} aria-label="Antwort stoppen">
                {stopping || phase === "cancelling" ? <span className="mini-spinner" /> : <Icon name="stop" size={16} />}
                <span>Stoppen</span>
              </button>
            ) : (
              <button className="send-button" type="button" disabled={!canSend} onClick={() => void submit()} aria-label="Nachricht senden">
                {sending ? <span className="mini-spinner" /> : <Icon name="arrow-up" size={19} />}
              </button>
            )}
          </div>
        </div>
        <p className="composer-hint">Enter zum Senden · Shift + Enter für neue Zeile</p>
      </div>
    </>
  );
}
