import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  For,
} from "solid-js";
import { Icon } from "../../components/Icon";
import type {
  Attachment,
  PreparedExternalContext,
  ProjectFileSearchEntry,
} from "../../types";
import type { TurnPhase } from "../chat/reducer";
import { createClientRequestId } from "../../utils/client-request-id";
import { nativeFileDrop } from "../../native-file-drop";

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
  sessionMode?: string | null;
  hasPendingPlan?: boolean;
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

export function Composer(props: ComposerProps) {
  const [text, setText] = createSignal("");
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([]);
  const [projectFiles, setProjectFiles] = createSignal<ProjectFileSearchEntry[]>([]);
  const [fileSuggestions, setFileSuggestions] = createSignal<ProjectFileSearchEntry[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = createSignal(false);
  const [fileSearchError, setFileSearchError] = createSignal<string | null>(null);
  const [activeSuggestion, setActiveSuggestion] = createSignal(-1);
  const [caretPosition, setCaretPosition] = createSignal(0);
  const [dismissedMention, setDismissedMention] = createSignal<string | null>(null);
  const [staging, setStaging] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const [decisionDismissed, setDecisionDismissed] = createSignal(false);
  let textareaRef!: HTMLTextAreaElement;
  let dragDepth = 0;
  let fileSearchSequence = 0;
  let attachmentsRef = attachments();

  const running = createMemo(() => ["running", "awaiting_permission", "cancelling"].includes(props.phase));

  createEffect(() => {
    if (running()) {
      setDecisionDismissed(false);
    }
  });

  const canSend = createMemo(() => !props.disabled && !props.contextOverBudget && !running() && !sending() && !staging()
    && Boolean(text().trim() || attachments().length || projectFiles().length || (props.externalContexts?.length ?? 0)));
  const mention = createMemo(() => activeFileMention(text(), text().length));
  const mentionKey = createMemo(() => { const value = mention(); return value ? `${value.start}:${value.end}:${value.query}` : null; });
  const fileMenuOpen = createMemo(() => Boolean(mention() && mentionKey() !== dismissedMention() && !props.disabled));

  const hydrate = async (staged: Attachment[]): Promise<ComposerAttachment[]> => {
    return Promise.all(
      staged.map(async (attachment) => {
        const bytes = await window.gemUi.attachments.getPreviewBytes({ attachmentId: attachment.id });
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const previewUrl = URL.createObjectURL(new Blob([copy.buffer], { type: attachment.mimeType }));
        return { ...attachment, previewUrl };
      }),
    );
  };

  const addStaged = async (operation: () => Promise<Attachment[]>) => {
    if (!props.imagesSupported) {
      props.onError("Die installierte Gemini-Version unterstützt keine Bilder über ACP.");
      return;
    }
    setStaging(true);
    try {
      const staged = await operation();
      const hydrated = await hydrate(staged);
      setAttachments((current) => [...current, ...hydrated]);
    } catch (error) {
      props.onError(errorMessage(error));
    } finally {
      setStaging(false);
    }
  };

  const addFiles = (files: File[]) => {
    if (!files.length) return;

    // Alles, was in den Chat gezogen wird, wird dauerhaft als Session-Anhang
    // gesichert — Dokumente ebenso wie Bilder. Der Anhänge-Reiter „Diese
    // Session" zeigt es danach unter „Aus dem Chat".
    void window.gemUi.contextAttachments
      .addDroppedFiles(
        files,
        { projectId: props.projectId, scope: "session", sessionId: props.sessionId },
        { origin: "chat" },
      )
      .catch((error) =>
        props.onError(
          error instanceof Error
            ? error.message
            : "Die Datei konnte nicht als Session-Anhang gespeichert werden.",
        ),
      );

    // Bilder gehen zusätzlich als Anhang dieses Turns an Gemini.
    const images = files.filter((file) => isSupportedImageMime(file.type));
    if (images.length > 0) {
      void addStaged(() => window.gemUi.attachments.stageDroppedFiles(images, props.sessionId));
    }
  };

  // Tauri intercepts operating-system file drops before HTML5 drag events
  // reach the WebView. The native directive supplies absolute, path-backed
  // File objects while preserving the existing browser paste path.
  const nativeComposerDrop = {
    onActiveChange: setDragging,
    onDrop: addFiles,
  };

  createEffect(() => {
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setDragging(false);
      addFiles(Array.from(event.dataTransfer?.files ?? []));
    };

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    onCleanup(() => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    });
  });

  onCleanup(() => {
    for (const attachment of attachmentsRef) URL.revokeObjectURL(attachment.previewUrl);
  });

  // A handed-over draft is appended, never substituted: whatever the user has
  // already typed is theirs, and silently replacing it would lose work.
  createEffect(() => {
      if (!props.draft) return;
    setText((current) => {
      const trimmed = current.trimEnd();
      return trimmed ? `${trimmed}\n\n${props.draft!.text}` : props.draft!.text;
    });
    props.onDraftApplied?.();
    const textarea = textareaRef;
    if (textarea) {
      textarea.focus();
      window.requestAnimationFrame(() => {
        textarea.selectionStart = textarea.value.length;
        textarea.selectionEnd = textarea.value.length;
      });
    }
  });

  createEffect(() => {
    const textarea = textareaRef;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 190)}px`;
  });

  createEffect(() => {
    // Pre-warm project file index in memory as soon as @ menu opens
    if (fileMenuOpen() && props.projectId && props.rootRevision > 0) {
      void window.gemUi.projectFiles.search({
        projectId: props.projectId,
        expectedRootRevision: props.rootRevision,
        query: "a",
        limit: 1,
      }).catch(() => {
        // Pre-warm error ignored
      });
    }
  });

  createEffect(() => {
    const sequence = ++fileSearchSequence;
    if (!mention() || !fileMenuOpen() || mention()!.query.length === 0 || !props.projectId || props.rootRevision === 0) {
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
        projectId: props.projectId,
        expectedRootRevision: props.rootRevision,
        query: mention()!.query,
        limit: 10,
      }).then((result) => {
        if (fileSearchSequence !== sequence) return;
        setFileSuggestions(result.entries);
        setActiveSuggestion(result.entries.findIndex((entry) => entry.contextEligible));
      }).catch((error: unknown) => {
        if (fileSearchSequence !== sequence) return;
        setFileSuggestions([]);
        setActiveSuggestion(-1);
        setFileSearchError(error instanceof Error ? error.message : "Projektdateien konnten nicht durchsucht werden.");
      }).finally(() => {
        if (fileSearchSequence === sequence) setFileSearchLoading(false);
      });
    }, 25);

    onCleanup(() => window.clearTimeout(timer));
  });

  const removeAttachment = async (attachment: ComposerAttachment) => {
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    URL.revokeObjectURL(attachment.previewUrl);
    try {
      await window.gemUi.attachments.remove({ attachmentId: attachment.id, clientRequestId: createClientRequestId() });
    } catch (error) {
        props.onError(errorMessage(error));
    }
  };

  const selectProjectFile = (entry: ProjectFileSearchEntry) => {
    const currentMention = activeFileMention(text(), caretPosition());
    if (!currentMention || !entry.contextEligible) return;
    if (!projectFiles().some((item) => item.rootId === entry.rootId && item.relativePath === entry.relativePath)) {
      if (projectFiles().length >= MAX_PROJECT_FILE_REFERENCES) {
        props.onError(`Pro Nachricht können höchstens ${MAX_PROJECT_FILE_REFERENCES} Projektdateien referenziert werden.`);
        return;
      }
      setProjectFiles((current) => [...current, entry]);
    }

    const referenceText = `@${entry.relativePath}`;
    const nextText = `${text().slice(0, currentMention.start)}${referenceText} ${text().slice(currentMention.end)}`;
    const nextCaret = currentMention.start + referenceText.length + 1;
    setText(nextText);
    setCaretPosition(nextCaret);
    setDismissedMention(null);
    setFileSuggestions([]);
    setActiveSuggestion(-1);
    window.requestAnimationFrame(() => {
      textareaRef?.focus();
      textareaRef?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const moveSuggestion = (direction: 1 | -1) => {
    const selectable = fileSuggestions()
      .map((entry, index) => entry.contextEligible ? index : -1)
      .filter((index) => index >= 0);
    if (!selectable.length) return;
    const position = selectable.indexOf(activeSuggestion());
    const nextPosition = position < 0
      ? (direction === 1 ? 0 : selectable.length - 1)
      : (position + direction + selectable.length) % selectable.length;
    setActiveSuggestion(selectable[nextPosition]);
  };

  const submit = async () => {
    if (!canSend()) return;
    const submittedText = text().trim();
    const submittedAttachments = attachments();
    const submittedProjectFiles = projectFiles();
    setSending(true);
    try {
      await props.onSend(submittedText, submittedAttachments, submittedProjectFiles);
      setText("");
      setAttachments([]);
      setProjectFiles([]);
      setFileSuggestions([]);
      setCaretPosition(0);
      for (const attachment of submittedAttachments) URL.revokeObjectURL(attachment.previewUrl);
      textareaRef?.focus();
    } catch {
      // The parent presents the validated desktop error and keeps this draft retryable.
    } finally {
      setSending(false);
    }
  };

  const isPlanMode = createMemo(() => props.sessionMode === "plan");
  const showPlanDecision = createMemo(() => isPlanMode() && props.hasPendingPlan !== false && !running() && !decisionDismissed());

  const handleDecision = async (decision: "accept" | "reject") => {
    if (sending() || staging() || running() || props.disabled) return;
    setDecisionDismissed(true);
    const promptText = decision === "accept"
      ? (text().trim() ? `Plan akzeptiert: ${text().trim()}` : "Plan akzeptiert. Bitte mit der Umsetzung beginnen.")
      : (text().trim() ? `Plan abgelehnt: ${text().trim()}` : "Plan abgelehnt.");

    setSending(true);
    try {
      const submittedAttachments = [...attachments()];
      const submittedProjectFiles = [...projectFiles()];
      await props.onSend(promptText, submittedAttachments, submittedProjectFiles);
      setText("");
      setAttachments([]);
      setProjectFiles([]);
      setFileSuggestions([]);
      setCaretPosition(0);
      for (const attachment of submittedAttachments) URL.revokeObjectURL(attachment.previewUrl);
      textareaRef?.focus();
    } catch {
      // The parent presents the validated desktop error
      setDecisionDismissed(false);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (stopping() || props.phase === "cancelling") return;
    setDecisionDismissed(true);
    setStopping(true);
    try {
      await props.onCancel();
    } catch {
      // The parent surfaces the error; keep the composer usable for another attempt.
    } finally {
      setStopping(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (fileMenuOpen()) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveSuggestion(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedMention(mentionKey());
        setFileSuggestions([]);
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey && !(event as any).nativeEvent?.isComposing) {
        const entry = fileSuggestions()[activeSuggestion()];
        if (entry?.contextEligible) {
          event.preventDefault();
          selectProjectFile(entry);
          return;
        }
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !(event as any).nativeEvent?.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent) => {
    if (!props.imagesSupported) return;
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
        sessionId: props.sessionId,
        displayName: file.name || `Zwischenablage-${Date.now()}.png`,
        mimeType: isSupportedImageMime(file.type) ? file.type : "image/png",
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    )
      .then(hydrate)
      .then((staged) => setAttachments((current) => [...current, ...staged]))
      .catch((error) => props.onError(errorMessage(error)))
      .finally(() => setStaging(false));
  };

  return (
    <>
      {dragging() && (
        <div class="drop-overlay" aria-hidden="true">
          <div><Icon name="image" size={28} /><strong>Bilder hier ablegen</strong><span>PNG, JPEG, WebP oder GIF</span></div>
        </div>
      )}
      <div class="composer-area" use:nativeFileDrop={nativeComposerDrop}>
        <div class={`composer ${running() ? "composer--running" : ""}`}>
          {fileMenuOpen() && (
            <div class="project-file-menu" id={PROJECT_FILE_MENU_ID} role="listbox" aria-label="Projektdateien">
              <header>
                <span><Icon name="file-text" size={14} /> Projektdateien</span>
                <span><kbd>↑</kbd><kbd>↓</kbd> wählen · <kbd>Tab</kbd>/<kbd>Enter</kbd> übernehmen</span>
              </header>
              <div class="project-file-menu-list">
                {fileSearchLoading() && fileSuggestions().length === 0 && (
                  <div class="project-file-menu-state"><span class="mini-spinner" /> Dateien werden gesucht …</div>
                )}
                {!fileSearchLoading() && fileSearchError() && (
                  <div class="project-file-menu-state project-file-menu-state--error"><Icon name="warning" size={14} /> {fileSearchError()}</div>
                )}
                {!fileSearchLoading() && !fileSearchError() && fileSuggestions().length === 0 && (
                  <div class="project-file-menu-state">
                    {mention()?.query ? "Keine passende Projektdatei gefunden." : "Tippe den ersten Buchstaben des Dateinamens oder Pfads."}
                  </div>
                )}
                <For each={fileSuggestions()}>
                  {(entry, index) => (
                    <button
                      class={`project-file-option ${index() === activeSuggestion() ? "project-file-option--active" : ""}`}
                      id={`${PROJECT_FILE_MENU_ID}-${index()}`}
                      type="button"
                      role="option"
                      aria-selected={index() === activeSuggestion()}
                      aria-disabled={!entry.contextEligible}
                      title={entry.contextUnavailableReason ?? `${entry.rootLabel}/${entry.relativePath}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        selectProjectFile(entry);
                      }}
                      onMouseEnter={() => {
                        if (entry.contextEligible) setActiveSuggestion(index());
                      }}
                    >
                      <span class="project-file-option-icon"><Icon name="file-text" size={14} /></span>
                      <span class="project-file-option-copy">
                        <strong>{entry.displayName}</strong>
                        <small><span>{entry.rootLabel}</span>{entry.relativePath}</small>
                      </span>
                      <span class="project-file-option-size">{entry.contextEligible ? readableSize(entry.size) : "Nicht lesbar"}</span>
                    </button>
                  )}
                </For>
              </div>
            </div>
          )}
          {(props.externalContexts?.length ?? 0) > 0 && (
            <div class="external-context-strip" aria-label="Vorbereiteter Reviewkontext">
              {props.externalContexts!.map((context) => (
                <span class="external-context-chip"  title={context.mergeRequestReference}>
                  <Icon name="gitlab" size={12} />
                  <strong>{context.title}</strong>
                  <small>
                    {context.filePath ?? context.repositoryLabel} · gültig bis{" "}
                    {new Date(context.expiresAt).toLocaleTimeString("de-DE", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </small>
                  {props.onRemoveExternalContext && (
                    <button
                      type="button"
                      onClick={() => props.onRemoveExternalContext!(context.ref.id)}
                      aria-label={`${context.title} aus dem Entwurf entfernen`}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {projectFiles().length > 0 && (
            <div class="project-file-reference-strip" aria-label="Referenzierte Projektdateien">
              {projectFiles().map((entry) => (
                <span class="project-file-reference"  title={`${entry.rootLabel}/${entry.relativePath}`}>
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
          {attachments().length > 0 && (
            <div class="attachment-strip" aria-label="Angehängte Bilder">
              {attachments().map((attachment) => (
                <figure class="attachment-chip" >
                  <img src={attachment.previewUrl} alt="" />
                  <figcaption><strong>{attachment.displayName}</strong><span>{readableSize(attachment.size)}</span></figcaption>
                  <button type="button" onClick={() => void removeAttachment(attachment)} aria-label={`${attachment.displayName} entfernen`}>
                    <Icon name="x" size={13} />
                  </button>
                </figure>
              ))}
            </div>
          )}
          {showPlanDecision() && (
            <div class="plan-decision-bar" role="group" aria-label="Plan-Entscheidung">
              <span class="plan-decision-label">
                <Icon name="brain" size={14} />
                <span>Planungsmodus</span>
              </span>
              <div class="plan-decision-actions">
                <button
                  type="button"
                  class="plan-decision-button plan-decision-button--accept"
                  onClick={() => void handleDecision("accept")}
                  disabled={sending() || staging() || Boolean(props.disabled)}
                  aria-label="Plan akzeptieren"
                  title="Plan akzeptieren und ausführen (übernimmt ggf. deinen Text)"
                >
                  <Icon name="check" size={13} />
                  <span>Akzeptieren</span>
                </button>
                <button
                  type="button"
                  class="plan-decision-button plan-decision-button--reject"
                  onClick={() => void handleDecision("reject")}
                  disabled={sending() || staging() || Boolean(props.disabled)}
                  aria-label="Plan ablehnen"
                  title="Plan ablehnen (übernimmt ggf. deine Nachricht)"
                >
                  <Icon name="x" size={13} />
                  <span>Ablehnen</span>
                </button>
              </div>
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            value={text()}
            onInput={(event) => {
              setText(event.currentTarget.value);
              setCaretPosition(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
            }}
            onChange={(event) => {
              setText(event.target.value);
              setCaretPosition(event.target.selectionStart ?? event.target.value.length);
              setDismissedMention(null);
            }}
            onClick={(event) => setCaretPosition(event.currentTarget.selectionStart ?? text().length)}
            onSelect={(event) => setCaretPosition(event.currentTarget.selectionStart ?? text().length)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={running() ? "Nächste Nachricht vorbereiten …" : "Nachricht an Gemini …"}
            aria-label="Nachricht an Gemini"
            aria-describedby={running() ? "composer-running-status" : undefined}
            aria-autocomplete="list"
            aria-controls={fileMenuOpen() ? PROJECT_FILE_MENU_ID : undefined}
            aria-expanded={fileMenuOpen()}
            aria-activedescendant={fileMenuOpen() && activeSuggestion() >= 0 ? `${PROJECT_FILE_MENU_ID}-${activeSuggestion()}` : undefined}
            disabled={props.disabled}
          />
          <div class="composer-toolbar">
            <div class="composer-tools">
              <button
                class="composer-icon-button"
                type="button"
                disabled={!props.imagesSupported || props.disabled || staging()}
                onClick={() => void addStaged(() => window.gemUi.attachments.pickImages({ sessionId: props.sessionId, clientRequestId: createClientRequestId() }))}
                aria-label="Bilder anhängen"
                title={props.imagesSupported ? "Bilder anhängen" : "Bilder werden von dieser Gemini-Version nicht unterstützt"}
              >
                {staging() ? <span class="mini-spinner" /> : <Icon name="paperclip" size={19} />}
              </button>
              <span class="composer-context" id={running() ? "composer-running-status" : undefined}>
                <span class={`context-dot ${running() ? "context-dot--working" : ""}`} />
                {running() ? "Antwort läuft · Entwurf bleibt erhalten" : "Kontext: alle Projektordner"}
              </span>
            </div>
            {props.contextAttachmentCount > 0 && (
              <button
                class={`composer-context-attachments ${props.contextOverBudget ? "composer-context-attachments--warning" : ""}`}
                type="button"
                onClick={props.onOpenContextAttachments}
                title={props.contextOverBudget ? "Der ausgewählte Anhangskontext überschreitet das Limit. Wähle Anhänge ab, bevor du sendest." : "Anhänge im Kontext anzeigen"}
              >
                <Icon name={props.contextOverBudget ? "warning" : "paperclip"} size={14} />
                {props.contextAttachmentCount} {props.contextAttachmentCount === 1 ? "Anhang" : "Anhänge"} im Kontext · ~{props.contextEstimatedTokens.toLocaleString("de-DE")} Token
              </button>
            )}
            {running() ? (
              <button class="stop-button" type="button" onClick={() => void stop()} disabled={stopping() || props.phase === "cancelling"} aria-label="Antwort stoppen">
                {stopping() || props.phase === "cancelling" ? <span class="mini-spinner" /> : <Icon name="stop" size={16} />}
                <span>Stoppen</span>
              </button>
            ) : (
              <button
                class="send-button"
                type="button"
                disabled={!canSend()}
                onClick={() => void submit()}
                aria-label="Nachricht senden"
                title={props.contextOverBudget ? "Der ausgewählte Anhangskontext überschreitet das Limit. Wähle zuerst Anhänge ab." : undefined}
              >
                {sending() ? <span class="mini-spinner" /> : <Icon name="arrow-up" size={19} />}
              </button>
            )}
          </div>
        </div>
        <p class="composer-hint"><kbd>@</kbd> für Projektdateien · Enter zum Senden · Shift + Enter für neue Zeile</p>
      </div>
    </>
  );
}
