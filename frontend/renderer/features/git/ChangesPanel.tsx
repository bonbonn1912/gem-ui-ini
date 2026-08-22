import { createEffect, createMemo } from "solid-js";

import { Icon } from "../../components/Icon";
import type {
  AppProject,
  GitFileChange,
  GitProjectStatus,
  GitRepositorySummary,
} from "../../types";
import { DiffViewer, type DiffSelection } from "./DiffViewer";

type ChangesPanelProps = {
  open: boolean;
  project: AppProject;
  status: GitProjectStatus | null;
  loading: boolean;
  refreshing: boolean;
  choosingGit: boolean;
  error: string | null;
  selection: DiffSelection | null;
  onClose: () => void;
  onSelectionChange: (selection: DiffSelection | null) => void;
  onRefresh: () => void;
  onChooseGit: () => void;
};

export function ChangesPanel(props: ChangesPanelProps) {
  createEffect(() => {
    if (!props.selection || !props.status) return;
    const replacement = props.status.changes.find((change) =>
      change.repositoryId === props.selection!.repositoryId && change.path === props.selection!.path,
    );
    if (!replacement || !supportsArea(replacement, props.selection.area)) {
      props.onSelectionChange(null);
    } else if (replacement.fileId !== props.selection.fileId) {
      props.onSelectionChange({ ...props.selection, fileId: replacement.fileId });
    }
  });

  const selectedChange = createMemo(() => props.selection
    ? props.status?.changes.find((change) => change.fileId === props.selection!.fileId) ?? null
    : null);

  return (
    <aside class={`changes-panel ${props.open ? "changes-panel--open" : ""}`} aria-label="Git-Änderungen" aria-hidden={!props.open}>
      <header class="changes-panel-header" data-tauri-drag-region>
        <div>
          <span class="changes-panel-icon"><Icon name="changes" size={17} /></span>
          <div><strong>Änderungen</strong><span>{props.status ? `${props.status.changes.length} Dateien` : "Git-Worktrees"}</span></div>
        </div>
        <button class="icon-button" type="button" onClick={props.onRefresh} disabled={props.loading || props.refreshing} aria-label="Git-Änderungen aktualisieren">
          {props.loading || props.refreshing ? <span class="mini-spinner" /> : <Icon name="refresh" size={16} />}
        </button>
        <button class="icon-button" type="button" onClick={props.onClose} aria-label="Änderungen schließen"><Icon name="x" size={16} /></button>
      </header>

      <div class={`changes-panel-body ${props.selection ? "changes-panel-body--diff" : ""}`}>
        <div class="changes-list-pane">
          {props.error && <div class="changes-error" role="alert"><Icon name="warning" size={17} /><p>{props.error}</p><button type="button" onClick={props.onRefresh}>Erneut</button></div>}
          {!props.status && props.loading ? (
            <div class="changes-loading"><span class="mini-spinner" /><p>Repositories werden geprüft …</p></div>
          ) : props.status ? (
            <RepositoryList
              status={props.status}
              selection={props.selection}
              onSelect={props.onSelectionChange}
              onChooseGit={props.onChooseGit}
              choosingGit={props.choosingGit}
            />
          ) : null}
        </div>
        <div class="changes-diff-pane">
          <DiffViewer
            project={props.project}
            selection={props.selection}
            change={selectedChange()}
            onBack={() => props.onSelectionChange(null)}
          />
        </div>
      </div>
    </aside>
  );
}

function RepositoryList(props: {
  status: GitProjectStatus;
  selection: DiffSelection | null;
  onSelect: (selection: DiffSelection) => void;
  onChooseGit: () => void;
  choosingGit: boolean;
}) {
  return (
    <div class="repository-list">
      {props.status.repositories.map((repository) => (
        <RepositoryGroup

          repository={repository}
          changes={props.status.changes.filter((change) => change.repositoryId === repository.repositoryId)}
          selection={props.selection}
          onSelect={props.onSelect}
          onChooseGit={props.onChooseGit}
          choosingGit={props.choosingGit}
        />
      ))}
    </div>
  );
}

function RepositoryGroup({
  repository,
  changes,
  selection,
  onSelect,
  onChooseGit,
  choosingGit,
}: {
  repository: GitRepositorySummary;
  changes: GitFileChange[];
  selection: DiffSelection | null;
  onSelect: (selection: DiffSelection) => void;
  onChooseGit: () => void;
  choosingGit: boolean;
}) {
  const groups = createMemo(() => [
    { key: "conflicts", title: "Konflikte", changes: changes.filter((change) => change.conflict), area: "unstaged" as const },
    { key: "staged", title: "Vorgemerkt", changes: changes.filter((change) => !change.conflict && change.indexStatus !== "." && !change.untracked), area: "staged" as const },
    { key: "unstaged", title: "Änderungen", changes: changes.filter((change) => !change.conflict && !change.untracked && change.worktreeStatus !== "."), area: "unstaged" as const },
    { key: "untracked", title: "Unversioniert", changes: changes.filter((change) => change.untracked), area: "unstaged" as const },
  ]);

  return (
    <section class="repository-group">
      <header>
        <div><Icon name="branch" size={14} /><strong>{repository.displayName}</strong></div>
        {repository.state === "ready" && (
          <span title={repository.upstream ?? undefined}>
            {repository.branch ?? "Detached HEAD"}
            {(repository.ahead > 0 || repository.behind > 0) && ` · ↑${repository.ahead} ↓${repository.behind}`}
          </span>
        )}
      </header>
      {repository.state !== "ready" ? (
        <div class={`repository-state repository-state--${repository.state}`}>
          <Icon name={repository.state === "outside_authority" || repository.state === "error" ? "warning" : "folder"} size={17} />
          <p>{repository.message}</p>
          {repository.state === "unavailable" && (
            <button type="button" onClick={onChooseGit} disabled={choosingGit}>
              {choosingGit ? <span class="mini-spinner" /> : null}
              Git auswählen
            </button>
          )}
        </div>
      ) : changes.length === 0 ? (
        <div class="repository-clean"><Icon name="check" size={15} /> Arbeitsverzeichnis sauber</div>
      ) : groups().map((group) => group.changes.length > 0 && (
        <section class="change-group" >
          <h3>{group.title}<span>{group.changes.length}</span></h3>
          <div class="change-list">
            {group.changes.map((change) => {
              const selected = selection?.fileId === change.fileId && selection.area === group.area;
              return (
                <button
                  class={`change-row ${selected ? "change-row--selected" : ""}`}

                  type="button"
                  onClick={() => onSelect({
                    repositoryId: change.repositoryId,
                    fileId: change.fileId,
                    path: change.path,
                    area: group.area,
                  })}
                  aria-label={`${group.title}: Diff für ${change.path}`}
                >
                  <span class="change-status">{statusCode(change, group.area)}</span>
                  <span class="change-path">
                    <strong>{fileName(change.path)}</strong>
                    <small>{change.previousPath ? `${change.previousPath} → ${change.path}` : directoryName(change.path)}</small>
                  </span>
                  {change.submodule && <span class="change-kind">Submodule</span>}
                  {change.renameScore !== null && <span class="change-kind">{change.renameScore}%</span>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </section>
  );
}

function supportsArea(change: GitFileChange, area: DiffSelection["area"]): boolean {
  return area === "staged"
    ? change.indexStatus !== "." && !change.untracked
    : change.worktreeStatus !== "." || change.untracked || change.conflict;
}

function statusCode(change: GitFileChange, area: DiffSelection["area"]): string {
  if (change.untracked) return "?";
  if (change.conflict) return "U";
  const value = area === "staged" ? change.indexStatus : change.worktreeStatus;
  return value === "." ? "M" : value;
}

function fileName(value: string): string {
  return value.split("/").at(-1) || value;
}

function directoryName(value: string): string {
  const parts = value.split("/");
  parts.pop();
  return parts.join("/") || "/";
}
