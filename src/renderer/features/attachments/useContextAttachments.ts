import { useCallback, useEffect, useState } from "react";

import type {
  AppProject,
  ContextAttachment,
  ContextAttachmentList,
} from "../../types";

type Input = {
  project: AppProject | null;
  sessionId: string | null;
};

export type ContextAttachmentsState = {
  list: ContextAttachmentList | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  all: ContextAttachment[];
  included: ContextAttachment[];
  refresh: () => Promise<void>;
  apply: (list: ContextAttachmentList) => void;
};

export function useContextAttachments({
  project,
  sessionId,
}: Input): ContextAttachmentsState {
  const [list, setList] = useState<ContextAttachmentList | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((next: ContextAttachmentList) => {
    setList(next);
    setLoading(false);
    setRefreshing(false);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!project) return;
    list ? setRefreshing(true) : setLoading(true);
    try {
      apply(await window.gemUi.contextAttachments.list({
        projectId: project.id,
        sessionId,
      }));
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apply, list, project, sessionId]);

  useEffect(() => {
    setList(null);
    setError(null);
    setLoading(Boolean(project));
    if (!project) return;
    let current = true;
    let unsubscribe: (() => void) | undefined;
    window.gemUi.contextAttachments.subscribe(
      { projectId: project.id, sessionId },
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
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [apply, project?.id, project?.rootRevision, sessionId]);

  const all = list
    ? [...list.projectAttachments, ...list.sessionAttachments]
    : [];
  return {
    list,
    loading,
    refreshing,
    error,
    all,
    included: all.filter((attachment) => attachment.includedInContext),
    refresh,
    apply,
  };
}

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Anhänge konnten nicht geladen werden.";
}
