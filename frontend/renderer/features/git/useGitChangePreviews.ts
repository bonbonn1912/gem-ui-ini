import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

import type {
  AppProject,
  GitDiffLine,
  GitFileChange,
  GitFileDiff,
  GitProjectStatus,
} from "../../types";
import type { DiffSelection } from "./DiffViewer";

const MAX_PREVIEW_FILES = 3;
const MAX_PREVIEW_LINES = 12;

export type GitPreviewTrigger = {
  id: number;
  toolCallId: string;
  turnId: string | null;
  baseline: ReadonlyMap<string, string>;
  statusRefreshedAt: string | null;
};

export type GitFilePreview = DiffSelection & {
  key: string;
  repositoryLabel: string;
  previousPath: string | null;
  state: GitFileDiff["state"];
  message: string | null;
  additions: number;
  deletions: number;
  lines: GitDiffLine[];
};

export type GitPreviewGroup = {
  toolCallId: string;
  turnId: string | null;
  loading: boolean;
  totalFiles: number;
  previews: GitFilePreview[];
};

type UseGitChangePreviewsInput = {
  sessionId: Accessor<string | null>;
  project: Accessor<AppProject | null>;
  status: Accessor<GitProjectStatus | null>;
  trigger: Accessor<GitPreviewTrigger | null>;
};

export function useGitChangePreviews({
  sessionId,
  project,
  status,
  trigger,
}: UseGitChangePreviewsInput): Accessor<ReadonlyMap<string, GitPreviewGroup>> {
  const [groups, setGroups] = createSignal<ReadonlyMap<string, GitPreviewGroup>>(new Map());

  createEffect(() => {
    setGroups(new Map());
  });

  createEffect(() => {
    const currentTrigger = trigger();
    if (!currentTrigger) return;
    setGroups((current) => {
      const next = new Map(current);
      next.set(currentTrigger.toolCallId, {
        toolCallId: currentTrigger.toolCallId,
        turnId: currentTrigger.turnId,
        loading: true,
        totalFiles: 0,
        previews: [],
      });
      return next;
    });
  });

  createEffect(() => {
    const currentProject = project();
    const currentStatus = status();
    const currentTrigger = trigger();
    if (!currentProject || !currentStatus || !currentTrigger) return;
    if (currentStatus.projectId !== currentProject.id) return;
    if (currentStatus.refreshedAt === currentTrigger.statusRefreshedAt) return;

    const candidates = currentStatus.changes.filter((change) =>
      currentTrigger.baseline.get(changeKey(change)) !== change.fileId,
    );
    if (candidates.length === 0) {
      setGroups((current) => {
        const next = new Map(current);
        next.delete(currentTrigger.toolCallId);
        return next;
      });
      return;
    }

    let current = true;
    const load = async () => {
      const previews: GitFilePreview[] = [];
      for (const change of candidates.slice(0, MAX_PREVIEW_FILES)) {
        if (!current) return;
        const area = previewArea(change);
        try {
          const diff = await window.gemUi.git.getFileDiff({
            projectId: currentProject.id,
            expectedRootRevision: currentProject.rootRevision,
            repositoryId: change.repositoryId,
            fileId: change.fileId,
            area,
          });
          const repository = currentStatus.repositories.find((candidate) =>
            candidate.repositoryId === change.repositoryId,
          );
          previews.push(toPreview(
            change,
            area,
            diff,
            repository?.worktreeLabel ?? repository?.displayName ?? "Repository",
          ));
        } catch {
          // A newer status can invalidate an opaque file id while previews are
          // loading. The next status/trigger will request the current one.
        }
      }
      if (!current) return;
      setGroups((existing) => {
        const next = new Map(existing);
        if (previews.length === 0) {
          next.delete(currentTrigger.toolCallId);
          return next;
        }
        next.set(currentTrigger.toolCallId, {
          toolCallId: currentTrigger.toolCallId,
          turnId: currentTrigger.turnId,
          loading: false,
          totalFiles: candidates.length,
          previews,
        });
        return next;
      });
    };
    void load();
    onCleanup(() => { current = false; });
  });

  return groups;
}

export function gitStatusBaseline(
  status: GitProjectStatus | null,
): ReadonlyMap<string, string> {
  return new Map(
    status?.changes.map((change) => [changeKey(change), change.fileId]) ?? [],
  );
}

function changeKey(change: Pick<GitFileChange, "repositoryId" | "path">): string {
  return `${change.repositoryId}\0${change.path}`;
}

function previewArea(change: GitFileChange): DiffSelection["area"] {
  return change.worktreeStatus !== "." || change.untracked || change.conflict
    ? "unstaged"
    : "staged";
}

function toPreview(
  change: GitFileChange,
  area: DiffSelection["area"],
  diff: GitFileDiff,
  repositoryLabel: string,
): GitFilePreview {
  return {
    key: `${change.repositoryId}:${change.path}:${area}`,
    repositoryId: change.repositoryId,
    fileId: change.fileId,
    path: change.path,
    area,
    repositoryLabel,
    previousPath: change.previousPath,
    state: diff.state,
    message: diff.message,
    additions: diff.additions,
    deletions: diff.deletions,
    lines: compactLines(diff),
  };
}

function compactLines(diff: GitFileDiff): GitDiffLine[] {
  if (diff.state !== "text") return [];
  const selected: GitDiffLine[] = [];
  for (const hunk of diff.hunks) {
    const indexes = new Set<number>();
    hunk.lines.forEach((line, index) => {
      if (line.kind !== "addition" && line.kind !== "deletion") return;
      if (index > 0) indexes.add(index - 1);
      indexes.add(index);
      if (index + 1 < hunk.lines.length) indexes.add(index + 1);
    });
    for (const index of [...indexes].sort((left, right) => left - right)) {
      const line = hunk.lines[index];
      if (line) selected.push(line);
      if (selected.length >= MAX_PREVIEW_LINES) return selected;
    }
  }
  return selected;
}
