import { createEffect, createSignal,  } from "solid-js";

import { Icon } from "../../components/Icon";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
import { AddLinkDialog } from "../attachments/AddLinkDialog";
import type { AppProject, ContextAttachment, Todo, TodoList } from "../../types";
import { createClientRequestId } from "../../utils/client-request-id";
import { nativeFileDrop } from "../../native-file-drop";

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
  const [expandedId, setExpandedId] = createSignal<string | null>(null);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = createSignal(false);
  const [newDraft, setNewDraft] = createSignal<Draft>(EMPTY_DRAFT);
  const [showDone, setShowDone] = createSignal(false);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [linkDialogTodoId, setLinkDialogTodoId] = createSignal<string | null>(null);
  const [dropTargetId, setDropTargetId] = createSignal<string | null>(null);
  let dragDepth = 0;
  let newTitleRef!: HTMLInputElement;

  createEffect(() => {
    if (creating()) newTitleRef?.focus();
  });

  const todos = list?.todos ?? [];
  const visible = showDone() ? todos : todos.filter((todo) => !todo.done);
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

  const submitNew = async (event: SubmitEvent) => {
    event.preventDefault();
    const title = newDraft().title.trim();
    if (!title) return;
    await run(null, () =>
      window.gemUi.todos.create({
        clientRequestId: createClientRequestId(),
        projectId: project.id,
        title,
        description: newDraft().description.trim(),
      }),
    );
    setNewDraft(EMPTY_DRAFT);
    setCreating(false);
  };

  const submitEdit = async (todo: Todo, event: SubmitEvent) => {
    event.preventDefault();
    const title = draft().title.trim();
    if (!title) return;
    await run(todo.id, () =>
      window.gemUi.todos.update({
        clientRequestId: createClientRequestId(),
        todoId: todo.id,
        title,
        description: draft().description,
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
    <aside class="extension-panel todos-panel" aria-label="Todos dieses Projekts">
      <header class="extension-panel-header todos-panel-header" data-tauri-drag-region>
        <div>
          <span class="extension-panel-icon todos-panel-icon">
            <Icon name="checklist" size={17} />
          </span>
          <div>
            <strong>Todos</strong>
            <span>{subtitle}</span>
          </div>
        </div>
        <button
          class="icon-button"
          type="button"
          onClick={() => setCreating(true)}
          title="Todo anlegen"
          aria-label="Todo anlegen"
        >
          <Icon name="plus" size={17} />
        </button>
        <button
          class="icon-button"
          type="button"
          onClick={onClose}
          title="Panel schließen"
          aria-label="Todos schließen"
        >
          <Icon name="x" size={16} />
        </button>
      </header>

      <div class="extension-panel-body">
        {doneCount > 0 && (
          <div class="todos-filter-bar">
            <label>
              <input
                type="checkbox"
                checked={showDone()}
                onChange={(event) => setShowDone(event.target.checked)}
              />
              Erledigte anzeigen
            </label>
          </div>
        )}

        <div class="extension-panel-scroll">
          {error && (
            <div class="extension-error" role="alert">
              <Icon name="warning" size={17} />
              <p>
                <strong>Todos konnten nicht geladen werden</strong>
                <span>{error}</span>
              </p>
            </div>
          )}

          {creating() && (
            <form class="todo-create-form" onSubmit={(event) => void submitNew(event)}>
              <input
                ref={newTitleRef}
                value={newDraft().title}
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
                value={newDraft().description}
                rows={3}
                placeholder="Beschreibung — das wird später der Prompt (optional)"
                aria-label="Beschreibung des Todos"
                onChange={(event) => setNewDraft((current) => ({ ...current, description: event.target.value }))}
              />
              <div class="todo-form-actions">
                <button
                  class="secondary-button"
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setNewDraft(EMPTY_DRAFT);
                  }}
                >
                  Abbrechen
                </button>
                <button class="primary-button" type="submit" disabled={!newDraft().title.trim()}>
                  <Icon name="plus" size={15} /> Anlegen
                </button>
              </div>
            </form>
          )}

          {loading && !list && (
            <div class="extension-loading">
              <span class="mini-spinner" /> Todos werden geladen …
            </div>
          )}

          {list && visible.length === 0 && !creating() && (
            <div class="extension-empty">
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
            const expanded = expandedId() === todo.id;
            const editing = editingId() === todo.id;
            const busy = busyId() === todo.id;
            return (
              <article

                class={[
                  "todo-row",
                  todo.done ? "todo-row--done" : "",
                  expanded ? "todo-row--expanded" : "",
                  dropTargetId() === todo.id ? "todo-row--drop" : "",
                ].filter(Boolean).join(" ")}
                use:nativeFileDrop={{
                  disabled: !expanded,
                  onActiveChange: (active) => setDropTargetId(active ? todo.id : null),
                  onDrop: (files) => void dropFiles(todo, files),
                }}
                onDragEnter={(event: DragEvent) => {
                  if (!expanded) return;
                  event.preventDefault();
                  dragDepth += 1;
                  setDropTargetId(todo.id);
                }}
                onDragOver={(event: DragEvent) => {
                  if (expanded) event.preventDefault();
                }}
                onDragLeave={() => {
                  dragDepth = Math.max(0, dragDepth - 1);
                  if (dragDepth === 0) setDropTargetId(null);
                }}
                onDrop={(event: DragEvent) => {
                  if (!expanded) return;
                  event.preventDefault();
                  dragDepth = 0;
                  setDropTargetId(null);
                  const files = [...event.dataTransfer.files];
                  if (files.length) void dropFiles(todo, files);
                }}
              >
                <div class="todo-row-head">
                  <label class="todo-check" title={todo.done ? "Wieder öffnen" : "Als erledigt markieren"}>
                    <input
                      type="checkbox"
                      checked={todo.done}
                      disabled={busy}
                      onChange={() => void toggleDone(todo)}
                      aria-label={`„${todo.title}“ ${todo.done ? "wieder öffnen" : "als erledigt markieren"}`}
                    />
                  </label>
                  <button
                    class="todo-main"
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : todo.id)}
                  >
                    <strong>{todo.title}</strong>
                    <small>
                      {todo.attachments.length > 0 && (
                        <span class="todo-attachment-count">
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
                  <div class="todo-row-body">
                    {editing ? (
                      <form class="todo-edit-form" onSubmit={(event) => void submitEdit(todo, event)}>
                        <input
                          value={draft().title}
                          maxLength={200}
                          aria-label="Titel des Todos"
                          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                        />
                        <textarea
                          value={draft().description}
                          rows={6}
                          aria-label="Beschreibung des Todos"
                          placeholder="Beschreibung — das wird der Prompt"
                          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                        />
                        <div class="todo-form-actions">
                          <button class="secondary-button" type="button" onClick={() => setEditingId(null)}>
                            Abbrechen
                          </button>
                          <button class="primary-button" type="submit" disabled={busy || !draft().title.trim()}>
                            Speichern
                          </button>
                        </div>
                      </form>
                    ) : (
                      todo.description.trim() && <p class="todo-description">{todo.description}</p>
                    )}

                    <div class="todo-attachments">
                      {todo.attachments.map((attachment) => (
                        <span class="todo-attachment" >
                          <Icon name={attachmentIcon(attachment)} size={13} />
                          <button
                            type="button"
                            class="todo-attachment-title"
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
                            class="todo-attachment-remove"
                            title="Vom Todo lösen — bleibt Projektanhang"
                            aria-label={`„${attachment.title}“ von diesem Todo lösen`}
                            onClick={() => void detach(todo, attachment)}
                          >
                            <Icon name="x" size={13} />
                          </button>
                        </span>
                      ))}
                      <div class="todo-attachment-actions">
                        <button type="button" class="ghost-button" disabled={busy} onClick={() => void addFiles(todo)}>
                          <Icon name="paperclip" size={14} /> Datei
                        </button>
                        <button type="button" class="ghost-button" disabled={busy} onClick={() => setLinkDialogTodoId(todo.id)}>
                          <Icon name="link" size={14} /> Link
                        </button>
                      </div>
                    </div>

                    <div class="todo-send-actions">
                      <button
                        class="primary-button"
                        type="button"
                        disabled={busy || !hasActiveSession}
                        title={hasActiveSession
                          ? "Titel, Beschreibung und Anhänge in die offene Session übernehmen"
                          : "Es ist keine Session geöffnet"}
                        onClick={() => void send(todo, "current")}
                      >
                        {busy ? <span class="mini-spinner" /> : <Icon name="arrow-up" size={15} />}
                        In diese Session
                      </button>
                      <button
                        class="secondary-button"
                        type="button"
                        disabled={busy}
                        title="Neue Session anlegen und das Todo dort übernehmen"
                        onClick={() => void send(todo, "new")}
                      >
                        <Icon name="plus" size={15} /> Neue Session
                      </button>
                    </div>
                    <p class="todo-send-hint">
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
        open={linkDialogTodoId() !== null}
        scopeLabel="Anhang für dieses Todo"
        onClose={() => setLinkDialogTodoId(null)}
        onSubmit={async (url, title) => {
          const todoId = linkDialogTodoId();
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
    <details ref={menuRef} class="todo-menu context-attachment-menu">
      <summary aria-label={`Aktionen für ${todo.title}`}><Icon name="more" size={16} /></summary>
      <div>
        <button type="button" onClick={onEdit}><Icon name="pencil" size={13} /> Bearbeiten</button>
        <button class="danger-menu-item" type="button" onClick={onDelete}>
          <Icon name="trash" size={13} /> Löschen
        </button>
      </div>
    </details>
  );
}
