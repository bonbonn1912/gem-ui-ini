import { useEffect, useMemo } from "react";

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

export function ChangesPanel({
  open,
  project,
  status,
  loading,
  refreshing,
  choosingGit,
  error,
  selection,
  onClose,
  onSelectionChange,
  onRefresh,
  onChooseGit,
}: ChangesPanelProps) {
  useEffect(() => {
    if (!selection || !status) return;
    const replacement = status.changes.find((change) =>
      change.repositoryId === selection.repositoryId && change.path === selection.path,
    );
    if (!replacement || !supportsArea(replacement, selection.area)) {
      onSelectionChange(null);
    } else if (replacement.fileId !== selection.fileId) {
      onSelectionChange({ ...selection, fileId: replacement.fileId });
    }
  }, [onSelectionChange, selection, status]);

  const selectedChange = selection
    ? status?.changes.find((change) => change.fileId === selection.fileId) ?? null
    : null;

  return (
    <aside className={`changes-panel ${open ? "changes-panel--open" : ""}`} aria-label="Git-Änderungen" aria-hidden={!open}>
      <header className="changes-panel-header">
        <div>
          <span className="changes-panel-icon"><Icon name="changes" size={17} /></span>
          <div><strong>Änderungen</strong><span>{status ? `${status.changes.length} Dateien` : "Git-Worktrees"}</span></div>
        </div>
        <button className="icon-button" type="button" onClick={onRefresh} disabled={loading || refreshing} aria-label="Git-Änderungen aktualisieren">
          {loading || refreshing ? <span className="mini-spinner" /> : <Icon name="refresh" size={16} />}
        </button>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Änderungen schließen"><Icon name="x" size={16} /></button>
      </header>

      <div className={`changes-panel-body ${selection ? "changes-panel-body--diff" : ""}`}>
        <div className="changes-list-pane">
          {error && <div className="changes-error" role="alert"><Icon name="warning" size={17} /><p>{error}</p><button type="button" onClick={onRefresh}>Erneut</button></div>}
          {!status && loading ? (
            <div className="changes-loading"><span className="mini-spinner" /><p>Repositories werden geprüft …</p></div>
          ) : status ? (
            <RepositoryList
              status={status}
              selection={selection}
              onSelect={onSelectionChange}
              onChooseGit={onChooseGit}
              choosingGit={choosingGit}
            />
          ) : null}
        </div>
        <div className="changes-diff-pane">
          <DiffViewer
            project={project}
            selection={selection}
            change={selectedChange}
            onBack={() => onSelectionChange(null)}
          />
        </div>
      </div>
    </aside>
  );
}

function RepositoryList({
  status,
  selection,
  onSelect,
  onChooseGit,
  choosingGit,
}: {
  status: GitProjectStatus;
  selection: DiffSelection | null;
  onSelect: (selection: DiffSelection) => void;
  onChooseGit: () => void;
  choosingGit: boolean;
}) {
  return (
    <div className="repository-list">
      {status.repositories.map((repository) => (
        <RepositoryGroup
          key={repository.repositoryId}
          repository={repository}
          changes={status.changes.filter((change) => change.repositoryId === repository.repositoryId)}
          selection={selection}
          onSelect={onSelect}
          onChooseGit={onChooseGit}
          choosingGit={choosingGit}
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
  const groups = useMemo(() => [
    { key: "conflicts", title: "Konflikte", changes: changes.filter((change) => change.conflict), area: "unstaged" as const },
    { key: "staged", title: "Vorgemerkt", changes: changes.filter((change) => !change.conflict && change.indexStatus !== "." && !change.untracked), area: "staged" as const },
    { key: "unstaged", title: "Änderungen", changes: changes.filter((change) => !change.conflict && !change.untracked && change.worktreeStatus !== "."), area: "unstaged" as const },
    { key: "untracked", title: "Unversioniert", changes: changes.filter((change) => change.untracked), area: "unstaged" as const },
  ], [changes]);

  return (
    <section className="repository-group">
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
        <div className={`repository-state repository-state--${repository.state}`}>
          <Icon name={repository.state === "outside_authority" || repository.state === "error" ? "warning" : "folder"} size={17} />
          <p>{repository.message}</p>
          {repository.state === "unavailable" && (
            <button type="button" onClick={onChooseGit} disabled={choosingGit}>
              {choosingGit ? <span className="mini-spinner" /> : null}
              Git auswählen
            </button>
          )}
        </div>
      ) : changes.length === 0 ? (
        <div className="repository-clean"><Icon name="check" size={15} /> Arbeitsverzeichnis sauber</div>
      ) : groups.map((group) => group.changes.length > 0 && (
        <section className="change-group" key={group.key}>
          <h3>{group.title}<span>{group.changes.length}</span></h3>
          <div className="change-list">
            {group.changes.map((change) => {
              const selected = selection?.fileId === change.fileId && selection.area === group.area;
              return (
                <button
                  className={`change-row ${selected ? "change-row--selected" : ""}`}
                  key={`${group.key}:${change.fileId}`}
                  type="button"
                  onClick={() => onSelect({
                    repositoryId: change.repositoryId,
                    fileId: change.fileId,
                    path: change.path,
                    area: group.area,
                  })}
                  aria-label={`${group.title}: Diff für ${change.path}`}
                >
                  <span className="change-status">{statusCode(change, group.area)}</span>
                  <span className="change-path">
                    <strong>{fileName(change.path)}</strong>
                    <small>{change.previousPath ? `${change.previousPath} → ${change.path}` : directoryName(change.path)}</small>
                  </span>
                  {change.submodule && <span className="change-kind">Submodule</span>}
                  {change.renameScore !== null && <span className="change-kind">{change.renameScore}%</span>}
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
