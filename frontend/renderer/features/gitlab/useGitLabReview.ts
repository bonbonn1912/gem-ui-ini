import { createEffect, createSignal } from "solid-js";
import type {
  GitLabDiscussion,
  GitLabMergeRequestSummary,
  GitLabRepositoryCandidate,
  GitLabReviewState,
  PreparedExternalContext,
} from "../../types";

export function useGitLabReview(projectId: string | null, rootRevision = 1) {
  const [candidates, setCandidates] = createSignal<GitLabRepositoryCandidate[]>([]);
  const [selectedBindingId, setSelectedBindingId] = createSignal<string | null>(null);
  const [reviewState, setReviewState] = createSignal<GitLabReviewState | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [mergeRequests, setMergeRequests] = createSignal<GitLabMergeRequestSummary[]>([]);
  const [mergeRequestsLoading, setMergeRequestsLoading] = createSignal(false);

  const loadCandidates = async () => {
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
  };

  createEffect(() => {
    void loadCandidates();
  });

  // Subscribe to review state when binding is selected
  createEffect(() => {
    if (!projectId || !selectedBindingId()) {
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
          bindingId: selectedBindingId(),
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
  });

  // Offene Merge Requests werden selbstständig geladen, sobald ein Repository
  // gewählt ist — es gibt bewusst keine manuelle MR-URL-Eingabe mehr.
  const loadMergeRequests = async () => {
    if (!projectId || !selectedBindingId()) {
      setMergeRequests([]);
      return;
    }
    setMergeRequestsLoading(true);
    try {
      const list = await window.gemUi.gitlab.listMergeRequests({
        projectId,
        expectedRootRevision: rootRevision,
        bindingId: selectedBindingId(),
      });
      setMergeRequests(list);
    } catch (err) {
      setMergeRequests([]);
      setError((err as Error).message);
    } finally {
      setMergeRequestsLoading(false);
    }
  };

  createEffect(() => {
    void loadMergeRequests();
  });

  const refresh = async () => {
    if (!projectId || !selectedBindingId()) return;
    setLoading(true);
    setError(null);
    try {
      const state = await window.gemUi.gitlab.getReviewState({
        projectId,
        expectedRootRevision: rootRevision,
        bindingId: selectedBindingId(),
      });
      setReviewState(state);
      void loadMergeRequests();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const selectMergeRequest =
    async (targetProjectId: number, targetProjectPath: string, mergeRequestIid: number) => {
      if (!projectId || !selectedBindingId()) return;
      setLoading(true);
      try {
        const clientRequestId = globalThis.crypto.randomUUID();
        await window.gemUi.gitlab.selectMergeRequest({
          clientRequestId,
          projectId,
          expectedRootRevision: rootRevision,
          bindingId: selectedBindingId(),
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
    };

  const resolveDiscussion =
    async (
      targetProjectId: number,
      mergeRequestIid: number,
      discussionId: string,
      resolved: boolean,
    ): Promise<GitLabDiscussion | undefined> => {
      if (!projectId || !selectedBindingId()) return;
      const clientRequestId = globalThis.crypto.randomUUID();
      const updated = await window.gemUi.gitlab.resolveDiscussion({
        clientRequestId,
        projectId,
        expectedRootRevision: rootRevision,
        bindingId: selectedBindingId(),
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
    };

  const replyToDiscussion =
    async (
      targetProjectId: number,
      mergeRequestIid: number,
      discussionId: string,
      body: string,
    ): Promise<GitLabDiscussion | undefined> => {
      if (!projectId || !selectedBindingId()) return;
      const clientRequestId = globalThis.crypto.randomUUID();
      const updated = await window.gemUi.gitlab.replyToDiscussion({
        clientRequestId,
        projectId,
        expectedRootRevision: rootRevision,
        bindingId: selectedBindingId(),
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
    };

  const prepareReviewContext =
    async (
      targetProjectId: number,
      mergeRequestIid: number,
      discussionId: string,
      contextMode: "affected_lines" | "whole_file",
      selectedNoteId?: number | null,
    ): Promise<PreparedExternalContext | undefined> => {
      if (!projectId || !selectedBindingId()) return;
      return window.gemUi.gitlab.prepareReviewContext({
        projectId,
        expectedRootRevision: rootRevision,
        bindingId: selectedBindingId(),
        targetProjectId,
        mergeRequestIid,
        discussionId,
        selectedNoteId,
        contextMode,
      });
    };

  const enabledBindings = candidates().filter((c) => c.binding?.enabled).map((c) => c.binding!);

  return {
    candidates: candidates(),
    enabledBindings,
    selectedBindingId: selectedBindingId(),
    setSelectedBindingId,
    reviewState: reviewState(),
    loading: loading(),
    error: error(),
    mergeRequests: mergeRequests(),
    mergeRequestsLoading: mergeRequestsLoading(),
    loadMergeRequests,
    refresh,
    loadCandidates,
    selectMergeRequest,
    resolveDiscussion,
    replyToDiscussion,
    prepareReviewContext,
  };
}
