import { useCallback, useEffect, useState } from "react";
import type {
  GitLabDiscussion,
  GitLabMergeRequestSummary,
  GitLabRepositoryBinding,
  GitLabRepositoryCandidate,
  GitLabReviewState,
  PreparedExternalContext,
} from "../../types";

export function useGitLabReview(projectId: string | null, rootRevision = 1) {
  const [candidates, setCandidates] = useState<GitLabRepositoryCandidate[]>([]);
  const [selectedBindingId, setSelectedBindingId] = useState<string | null>(null);
  const [reviewState, setReviewState] = useState<GitLabReviewState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCandidates = useCallback(async () => {
    if (!projectId) {
      setCandidates([]);
      return;
    }
    try {
      const list = await window.gemUi.gitlab.listRepositoryCandidates({ projectId });
      setCandidates(list);
      const enabled = list.filter((c) => c.binding?.enabled).map((c) => c.binding!);
      if (enabled.length > 0) {
        setSelectedBindingId((prev) => (prev && enabled.some((b) => b.id === prev) ? prev : enabled[0]!.id));
      } else {
        setSelectedBindingId(null);
        setReviewState(null);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  // Subscribe to review state when binding is selected
  useEffect(() => {
    if (!projectId || !selectedBindingId) {
      setReviewState(null);
      return;
    }

    let unsubscribe: (() => void) | null = null;
    let isCurrent = true;
    setLoading(true);
    setError(null);

    window.gemUi.gitlab
      .subscribeReviewState(
        {
          projectId,
          expectedRootRevision: rootRevision,
          bindingId: selectedBindingId,
        },
        (state) => {
          if (!isCurrent) return;
          setReviewState(state);
          setLoading(false);
        },
      )
      .then((unsub) => {
        if (!isCurrent) {
          unsub();
        } else {
          unsubscribe = unsub;
        }
      })
      .catch((err) => {
        if (!isCurrent) return;
        setError((err as Error).message);
        setLoading(false);
      });

    return () => {
      isCurrent = false;
      unsubscribe?.();
    };
  }, [projectId, selectedBindingId, rootRevision]);

  const refresh = useCallback(async () => {
    if (!projectId || !selectedBindingId) return;
    setLoading(true);
    setError(null);
    try {
      const state = await window.gemUi.gitlab.getReviewState({
        projectId,
        expectedRootRevision: rootRevision,
        bindingId: selectedBindingId,
      });
      setReviewState(state);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, selectedBindingId, rootRevision]);

  const selectMergeRequest = useCallback(
    async (targetProjectId: number, targetProjectPath: string, mergeRequestIid: number) => {
      if (!projectId || !selectedBindingId) return;
      setLoading(true);
      try {
        const clientRequestId = globalThis.crypto.randomUUID();
        await window.gemUi.gitlab.selectMergeRequest({
          clientRequestId,
          projectId,
          expectedRootRevision: rootRevision,
          bindingId: selectedBindingId,
          targetProjectId,
          targetProjectPath,
          mergeRequestIid,
        });
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [projectId, selectedBindingId, rootRevision, refresh],
  );

  const connectMergeRequestUrl = useCallback(
    async (mergeRequestUrl: string) => {
      if (!projectId || !selectedBindingId) return;
      setLoading(true);
      try {
        const clientRequestId = globalThis.crypto.randomUUID();
        await window.gemUi.gitlab.connectMergeRequestUrl({
          clientRequestId,
          projectId,
          expectedRootRevision: rootRevision,
          bindingId: selectedBindingId,
          mergeRequestUrl,
        });
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [projectId, selectedBindingId, rootRevision, refresh],
  );

  const resolveDiscussion = useCallback(
    async (
      targetProjectId: number,
      mergeRequestIid: number,
      discussionId: string,
      resolved: boolean,
    ): Promise<GitLabDiscussion | undefined> => {
      if (!projectId || !selectedBindingId) return;
      const clientRequestId = globalThis.crypto.randomUUID();
      const updated = await window.gemUi.gitlab.resolveDiscussion({
        clientRequestId,
        projectId,
        expectedRootRevision: rootRevision,
        bindingId: selectedBindingId,
        targetProjectId,
        mergeRequestIid,
        discussionId,
        resolved,
      });

      // Update locally
      setReviewState((prev) => {
        if (!prev) return prev;
        const discussions = prev.discussions.map((d) => (d.id === discussionId ? updated : d));
        const unresolved = discussions.filter((d) => d.resolvable && !d.resolved).length;
        return {
          ...prev,
          discussions,
          unresolvedDiscussionsCount: unresolved,
        };
      });

      return updated;
    },
    [projectId, selectedBindingId, rootRevision],
  );

  const replyToDiscussion = useCallback(
    async (
      targetProjectId: number,
      mergeRequestIid: number,
      discussionId: string,
      body: string,
    ): Promise<GitLabDiscussion | undefined> => {
      if (!projectId || !selectedBindingId) return;
      const clientRequestId = globalThis.crypto.randomUUID();
      const updated = await window.gemUi.gitlab.replyToDiscussion({
        clientRequestId,
        projectId,
        expectedRootRevision: rootRevision,
        bindingId: selectedBindingId,
        targetProjectId,
        mergeRequestIid,
        discussionId,
        body,
      });

      setReviewState((prev) => {
        if (!prev) return prev;
        const discussions = prev.discussions.map((d) => (d.id === discussionId ? updated : d));
        return {
          ...prev,
          discussions,
        };
      });

      return updated;
    },
    [projectId, selectedBindingId, rootRevision],
  );

  const prepareReviewContext = useCallback(
    async (
      targetProjectId: number,
      mergeRequestIid: number,
      discussionId: string,
      contextMode: "affected_lines" | "whole_file",
      selectedNoteId?: number | null,
    ): Promise<PreparedExternalContext | undefined> => {
      if (!projectId || !selectedBindingId) return;
      return window.gemUi.gitlab.prepareReviewContext({
        projectId,
        expectedRootRevision: rootRevision,
        bindingId: selectedBindingId,
        targetProjectId,
        mergeRequestIid,
        discussionId,
        selectedNoteId,
        contextMode,
      });
    },
    [projectId, selectedBindingId, rootRevision],
  );

  const enabledBindings = candidates.filter((c) => c.binding?.enabled).map((c) => c.binding!);

  return {
    candidates,
    enabledBindings,
    selectedBindingId,
    setSelectedBindingId,
    reviewState,
    loading,
    error,
    refresh,
    loadCandidates,
    selectMergeRequest,
    connectMergeRequestUrl,
    resolveDiscussion,
    replyToDiscussion,
    prepareReviewContext,
  };
}
