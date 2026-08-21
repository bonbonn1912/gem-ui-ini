import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AppCapabilities,
  AppProject,
  GitProjectStatus,
} from "../../types";

type UseGitProjectStatusInput = {
  project: AppProject | null;
  refreshToken: number;
  onCapabilitiesChange: (capabilities: AppCapabilities) => void;
};

export type GitProjectStatusState = {
  status: GitProjectStatus | null;
  loading: boolean;
  refreshing: boolean;
  choosingGit: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  chooseGit: () => Promise<void>;
};

export function useGitProjectStatus({
  project,
  refreshToken,
  onCapabilitiesChange,
}: UseGitProjectStatusInput): GitProjectStatusState {
  const [status, setStatus] = useState<GitProjectStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [choosingGit, setChoosingGit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef<GitProjectStatus | null>(null);
  const handledRefreshToken = useRef(0);

  const applyStatus = useCallback((next: GitProjectStatus) => {
    statusRef.current = next;
    setStatus(next);
    setLoading(false);
    setRefreshing(false);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!project) return;
    if (statusRef.current) setRefreshing(true);
    else setLoading(true);
    try {
      applyStatus(await window.gemUi.git.getProjectStatus({
        projectId: project.id,
        expectedRootRevision: project.rootRevision,
      }));
    } catch (reason) {
      setError(messageFrom(reason, "Änderungen konnten nicht geladen werden."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [applyStatus, project]);

  const chooseGit = useCallback(async () => {
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
  }, [onCapabilitiesChange, refresh]);

  useEffect(() => {
    setStatus(null);
    statusRef.current = null;
    setError(null);
    setLoading(Boolean(project));
    setRefreshing(false);
    if (!project) return;

    let current = true;
    let unsubscribe: (() => void) | undefined;
    window.gemUi.git.subscribeProjectStatus(
      {
        projectId: project.id,
        expectedRootRevision: project.rootRevision,
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
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [applyStatus, project?.id, project?.rootRevision]);

  useEffect(() => {
    if (refreshToken <= handledRefreshToken.current) return;
    handledRefreshToken.current = refreshToken;
    void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    if (!project) return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [project, refresh]);

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
