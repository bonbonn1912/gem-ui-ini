import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { Icon } from "../../components/Icon";
import type {
  Attachment,
  PreparedExternalContext,
  ProjectFileSearchEntry,
} from "../../types";
import type { TurnPhase } from "../chat/reducer";
import { createClientRequestId } from "../../utils/client-request-id";

export type ComposerAttachment = Attachment & { previewUrl: string };

/**
 * Text handed to the composer from somewhere else — a todo, a review thread.
 * The token is what makes a repeated insert of the same text visible; the text
 * alone would look unchanged to an effect.
 */
export type ComposerDraft = {
  token: number;
  text: string;
};

type ComposerProps = {
  sessionId: string;
  projectId: string;
  rootRevision: number;
  phase: TurnPhase;
  imagesSupported: boolean;
  contextAttachmentCount: number;
  contextEstimatedTokens: number;
  contextOverBudget: boolean;
  disabled?: boolean;
  draft?: ComposerDraft | null;
  externalContexts?: PreparedExternalContext[];
  onDraftApplied?: () => void;
  onRemoveExternalContext?: (refId: string) => void;
  onOpenContextAttachments: () => void;
  onSend: (
    text: string,
    attachments: ComposerAttachment[],
    projectFiles: ProjectFileSearchEntry[],
  ) => Promise<void>;
  onCancel: () => Promise<void>;
  onError: (message: string) => void;
};

type ActiveFileMention = {
  start: number;
  end: number;
  query: string;
};

const PROJECT_FILE_MENU_ID = "composer-project-file-menu";
const MAX_PROJECT_FILE_REFERENCES = 10;

function activeFileMention(text: string, caret: number): ActiveFileMention | null {
  const prefix = text.slice(0, caret);
  const start = prefix.lastIndexOf("@");
  if (start < 0) return null;

  const preceding = start > 0 ? prefix[start - 1] : "";
  if (preceding && !/[\s([{]/.test(preceding)) return null;

  const query = prefix.slice(start + 1);
  if (query.length > 200 || /\s/.test(query)) return null;
  return { start, end: caret, query };
}

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
  projectId,
  rootRevision,
  phase,
  imagesSupported,
  contextAttachmentCount,
  contextEstimatedTokens,
  contextOverBudget,
  disabled = false,
  draft = null,
  externalContexts = [],
  onDraftApplied,
  onRemoveExternalContext,
  onOpenContextAttachments,
  onSend,
  onCancel,
  onError,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFileSearchEntry[]>([]);
  const [fileSuggestions, setFileSuggestions] = useState<ProjectFileSearchEntry[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [caretPosition, setCaretPosition] = useState(0);
  const [dismissedMention, setDismissedMention] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);
  const fileSearchSequence = useRef(0);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const running = ["running", "awaiting_permission", "cancelling"].includes(phase);
  const canSend = !disabled && !contextOverBudget && !running && !sending && !staging
    && Boolean(text.trim() || attachments.length || projectFiles.length || externalContexts.length);
  const mention = activeFileMention(text, caretPosition);
  const mentionKey = mention ? `${mention.start}:${mention.end}:${mention.query}` : null;
  const fileMenuOpen = Boolean(mention && mentionKey !== dismissedMention && !disabled);

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

    // Alles, was in den Chat gezogen wird, wird dauerhaft als Session-Anhang
    // gesichert — Dokumente ebenso wie Bilder. Der Anhänge-Reiter „Diese
    // Session" zeigt es danach unter „Aus dem Chat".
    void window.gemUi.contextAttachments
      .addDroppedFiles(
        files,
        { projectId, scope: "session", sessionId },
        { origin: "chat" },
      )
      .catch((error) =>
        onError(
          error instanceof Error
            ? error.message
            : "Die Datei konnte nicht als Session-Anhang gespeichert werden.",
        ),
      );

    // Bilder gehen zusätzlich als Anhang dieses Turns an Gemini.
    const images = files.filter((file) => isSupportedImageMime(file.type));
    if (images.length > 0) {
      void addStaged(() => window.gemUi.attachments.stageDroppedFiles(images, sessionId));
    }
  }, [addStaged, onError, projectId, sessionId]);

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

  // A handed-over draft is appended, never substituted: whatever the user has
  // already typed is theirs, and silently replacing it would lose work.
  useEffect(() => {
    if (!draft) return;
    setText((current) => {
      const trimmed = current.trimEnd();
      return trimmed ? `${trimmed}\n\n${draft.text}` : draft.text;
    });
    onDraftApplied?.();
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      window.requestAnimationFrame(() => {
        textarea.selectionStart = textarea.value.length;
        textarea.selectionEnd = textarea.value.length;
      });
    }
  }, [draft?.token]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 190)}px`;
  }, [text]);

  useEffect(() => {
    const sequence = ++fileSearchSequence.current;
    if (!mention || !fileMenuOpen || mention.query.length === 0) {
      setFileSuggestions([]);
      setFileSearchLoading(false);
      setFileSearchError(null);
      setActiveSuggestion(-1);
      return;
    }

    setFileSearchLoading(true);
    setFileSearchError(null);
    const timer = window.setTimeout(() => {
      void window.gemUi.projectFiles.search({
        projectId,
        expectedRootRevision: rootRevision,
        query: mention.query,
        limit: 10,
      }).then((result) => {
        if (fileSearchSequence.current !== sequence) return;
        setFileSuggestions(result.entries);
        setActiveSuggestion(result.entries.findIndex((entry) => entry.contextEligible));
      }).catch((error: unknown) => {
        if (fileSearchSequence.current !== sequence) return;
        setFileSuggestions([]);
        setActiveSuggestion(-1);
        setFileSearchError(error instanceof Error ? error.message : "Projektdateien konnten nicht durchsucht werden.");
      }).finally(() => {
        if (fileSearchSequence.current === sequence) setFileSearchLoading(false);
      });
    }, 120);

    return () => window.clearTimeout(timer);
  }, [disabled, fileMenuOpen, mention?.query, projectId, rootRevision]);

  const removeAttachment = async (attachment: ComposerAttachment) => {
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    URL.revokeObjectURL(attachment.previewUrl);
    try {
      await window.gemUi.attachments.remove({ attachmentId: attachment.id, clientRequestId: createClientRequestId() });
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const selectProjectFile = (entry: ProjectFileSearchEntry) => {
    const currentMention = activeFileMention(text, caretPosition);
    if (!currentMention || !entry.contextEligible) return;
    if (!projectFiles.some((item) => item.rootId === entry.rootId && item.relativePath === entry.relativePath)) {
      if (projectFiles.length >= MAX_PROJECT_FILE_REFERENCES) {
        onError(`Pro Nachricht können höchstens ${MAX_PROJECT_FILE_REFERENCES} Projektdateien referenziert werden.`);
        return;
      }
      setProjectFiles((current) => [...current, entry]);
    }

    const referenceText = `@${entry.relativePath}`;
    const nextText = `${text.slice(0, currentMention.start)}${referenceText} ${text.slice(currentMention.end)}`;
    const nextCaret = currentMention.start + referenceText.length + 1;
    setText(nextText);
    setCaretPosition(nextCaret);
    setDismissedMention(null);
    setFileSuggestions([]);
    setActiveSuggestion(-1);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const moveSuggestion = (direction: 1 | -1) => {
    const selectable = fileSuggestions
      .map((entry, index) => entry.contextEligible ? index : -1)
      .filter((index) => index >= 0);
    if (!selectable.length) return;
    const position = selectable.indexOf(activeSuggestion);
    const nextPosition = position < 0
      ? (direction === 1 ? 0 : selectable.length - 1)
      : (position + direction + selectable.length) % selectable.length;
    setActiveSuggestion(selectable[nextPosition]);
  };

  const submit = async () => {
    if (!canSend) return;
    const submittedText = text.trim();
    const submittedAttachments = attachments;
    const submittedProjectFiles = projectFiles;
    setSending(true);
    try {
      await onSend(submittedText, submittedAttachments, submittedProjectFiles);
      setText("");
      setAttachments([]);
      setProjectFiles([]);
      setFileSuggestions([]);
      setCaretPosition(0);
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
    if (fileMenuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSuggestion(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedMention(mentionKey);
        setFileSuggestions([]);
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey && !event.nativeEvent.isComposing) {
        const entry = fileSuggestions[activeSuggestion];
        if (entry?.contextEligible) {
          event.preventDefault();
          selectProjectFile(entry);
          return;
        }
        event.preventDefault();
        return;
      }
    }
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
          {fileMenuOpen && (
            <div className="project-file-menu" id={PROJECT_FILE_MENU_ID} role="listbox" aria-label="Projektdateien">
              <header>
                <span><Icon name="file-text" size={14} /> Projektdateien</span>
                <span><kbd>↑</kbd><kbd>↓</kbd> wählen · <kbd>Tab</kbd>/<kbd>Enter</kbd> übernehmen</span>
              </header>
              <div className="project-file-menu-list">
                {fileSearchLoading && fileSuggestions.length === 0 && (
                  <div className="project-file-menu-state"><span className="mini-spinner" /> Dateien werden gesucht …</div>
                )}
                {!fileSearchLoading && fileSearchError && (
                  <div className="project-file-menu-state project-file-menu-state--error"><Icon name="warning" size={14} /> {fileSearchError}</div>
                )}
                {!fileSearchLoading && !fileSearchError && fileSuggestions.length === 0 && (
                  <div className="project-file-menu-state">
                    {mention?.query ? "Keine passende Projektdatei gefunden." : "Tippe den ersten Buchstaben des Dateinamens oder Pfads."}
                  </div>
                )}
                {fileSuggestions.map((entry, index) => (
                  <button
                    className={`project-file-option ${index === activeSuggestion ? "project-file-option--active" : ""}`}
                    id={`${PROJECT_FILE_MENU_ID}-${index}`}
                    key={`${entry.rootId}:${entry.relativePath}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeSuggestion}
                    aria-disabled={!entry.contextEligible}
                    title={entry.contextUnavailableReason ?? `${entry.rootLabel}/${entry.relativePath}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectProjectFile(entry);
                    }}
                    onMouseEnter={() => {
                      if (entry.contextEligible) setActiveSuggestion(index);
                    }}
                  >
                    <span className="project-file-option-icon"><Icon name="file-text" size={14} /></span>
                    <span className="project-file-option-copy">
                      <strong>{entry.displayName}</strong>
                      <small><span>{entry.rootLabel}</span>{entry.relativePath}</small>
                    </span>
                    <span className="project-file-option-size">{entry.contextEligible ? readableSize(entry.size) : "Nicht lesbar"}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {externalContexts.length > 0 && (
            <div className="external-context-strip" aria-label="Vorbereiteter Reviewkontext">
              {externalContexts.map((context) => (
                <span className="external-context-chip" key={context.ref.id} title={context.mergeRequestReference}>
                  <Icon name="gitlab" size={12} />
                  <strong>{context.title}</strong>
                  <small>
                    {context.filePath ?? context.repositoryLabel} · gültig bis{" "}
                    {new Date(context.expiresAt).toLocaleTimeString("de-DE", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </small>
                  {onRemoveExternalContext && (
                    <button
                      type="button"
                      onClick={() => onRemoveExternalContext(context.ref.id)}
                      aria-label={`${context.title} aus dem Entwurf entfernen`}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {projectFiles.length > 0 && (
            <div className="project-file-reference-strip" aria-label="Referenzierte Projektdateien">
              {projectFiles.map((entry) => (
                <span className="project-file-reference" key={`${entry.rootId}:${entry.relativePath}`} title={`${entry.rootLabel}/${entry.relativePath}`}>
                  <Icon name="file-text" size={12} />
                  <strong>{entry.displayName}</strong>
                  <small>{entry.rootLabel}</small>
                  <button
                    type="button"
                    onClick={() => setProjectFiles((current) => current.filter((item) => item.rootId !== entry.rootId || item.relativePath !== entry.relativePath))}
                    aria-label={`${entry.displayName} aus dem Kontext entfernen`}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
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
            onChange={(event) => {
              setText(event.target.value);
              setCaretPosition(event.target.selectionStart ?? event.target.value.length);
              setDismissedMention(null);
            }}
            onClick={(event) => setCaretPosition(event.currentTarget.selectionStart ?? text.length)}
            onSelect={(event) => setCaretPosition(event.currentTarget.selectionStart ?? text.length)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={running ? "Nächste Nachricht vorbereiten …" : "Nachricht an Gemini …"}
            aria-label="Nachricht an Gemini"
            aria-describedby={running ? "composer-running-status" : undefined}
            aria-autocomplete="list"
            aria-controls={fileMenuOpen ? PROJECT_FILE_MENU_ID : undefined}
            aria-expanded={fileMenuOpen}
            aria-activedescendant={fileMenuOpen && activeSuggestion >= 0 ? `${PROJECT_FILE_MENU_ID}-${activeSuggestion}` : undefined}
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
            {contextAttachmentCount > 0 && (
              <button
                className={`composer-context-attachments ${contextOverBudget ? "composer-context-attachments--warning" : ""}`}
                type="button"
                onClick={onOpenContextAttachments}
                title={contextOverBudget ? "Der ausgewählte Anhangskontext überschreitet das Limit. Wähle Anhänge ab, bevor du sendest." : "Anhänge im Kontext anzeigen"}
              >
                <Icon name={contextOverBudget ? "warning" : "paperclip"} size={14} />
                {contextAttachmentCount} {contextAttachmentCount === 1 ? "Anhang" : "Anhänge"} im Kontext · ~{contextEstimatedTokens.toLocaleString("de-DE")} Token
              </button>
            )}
            {running ? (
              <button className="stop-button" type="button" onClick={() => void stop()} disabled={stopping || phase === "cancelling"} aria-label="Antwort stoppen">
                {stopping || phase === "cancelling" ? <span className="mini-spinner" /> : <Icon name="stop" size={16} />}
                <span>Stoppen</span>
              </button>
            ) : (
              <button
                className="send-button"
                type="button"
                disabled={!canSend}
                onClick={() => void submit()}
                aria-label="Nachricht senden"
                title={contextOverBudget ? "Der ausgewählte Anhangskontext überschreitet das Limit. Wähle zuerst Anhänge ab." : undefined}
              >
                {sending ? <span className="mini-spinner" /> : <Icon name="arrow-up" size={19} />}
              </button>
            )}
          </div>
        </div>
        <p className="composer-hint"><kbd>@</kbd> für Projektdateien · Enter zum Senden · Shift + Enter für neue Zeile</p>
      </div>
    </>
  );
}
