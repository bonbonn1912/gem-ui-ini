import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

import type {
  AppProject,
  ContextAttachment,
  ContextAttachmentList,
} from "../../types";

type Input = {
  project: Accessor<AppProject | null>;
  sessionId: Accessor<string | null>;
};

export type ContextAttachmentsState = {
  list: Accessor<ContextAttachmentList | null>;
  loading: Accessor<boolean>;
  refreshing: Accessor<boolean>;
  error: Accessor<string | null>;
  all: Accessor<ContextAttachment[]>;
  included: Accessor<ContextAttachment[]>;
  refresh: () => Promise<void>;
  apply: (list: ContextAttachmentList) => void;
};

export function useContextAttachments({
  project,
  sessionId,
}: Input): ContextAttachmentsState {
  const [list, setList] = createSignal<ContextAttachmentList | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const apply = (next: ContextAttachmentList) => {
    setList(next);
    setLoading(false);
    setRefreshing(false);
    setError(null);
  };

  const refresh = async () => {
    const currentProject = project();
    if (!currentProject) return;
    list() ? setRefreshing(true) : setLoading(true);
    try {
      apply(await window.gemUi.contextAttachments.list({
        projectId: currentProject.id,
        sessionId: sessionId(),
      }));
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  createEffect(() => {
    setList(null);
    setError(null);
    const currentProject = project();
    const currentSession = sessionId();
    setLoading(Boolean(currentProject));
    if (!currentProject) return;
    let current = true;
    let unsubscribe: (() => void) | undefined;
    window.gemUi.contextAttachments.subscribe(
      { projectId: currentProject.id, sessionId: currentSession },
      (next) => {
        if (current) apply(next);
      },
    ).then((dispose) => {
      if (current) unsubscribe = dispose;
      else dispose();
    }).catch((reason) => {
      if (!current) return;
      setLoading(false);
      setError(messageFrom(reason));
    });
    onCleanup(() => {
      current = false;
      unsubscribe?.();
    });
  });

  const all = createMemo(() => list()
    ? [...list().projectAttachments, ...list().sessionAttachments]
    : []);
  return {
    list,
    loading,
    refreshing,
    error,
    all,
    included: createMemo(() => all().filter((attachment) => attachment.includedInContext)),
    refresh,
    apply,
  };
}

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Anhänge konnten nicht geladen werden.";
}
