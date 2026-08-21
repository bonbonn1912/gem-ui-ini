import { useCallback, useEffect, useState } from "react";

import type { AppProject, Todo, TodoList } from "../../types";

type Input = {
  project: AppProject | null;
};

export type TodosState = {
  list: TodoList | null;
  loading: boolean;
  error: string | null;
  todos: Todo[];
  openCount: number;
  refresh: () => Promise<void>;
  apply: (list: TodoList) => void;
};

/**
 * Todos are project state, so unlike the attachment list this subscription does
 * not restart when the session changes — only when the project does.
 */
export function useTodos({ project }: Input): TodosState {
  const [list, setList] = useState<TodoList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((next: TodoList) => {
    setList(next);
    setLoading(false);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      apply(await window.gemUi.todos.list({ projectId: project.id }));
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
  }, [apply, project]);

  useEffect(() => {
    setList(null);
    setError(null);
    setLoading(Boolean(project));
    if (!project) return;
    let current = true;
    let unsubscribe: (() => void) | undefined;
    window.gemUi.todos
      .subscribe({ projectId: project.id }, (next) => {
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
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [apply, project?.id]);

  return {
    list,
    loading,
    error,
    todos: list?.todos ?? [],
    openCount: list?.openCount ?? 0,
    refresh,
    apply,
  };
}

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Todos konnten nicht geladen werden.";
}
