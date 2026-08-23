import {
  Fragment,
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
  liveEstimatedTokens?: number | null;
  disabled?: boolean;
  draft?: ComposerDraft | null;
  pendingProjectFileRefs?: ProjectFileSearchEntry[] | null;
  externalContexts?: PreparedExternalContext[];
  sessionMode?: string | null;
  hasPendingPlan?: boolean;
  onDraftApplied?: () => void;
  onProjectFileRefsApplied?: () => void;
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

/**
 * Der Schrägstrich schaltet die Auswahl von "suche überall" auf "zeig mir den
 * Inhalt dieses Ordners" um. Der Eingabetext ist damit der einzige Zustand —
 * es braucht keinen zweiten Modus, und ein von Hand getippter Pfad verhält
 * sich genauso wie einer, der per Tab entstanden ist.
 */
function directoryScope(query: string): { directory: string; filter: string } | null {
  const lastSlash = query.lastIndexOf("/");
  if (lastSlash < 0) return null;
  return {
    directory: query.slice(0, lastSlash).replace(/^\/+|\/+$/g, ""),
    filter: query.slice(lastSlash + 1),
  };
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
  liveEstimatedTokens = null,
  disabled = false,
  draft = null,
  pendingProjectFileRefs = null,
  externalContexts = [],
  sessionMode = null,
  hasPendingPlan = true,
  onDraftApplied,
  onProjectFileRefsApplied,
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
  const [decisionDismissed, setDecisionDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);
  const fileSearchSequence = useRef(0);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const running = ["running", "awaiting_permission", "cancelling"].includes(phase);

  useEffect(() => {
    if (running) {
      setDecisionDismissed(false);
    }
  }, [sessionId, running]);

  const canSend = !disabled && !contextOverBudget && !running && !sending && !staging
    && Boolean(text.trim() || attachments.length || projectFiles.length || externalContexts.length);
  const mention = activeFileMention(text, caretPosition);
  const mentionKey = mention ? `${mention.start}:${mention.end}:${mention.query}` : null;
  const fileMenuOpen = Boolean(mention && mentionKey !== dismissedMention && !disabled);
  /** Gesetzt, sobald die Erwähnung einen Ordner adressiert ("src/…"). */
  const scope = mention ? directoryScope(mention.query) : null;

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

  const addProjectFileReferences = useCallback(
    (entries: ProjectFileSearchEntry[]) => {
      const eligible = entries.filter((e) => e.contextEligible);
      const skipped = entries.length - eligible.length;
      setProjectFiles((current) => {
        const seen = new Set(current.map((e) => `${e.rootId}\0${e.relativePath}`));
        const additions = eligible.filter((e) => !seen.has(`${e.rootId}\0${e.relativePath}`));
        const room = MAX_PROJECT_FILE_REFERENCES - current.length;
        if (additions.length > room) {
          onError(
            `Pro Nachricht können höchstens ${MAX_PROJECT_FILE_REFERENCES} Projektdateien oder -ordner referenziert werden.`,
          );
        }
        return [...current, ...additions.slice(0, Math.max(0, room))];
      });
      if (skipped > 0) {
        onError(`${skipped} Eintrag/Einträge waren nicht als Kontext geeignet und wurden übersprungen.`);
      }
    },
    [onError],
  );

  useEffect(() => {
    if (!pendingProjectFileRefs || pendingProjectFileRefs.length === 0) return;
    addProjectFileReferences(pendingProjectFileRefs);
    onProjectFileRefsApplied?.();
  }, [pendingProjectFileRefs, addProjectFileReferences, onProjectFileRefsApplied]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const hasProjectFileRefs = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes(
        "application/x-geminui-project-file-refs",
      );

    const enter = (event: DragEvent) => {
      if (!hasFiles(event) && !hasProjectFileRefs(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event) && !hasProjectFileRefs(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event) && !hasProjectFileRefs(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      const isFiles = hasFiles(event);
      const isRefs = hasProjectFileRefs(event);
      if (!isFiles && !isRefs) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);

      if (isRefs) {
        try {
          const raw = event.dataTransfer?.getData(
            "application/x-geminui-project-file-refs",
          );
          if (raw) {
            const parsed = JSON.parse(raw) as ProjectFileSearchEntry[];
            if (Array.isArray(parsed) && parsed.length > 0) {
              addProjectFileReferences(parsed);
              return;
            }
          }
        } catch {
          // ignore JSON parse error
        }
      }

      if (isFiles) {
        addFiles(Array.from(event.dataTransfer?.files ?? []));
      }
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
  }, [addFiles, addProjectFileReferences]);

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
        // Ein Ordnerinhalt darf länger sein als eine Trefferliste.
        limit: directoryScope(mention.query) ? 24 : 10,
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
        onError(`Pro Nachricht können höchstens ${MAX_PROJECT_FILE_REFERENCES} Projektdateien oder -ordner referenziert werden.`);
        return;
      }
      setProjectFiles((current) => [...current, entry]);
    }

    // Der Schrägstrich am Ende macht im Text sichtbar, dass ein ganzer Ordner
    // gemeint ist — und nicht eine Datei ohne Endung.
    const referenceText = `@${entry.relativePath}${entry.kind === "directory" ? "/" : ""}`;
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

  /**
   * Ein Ordner wird nicht übernommen, sondern betreten: Die Erwähnung wird zu
   * `@pfad/` und die Liste zeigt seinen Inhalt. Verschachtelte Ordner bleiben
   * so eine Navigation statt einer flachen Pfadliste.
   */
  const openDirectory = (entry: ProjectFileSearchEntry) => {
    const currentMention = activeFileMention(text, caretPosition);
    if (!currentMention) return;
    const reference = `@${entry.relativePath}/`;
    const nextText = `${text.slice(0, currentMention.start)}${reference}${text.slice(currentMention.end)}`;
    const nextCaret = currentMention.start + reference.length;
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

  /** Springt im Brotkrumenpfad auf eine Ebene — "" ist die freie Suche. */
  const jumpToDirectory = (directory: string) => {
    const currentMention = activeFileMention(text, caretPosition);
    if (!currentMention) return;
    const reference = directory ? `@${directory}/` : "@";
    const nextText = `${text.slice(0, currentMention.start)}${reference}${text.slice(currentMention.end)}`;
    const nextCaret = currentMention.start + reference.length;
    setText(nextText);
    setCaretPosition(nextCaret);
    setDismissedMention(null);
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

  const isPlanMode = sessionMode === "plan";
  const showPlanDecision = isPlanMode && hasPendingPlan && !running && !decisionDismissed;

  const handleDecision = async (decision: "accept" | "reject") => {
    if (sending || staging || running || disabled) return;
    setDecisionDismissed(true);
    const promptText = decision === "accept"
      ? (text.trim() ? `Plan akzeptiert: ${text.trim()}` : "Plan akzeptiert. Bitte mit der Umsetzung beginnen.")
      : (text.trim() ? `Plan abgelehnt: ${text.trim()}` : "Plan abgelehnt.");

    setSending(true);
    try {
      const submittedAttachments = [...attachments];
      const submittedProjectFiles = [...projectFiles];
      await onSend(promptText, submittedAttachments, submittedProjectFiles);
      setText("");
      setAttachments([]);
      setProjectFiles([]);
      setFileSuggestions([]);
      setCaretPosition(0);
      for (const attachment of submittedAttachments) URL.revokeObjectURL(attachment.previewUrl);
      textareaRef.current?.focus();
    } catch {
      // The parent presents the validated desktop error
      setDecisionDismissed(false);
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (stopping || phase === "cancelling") return;
    setDecisionDismissed(true);
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
        event.preventDefault();
        const entry = fileSuggestions[activeSuggestion];
        if (!entry?.contextEligible) return;
        // Tab geht in einen Ordner hinein, Enter übernimmt ihn als Kontext.
        if (event.key === "Tab" && entry.kind === "directory") {
          openDirectory(entry);
          return;
        }
        selectProjectFile(entry);
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
                {scope?.directory ? (
                  <nav className="project-file-breadcrumb" aria-label="Ordnerpfad">
                    <button type="button" onMouseDown={(event) => { event.preventDefault(); jumpToDirectory(""); }}>
                      <Icon name="folder" size={13} /> Projekt
                    </button>
                    {scope.directory.split("/").map((segment, index, all) => (
                      <span key={`${segment}-${index}`}>
                        <i aria-hidden="true">/</i>
                        <button
                          type="button"
                          aria-current={index === all.length - 1 ? "location" : undefined}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            jumpToDirectory(all.slice(0, index + 1).join("/"));
                          }}
                        >
                          {segment}
                        </button>
                      </span>
                    ))}
                  </nav>
                ) : (
                  <span><Icon name="file-text" size={14} /> Projektdateien und -ordner</span>
                )}
                <span className="project-file-menu-hint">
                  <kbd>↑</kbd><kbd>↓</kbd> wählen · <kbd>Tab</kbd> öffnen · <kbd>Enter</kbd> übernehmen
                </span>
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
                    {scope
                      ? "Dieser Ordner enthält nichts Passendes."
                      : mention?.query
                        ? "Kein passender Eintrag gefunden."
                        : "Tippe den Anfang eines Datei- oder Ordnernamens."}
                  </div>
                )}
                {fileSuggestions.map((entry, index) => (
                  <Fragment key={`${entry.rootId}:${entry.relativePath}`}>
                  {(index === 0 || fileSuggestions[index - 1]?.kind !== entry.kind) &&
                    fileSuggestions.some((other) => other.kind !== entry.kind) && (
                      <p className="project-file-group" aria-hidden="true">
                        {entry.kind === "directory" ? "Ordner" : "Dateien"}
                      </p>
                    )}
                  <button
                    className={`project-file-option ${index === activeSuggestion ? "project-file-option--active" : ""} ${entry.kind === "directory" ? "project-file-option--directory" : ""}`}
                    id={`${PROJECT_FILE_MENU_ID}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeSuggestion}
                    aria-disabled={!entry.contextEligible}
                    title={entry.contextUnavailableReason ?? `${entry.rootLabel}/${entry.relativePath}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      // Klick folgt der Hauptabsicht: Ordner werden geöffnet,
                      // Dateien übernommen. Ein Ordner wird per Enter zum
                      // Kontext.
                      if (entry.kind === "directory" && entry.contextEligible) openDirectory(entry);
                      else selectProjectFile(entry);
                    }}
                    onMouseEnter={() => {
                      if (entry.contextEligible) setActiveSuggestion(index);
                    }}
                  >
                    <span className="project-file-option-icon">
                      <Icon name={entry.kind === "directory" ? "folder" : "file-text"} size={14} />
                    </span>
                    <span className="project-file-option-copy">
                      <strong>
                        {entry.displayName}
                        {entry.kind === "directory" ? "/" : ""}
                      </strong>
                      {/* Im Ordnermodus sagt der Brotkrumenpfad bereits, wo wir
                          sind — der volle Pfad in jeder Zeile wäre Wiederholung. */}
                      <small>
                        <span>{entry.rootLabel}</span>
                        {scope ? null : entry.relativePath}
                      </small>
                    </span>
                    {entry.kind === "directory" ? (
                      <span className="project-file-option-size">
                        {entry.contextEligible
                          ? `${entry.childCount} ${entry.childCount === 1 ? "Eintrag" : "Einträge"}`
                          : "Leer"}
                      </span>
                    ) : (
                      <span className="project-file-option-size">
                        {entry.contextEligible ? readableSize(entry.size) : "Nicht lesbar"}
                      </span>
                    )}
                  </button>
                  </Fragment>
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
            <div className="project-file-reference-strip" aria-label="Referenzierte Projektdateien und -ordner">
              {projectFiles.map((entry) => (
                <span
                  className={`project-file-reference ${entry.kind === "directory" ? "project-file-reference--directory" : ""}`}
                  key={`${entry.rootId}:${entry.relativePath}`}
                  title={`${entry.rootLabel}/${entry.relativePath}`}
                >
                  <Icon name={entry.kind === "directory" ? "folder" : "file-text"} size={12} />
                  <strong>
                    {entry.displayName}
                    {entry.kind === "directory" ? "/" : ""}
                  </strong>
                  <small>{entry.kind === "directory" ? "Ordner" : entry.rootLabel}</small>
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
          {showPlanDecision && (
            <div className="plan-decision-bar" role="group" aria-label="Plan-Entscheidung">
              <span className="plan-decision-label">
                <Icon name="brain" size={14} />
                <span>Planungsmodus</span>
              </span>
              <div className="plan-decision-actions">
                <button
                  type="button"
                  className="plan-decision-button plan-decision-button--accept"
                  onClick={() => void handleDecision("accept")}
                  disabled={sending || staging || disabled}
                  aria-label="Plan akzeptieren"
                  title="Plan akzeptieren und ausführen (übernimmt ggf. deinen Text)"
                >
                  <Icon name="check" size={13} />
                  <span>Akzeptieren</span>
                </button>
                <button
                  type="button"
                  className="plan-decision-button plan-decision-button--reject"
                  onClick={() => void handleDecision("reject")}
                  disabled={sending || staging || disabled}
                  aria-label="Plan ablehnen"
                  title="Plan ablehnen (übernimmt ggf. deine Nachricht)"
                >
                  <Icon name="x" size={13} />
                  <span>Ablehnen</span>
                </button>
              </div>
            </div>
          )}
          {running && (
            <div className="composer-status-banner" aria-live="polite">
              <span className="composer-status-dots" aria-hidden="true"><i /><i /><i /></span>
              <span className="composer-status-label">Gemini arbeitet gerade …</span>
              {liveEstimatedTokens !== null && liveEstimatedTokens > 0 && (
                <span className="composer-status-tokens">
                  <span className="live-token-icon">
                    <Icon name="sparkle" size={12} />
                  </span>
                  <strong className="live-token-value">~{liveEstimatedTokens.toLocaleString("de-DE")} Tokens</strong>
                  <small className="live-token-hint">geschätzt</small>
                </span>
              )}
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
                {running ? "Entwurf bleibt erhalten" : "Kontext: alle Projektordner"}
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
