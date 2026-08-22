import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

import type {
  AppCapabilities,
  AppProject,
  GitProjectStatus,
} from "../../types";

type UseGitProjectStatusInput = {
  project: Accessor<AppProject | null>;
  refreshToken: Accessor<number>;
  onCapabilitiesChange: (capabilities: AppCapabilities) => void;
};

export type GitProjectStatusState = {
  status: Accessor<GitProjectStatus | null>;
  loading: Accessor<boolean>;
  refreshing: Accessor<boolean>;
  choosingGit: Accessor<boolean>;
  error: Accessor<string | null>;
  refresh: () => Promise<void>;
  chooseGit: () => Promise<void>;
};

export function useGitProjectStatus({
  project,
  refreshToken,
  onCapabilitiesChange,
}: UseGitProjectStatusInput): GitProjectStatusState {
  const [status, setStatus] = createSignal<GitProjectStatus | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [choosingGit, setChoosingGit] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let statusRef: GitProjectStatus | null = null;
  let handledRefreshToken = 0;

  const applyStatus = (next: GitProjectStatus) => {
    statusRef = next;
    setStatus(next);
    setLoading(false);
    setRefreshing(false);
    setError(null);
  };

  const refresh = async () => {
    const currentProject = project();
    if (!currentProject) return;
    if (statusRef) setRefreshing(true);
    else setLoading(true);
    try {
      applyStatus(await window.gemUi.git.getProjectStatus({
        projectId: currentProject.id,
        expectedRootRevision: currentProject.rootRevision,
      }));
    } catch (reason) {
      setError(messageFrom(reason, "Änderungen konnten nicht geladen werden."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const chooseGit = async () => {
    setChoosingGit(true);
    try {
      const capabilities = await window.gemUi.settings.chooseGitBinary();
      onCapabilitiesChange(capabilities);
      await refresh();
    } catch (reason) {
      setError(messageFrom(reason, "Git konnte nicht ausgewählt werden."));
    } finally {
      setChoosingGit(false);
    }
  };

  createEffect(() => {
    setStatus(null);
    statusRef = null;
    setError(null);
    const currentProject = project();
    setLoading(Boolean(currentProject));
    setRefreshing(false);
    if (!currentProject) return;

    let current = true;
    let unsubscribe: (() => void) | undefined;
    window.gemUi.git.subscribeProjectStatus(
      {
        projectId: currentProject.id,
        expectedRootRevision: currentProject.rootRevision,
      },
      (next) => {
        if (current) applyStatus(next);
      },
    ).then((dispose) => {
      if (current) unsubscribe = dispose;
      else dispose();
    }).catch((reason) => {
      if (!current) return;
      setLoading(false);
      setError(messageFrom(reason, "Git-Status konnte nicht abonniert werden."));
    });
    onCleanup(() => {
      current = false;
      unsubscribe?.();
    });
  });

  createEffect(() => {
    const token = refreshToken();
    if (token <= handledRefreshToken) return;
    handledRefreshToken = token;
    void refresh();
  });

  createEffect(() => {
    if (!project()) return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    onCleanup(() => window.removeEventListener("focus", onFocus));
  });

  return {
    status,
    loading,
    refreshing,
    choosingGit,
    error,
    refresh,
    chooseGit,
  };
}

function messageFrom(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}
