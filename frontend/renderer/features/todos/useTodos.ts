import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

import type { AppProject, Todo, TodoList } from "../../types";

type Input = {
  project: Accessor<AppProject | null>;
};

export type TodosState = {
  list: Accessor<TodoList | null>;
  loading: Accessor<boolean>;
  error: Accessor<string | null>;
  todos: Accessor<Todo[]>;
  openCount: Accessor<number>;
  refresh: () => Promise<void>;
  apply: (list: TodoList) => void;
};

/**
 * Todos are project state, so unlike the attachment list this subscription does
 * not restart when the session changes — only when the project does.
 */
export function useTodos({ project }: Input): TodosState {
  const [list, setList] = createSignal<TodoList | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const apply = (next: TodoList) => {
    setList(next);
    setLoading(false);
    setError(null);
  };

  const refresh = async () => {
    const currentProject = project();
    if (!currentProject) return;
    try {
      apply(await window.gemUi.todos.list({ projectId: currentProject.id }));
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    setList(null);
    setError(null);
    const currentProject = project();
    setLoading(Boolean(currentProject));
    if (!currentProject) return;
    let current = true;
    let unsubscribe: (() => void) | undefined;
    window.gemUi.todos
      .subscribe({ projectId: currentProject.id }, (next) => {
        if (current) apply(next);
      })
      .then((dispose) => {
        if (current) unsubscribe = dispose;
        else dispose();
      })
      .catch((reason) => {
        if (!current) return;
        setLoading(false);
        setError(messageFrom(reason));
      });
    onCleanup(() => {
      current = false;
      unsubscribe?.();
    });
  });

  return {
    list,
    loading,
    error,
    todos: createMemo(() => list()?.todos ?? []),
    openCount: createMemo(() => list()?.openCount ?? 0),
    refresh,
    apply,
  };
}

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Todos konnten nicht geladen werden.";
}
