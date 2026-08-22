import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";

import { Icon } from "../../components/Icon";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
import { AddLinkDialog } from "../attachments/AddLinkDialog";
import type { AppProject, ContextAttachment, Todo, TodoList } from "../../types";
import { createClientRequestId } from "../../utils/client-request-id";

type TodosPanelProps = {
  project: AppProject;
  list: TodoList | null;
  loading: boolean;
  error: string | null;
  hasActiveSession: boolean;
  onClose: () => void;
  onApply: (list: TodoList) => void;
  onError: (error: unknown) => void;
  onSendToSession: (todo: Todo) => Promise<void>;
  onSendToNewSession: (todo: Todo) => Promise<void>;
  onOpenExternal: (url: string) => void;
};

type Draft = {
  title: string;
  description: string;
};

const EMPTY_DRAFT: Draft = { title: "", description: "" };

function attachmentIcon(attachment: ContextAttachment) {
  if (attachment.kind === "link") return "link" as const;
  return attachment.file?.mimeType.startsWith("image/") ? ("image" as const) : ("file-text" as const);
}

function attachmentMeta(attachment: ContextAttachment): string {
  if (attachment.link) return attachment.link.host;
  const state = attachment.file?.extractionState;
  if (state === "pending" || state === "running") return "Text wird ausgelesen …";
  if (state === "failed") return "Text konnte nicht gelesen werden";
  if (state === "too_large") return "Zu groß für den Kontext";
  return attachment.file?.mimeType ?? "Datei";
}

export function TodosPanel({
  project,
  list,
  loading,
  error,
  hasActiveSession,
  onClose,
  onApply,
  onError,
  onSendToSession,
  onSendToNewSession,
  onOpenExternal,
}: TodosPanelProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState<Draft>(EMPTY_DRAFT);
  const [showDone, setShowDone] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkDialogTodoId, setLinkDialogTodoId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const newTitleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) newTitleRef.current?.focus();
  }, [creating]);

  const todos = list?.todos ?? [];
  const visible = showDone ? todos : todos.filter((todo) => !todo.done);
  const openCount = list?.openCount ?? 0;
  const doneCount = list?.doneCount ?? 0;

  const run = async (todoId: string | null, operation: () => Promise<TodoList>) => {
    setBusyId(todoId);
    try {
      onApply(await operation());
    } catch (reason) {
      onError(reason);
    } finally {
      setBusyId(null);
    }
  };

  const submitNew = async (event: FormEvent) => {
    event.preventDefault();
    const title = newDraft.title.trim();
    if (!title) return;
    await run(null, () =>
      window.gemUi.todos.create({
        clientRequestId: createClientRequestId(),
        projectId: project.id,
        title,
        description: newDraft.description.trim(),
      }),
    );
    setNewDraft(EMPTY_DRAFT);
    setCreating(false);
  };

  const submitEdit = async (todo: Todo, event: FormEvent) => {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title) return;
    await run(todo.id, () =>
      window.gemUi.todos.update({
        clientRequestId: createClientRequestId(),
        todoId: todo.id,
        title,
        description: draft.description,
      }),
    );
    setEditingId(null);
  };

  const toggleDone = (todo: Todo) =>
    run(todo.id, () =>
      window.gemUi.todos.update({
        clientRequestId: createClientRequestId(),
        todoId: todo.id,
        done: !todo.done,
      }),
    );

  const remove = (todo: Todo) => {
    const question = todo.attachments.length
      ? `„${todo.title}“ löschen? Die ${todo.attachments.length} Anhänge bleiben als Projektanhänge erhalten.`
      : `„${todo.title}“ löschen?`;
    if (!window.confirm(question)) return;
    void run(todo.id, () =>
      window.gemUi.todos.delete({
        clientRequestId: createClientRequestId(),
        todoId: todo.id,
      }),
    );
  };

  const addFiles = (todo: Todo) =>
    run(todo.id, () =>
      window.gemUi.todos.addFiles({
        clientRequestId: createClientRequestId(),
        todoId: todo.id,
        paths: [],
      }),
    );

  const dropFiles = (todo: Todo, files: File[]) =>
    run(todo.id, () =>
      window.gemUi.todos.addDroppedFiles(files, { todoId: todo.id, projectId: project.id }),
    );

  const detach = (todo: Todo, attachment: ContextAttachment) =>
    run(todo.id, () =>
      window.gemUi.todos.detachAttachment({
        clientRequestId: createClientRequestId(),
        todoId: todo.id,
        attachmentId: attachment.id,
      }),
    );

  const send = async (todo: Todo, target: "current" | "new") => {
    setBusyId(todo.id);
    try {
      if (target === "new") await onSendToNewSession(todo);
      else await onSendToSession(todo);
    } catch (reason) {
      onError(reason);
    } finally {
      setBusyId(null);
    }
  };

  const subtitle = loading && !list
    ? "Todos werden geladen …"
    : `${openCount} offen · ${doneCount} erledigt`;

  return (
    <aside className="extension-panel todos-panel" aria-label="Todos dieses Projekts">
      <header className="extension-panel-header todos-panel-header">
        <div>
          <span className="extension-panel-icon todos-panel-icon">
            <Icon name="checklist" size={17} />
          </span>
          <div>
            <strong>Todos</strong>
            <span>{subtitle}</span>
          </div>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={() => setCreating(true)}
          title="Todo anlegen"
          aria-label="Todo anlegen"
        >
          <Icon name="plus" size={17} />
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          title="Panel schließen"
          aria-label="Todos schließen"
        >
          <Icon name="x" size={16} />
        </button>
      </header>

      <div className="extension-panel-body">
        {doneCount > 0 && (
          <div className="todos-filter-bar">
            <label>
              <input
                type="checkbox"
                checked={showDone}
                onChange={(event) => setShowDone(event.target.checked)}
              />
              Erledigte anzeigen
            </label>
          </div>
        )}

        <div className="extension-panel-scroll">
          {error && (
            <div className="extension-error" role="alert">
              <Icon name="warning" size={17} />
              <p>
                <strong>Todos konnten nicht geladen werden</strong>
                <span>{error}</span>
              </p>
            </div>
          )}

          {creating && (
            <form className="todo-create-form" onSubmit={(event) => void submitNew(event)}>
              <input
                ref={newTitleRef}
                value={newDraft.title}
                maxLength={200}
                placeholder="Worum geht es?"
                aria-label="Titel des Todos"
                onChange={(event) => setNewDraft((current) => ({ ...current, title: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setCreating(false);
                    setNewDraft(EMPTY_DRAFT);
                  }
                }}
              />
              <textarea
                value={newDraft.description}
                rows={3}
                placeholder="Beschreibung — das wird später der Prompt (optional)"
                aria-label="Beschreibung des Todos"
                onChange={(event) => setNewDraft((current) => ({ ...current, description: event.target.value }))}
              />
              <div className="todo-form-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setNewDraft(EMPTY_DRAFT);
                  }}
                >
                  Abbrechen
                </button>
                <button className="primary-button" type="submit" disabled={!newDraft.title.trim()}>
                  <Icon name="plus" size={15} /> Anlegen
                </button>
              </div>
            </form>
          )}

          {loading && !list && (
            <div className="extension-loading">
              <span className="mini-spinner" /> Todos werden geladen …
            </div>
          )}

          {list && visible.length === 0 && !creating && (
            <div className="extension-empty">
              <span><Icon name="checklist" size={20} /></span>
              <strong>{todos.length === 0 ? "Noch keine Todos" : "Alles erledigt"}</strong>
              <p>
                {todos.length === 0
                  ? "Lege Prompt-Entwürfe an: Titel, Beschreibung und die Anhänge, die dazugehören. Ein Klick gibt so ein Todo später in eine Session."
                  : "Alle Todos dieses Projekts sind abgehakt."}
              </p>
            </div>
          )}

          {visible.map((todo) => {
            const expanded = expandedId === todo.id;
            const editing = editingId === todo.id;
            const busy = busyId === todo.id;
            return (
              <article
                key={todo.id}
                className={[
                  "todo-row",
                  todo.done ? "todo-row--done" : "",
                  expanded ? "todo-row--expanded" : "",
                  dropTargetId === todo.id ? "todo-row--drop" : "",
                ].filter(Boolean).join(" ")}
                onDragEnter={(event: DragEvent<HTMLElement>) => {
                  if (!expanded) return;
                  event.preventDefault();
                  dragDepth.current += 1;
                  setDropTargetId(todo.id);
                }}
                onDragOver={(event: DragEvent<HTMLElement>) => {
                  if (expanded) event.preventDefault();
                }}
                onDragLeave={() => {
                  dragDepth.current = Math.max(0, dragDepth.current - 1);
                  if (dragDepth.current === 0) setDropTargetId(null);
                }}
                onDrop={(event: DragEvent<HTMLElement>) => {
                  if (!expanded) return;
                  event.preventDefault();
                  dragDepth.current = 0;
                  setDropTargetId(null);
                  const files = [...event.dataTransfer.files];
                  if (files.length) void dropFiles(todo, files);
                }}
              >
                <div className="todo-row-head">
                  <label className="todo-check" title={todo.done ? "Wieder öffnen" : "Als erledigt markieren"}>
                    <input
                      type="checkbox"
                      checked={todo.done}
                      disabled={busy}
                      onChange={() => void toggleDone(todo)}
                      aria-label={`„${todo.title}“ ${todo.done ? "wieder öffnen" : "als erledigt markieren"}`}
                    />
                  </label>
                  <button
                    className="todo-main"
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : todo.id)}
                  >
                    <strong>{todo.title}</strong>
                    <small>
                      {todo.attachments.length > 0 && (
                        <span className="todo-attachment-count">
                          <Icon name="paperclip" size={12} /> {todo.attachments.length}
                        </span>
                      )}
                      {todo.description.trim()
                        ? todo.description.trim().split("\n")[0]
                        : "Ohne Beschreibung"}
                    </small>
                  </button>
                  <TodoMenu
                    todo={todo}
                    onEdit={() => {
                      setEditingId(todo.id);
                      setExpandedId(todo.id);
                      setDraft({ title: todo.title, description: todo.description });
                    }}
                    onDelete={() => remove(todo)}
                  />
                </div>

                {expanded && (
                  <div className="todo-row-body">
                    {editing ? (
                      <form className="todo-edit-form" onSubmit={(event) => void submitEdit(todo, event)}>
                        <input
                          value={draft.title}
                          maxLength={200}
                          aria-label="Titel des Todos"
                          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                        />
                        <textarea
                          value={draft.description}
                          rows={6}
                          aria-label="Beschreibung des Todos"
                          placeholder="Beschreibung — das wird der Prompt"
                          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                        />
                        <div className="todo-form-actions">
                          <button className="secondary-button" type="button" onClick={() => setEditingId(null)}>
                            Abbrechen
                          </button>
                          <button className="primary-button" type="submit" disabled={busy || !draft.title.trim()}>
                            Speichern
                          </button>
                        </div>
                      </form>
                    ) : (
                      todo.description.trim() && <p className="todo-description">{todo.description}</p>
                    )}

                    <div className="todo-attachments">
                      {todo.attachments.map((attachment) => (
                        <span className="todo-attachment" key={attachment.id}>
                          <Icon name={attachmentIcon(attachment)} size={13} />
                          <button
                            type="button"
                            className="todo-attachment-title"
                            title={attachment.link ? attachment.link.url : attachment.title}
                            onClick={() => {
                              if (attachment.link) onOpenExternal(attachment.link.url);
                              else {
                                void window.gemUi.contextAttachments
                                  .openFile({ attachmentId: attachment.id })
                                  .catch(onError);
                              }
                            }}
                          >
                            <strong>{attachment.title}</strong>
                            <small>{attachmentMeta(attachment)}</small>
                          </button>
                          <button
                            type="button"
                            className="todo-attachment-remove"
                            title="Vom Todo lösen — bleibt Projektanhang"
                            aria-label={`„${attachment.title}“ von diesem Todo lösen`}
                            onClick={() => void detach(todo, attachment)}
                          >
                            <Icon name="x" size={13} />
                          </button>
                        </span>
                      ))}
                      <div className="todo-attachment-actions">
                        <button type="button" className="ghost-button" disabled={busy} onClick={() => void addFiles(todo)}>
                          <Icon name="paperclip" size={14} /> Datei
                        </button>
                        <button type="button" className="ghost-button" disabled={busy} onClick={() => setLinkDialogTodoId(todo.id)}>
                          <Icon name="link" size={14} /> Link
                        </button>
                      </div>
                    </div>

                    <div className="todo-send-actions">
                      <button
                        className="primary-button"
                        type="button"
                        disabled={busy || !hasActiveSession}
                        title={hasActiveSession
                          ? "Titel, Beschreibung und Anhänge in die offene Session übernehmen"
                          : "Es ist keine Session geöffnet"}
                        onClick={() => void send(todo, "current")}
                      >
                        {busy ? <span className="mini-spinner" /> : <Icon name="arrow-up" size={15} />}
                        In diese Session
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={busy}
                        title="Neue Session anlegen und das Todo dort übernehmen"
                        onClick={() => void send(todo, "new")}
                      >
                        {busy ? <span className="mini-spinner" /> : <Icon name="plus" size={15} />} Neue Session
                      </button>
                    </div>
                    <p className="todo-send-hint">
                      Der Entwurf landet im Eingabefeld — gesendet wird erst, wenn du es abschickst.
                    </p>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>

      <AddLinkDialog
        open={linkDialogTodoId !== null}
        scopeLabel="Anhang für dieses Todo"
        onClose={() => setLinkDialogTodoId(null)}
        onSubmit={async (url, title) => {
          const todoId = linkDialogTodoId;
          if (!todoId) return;
          onApply(
            await window.gemUi.todos.addLink({
              clientRequestId: createClientRequestId(),
              todoId,
              url,
              title,
            }),
          );
        }}
      />
    </aside>
  );
}

function TodoMenu({
  todo,
  onEdit,
  onDelete,
}: {
  todo: Todo;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const menuRef = useDismissOnOutsideClick<HTMLDetailsElement>();
  return (
    <details ref={menuRef} className="todo-menu context-attachment-menu">
      <summary aria-label={`Aktionen für ${todo.title}`}><Icon name="more" size={16} /></summary>
      <div>
        <button type="button" onClick={onEdit}><Icon name="pencil" size={13} /> Bearbeiten</button>
        <button className="danger-menu-item" type="button" onClick={onDelete}>
          <Icon name="trash" size={13} /> Löschen
        </button>
      </div>
    </details>
  );
}
