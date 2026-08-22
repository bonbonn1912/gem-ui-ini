import { Icon } from "../../components/Icon";
import type { GitLabMergeRequestSummary } from "../../types";

type GitLabMergeRequestListProps = {
  mergeRequests: GitLabMergeRequestSummary[];
  loading: boolean;
  currentBranch: string | null;
  onSelectMr: (
    targetProjectId: number,
    targetProjectPath: string,
    iid: number,
  ) => Promise<void>;
  onReload: () => void;
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.round(hours / 24);
  if (days < 30) return `vor ${days} Tg.`;
  return new Date(iso).toLocaleDateString();
}

export function GitLabMergeRequestList(props: GitLabMergeRequestListProps) {
  const { mergeRequests, loading, currentBranch, onSelectMr, onReload } = props;
  const branch = currentBranch?.trim().toLowerCase() || null;

  if (loading && mergeRequests.length === 0) {
    return (
      <div class="gitlab-loading">
        <span class="mini-spinner" /> Offene Merge Requests werden geladen …
      </div>
    );
  }

  if (mergeRequests.length === 0) {
    return (
      <div class="gitlab-panel-state">
        <span class="gitlab-state-icon">
          <Icon name="chat" size={22} />
        </span>
        <strong>Keine offenen Merge Requests</strong>
        <p>
          In diesem GitLab-Projekt ist aktuell kein Merge Request offen. Sobald
          einer erstellt wird, erscheint er hier automatisch.
        </p>
        <button type="button" class="gitlab-ghost-button" onClick={onReload}>
          <Icon name="refresh" size={13} /> Neu laden
        </button>
      </div>
    );
  }

  return (
    <div class="gitlab-mr-list">
      <div class="gitlab-section-heading">
        <div>
          <span>Offene Merge Requests</span>
          <small>{mergeRequests.length} gefunden · automatisch geladen</small>
        </div>
        <button type="button" onClick={onReload} disabled={loading}>
          {loading ? (
            <span class="mini-spinner" />
          ) : (
            <Icon name="refresh" size={13} />
          )}
          Neu laden
        </button>
      </div>

      {mergeRequests.map((mr) => {
        const onBranch =
          branch !== null && mr.sourceBranch.toLowerCase() === branch;
        return (
          <button
            type="button"
            class="gitlab-mr-row"
            onClick={() =>
              void onSelectMr(mr.targetProjectId, mr.targetProjectPath, mr.iid)
            }
          >
            <span class="gitlab-mr-iid">!{mr.iid}</span>
            <span class="gitlab-mr-main">
              <span class="gitlab-mr-title">{mr.title}</span>
              <span class="gitlab-mr-branches">
                <Icon name="branch" size={11} />
                {mr.sourceBranch} → {mr.targetBranch}
              </span>
            </span>
            <span class="gitlab-mr-meta">
              {onBranch && <span class="gitlab-tag gitlab-tag--branch">Dein Branch</span>}
              {mr.draft && <span class="gitlab-tag">Entwurf</span>}
              <span class="gitlab-mr-time">{relativeTime(mr.updatedAt)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
