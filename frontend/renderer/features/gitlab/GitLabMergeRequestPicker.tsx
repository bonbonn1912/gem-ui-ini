import { Icon } from "../../components/Icon";
import type { GitLabMergeRequestSummary } from "../../types";

type GitLabMergeRequestPickerProps = {
  mergeRequests: GitLabMergeRequestSummary[];
  loading: boolean;
  selectedMr: GitLabMergeRequestSummary | null;
  onSelectMr: (
    targetProjectId: number,
    targetProjectPath: string,
    iid: number,
  ) => Promise<void>;
  onReload: () => void;
  onOpenExternal: (url: string) => void;
};

function optionValue(mr: GitLabMergeRequestSummary): string {
  return `${mr.targetProjectId}:${mr.iid}`;
}

export function GitLabMergeRequestPicker({
  mergeRequests,
  loading,
  selectedMr,
  onSelectMr,
  onReload,
  onOpenExternal,
}: GitLabMergeRequestPickerProps) {
  const knowsSelected =
    selectedMr !== null &&
    mergeRequests.some((mr) => optionValue(mr) === optionValue(selectedMr));

  return (
    <div class="gitlab-picker">
      <label class="gitlab-picker-label" for="gitlab-mr-select">
        <Icon name="chat" size={13} />
        <span>Merge Request</span>
      </label>

      <div class="gitlab-picker-control">
        {mergeRequests.length > 0 || selectedMr ? (
          <span class="gitlab-select">
            <select
              id="gitlab-mr-select"
              aria-label="Offenen Merge Request wählen"
              value={selectedMr ? optionValue(selectedMr) : ""}
              onChange={(event) => {
                const match = mergeRequests.find(
                  (mr) => optionValue(mr) === event.target.value,
                );
                if (match) {
                  void onSelectMr(
                    match.targetProjectId,
                    match.targetProjectPath,
                    match.iid,
                  );
                }
              }}
            >
              {selectedMr && !knowsSelected && (
                <option value={optionValue(selectedMr)}>
                  !{selectedMr.iid} · {selectedMr.title}
                </option>
              )}
              {mergeRequests.map((mr) => (
                <option value={optionValue(mr)}>
                  {mr.draft ? "Entwurf · " : ""}!{mr.iid} · {mr.title} (
                  {mr.sourceBranch} → {mr.targetBranch})
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={13} />
          </span>
        ) : (
          <span class="gitlab-picker-empty">
            {loading
              ? "Offene MRs werden geladen …"
              : "Keine offenen Merge Requests"}
          </span>
        )}

        <button
          type="button"
          class="gitlab-picker-action"
          onClick={onReload}
          disabled={loading}
          title="Offene Merge Requests neu laden"
          aria-label="Offene Merge Requests neu laden"
        >
          {loading ? (
            <span class="mini-spinner" />
          ) : (
            <Icon name="refresh" size={13} />
          )}
        </button>

        {selectedMr && (
          <button
            type="button"
            class="gitlab-picker-action"
            onClick={() => onOpenExternal(selectedMr.webUrl)}
            title="In GitLab öffnen"
            aria-label="In GitLab öffnen"
          >
            <Icon name="external" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
