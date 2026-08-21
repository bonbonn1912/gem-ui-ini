import { Icon } from "../../components/Icon";
import type { GitLabRepositoryCandidate } from "../../types";

type GitLabRepositoryPickerProps = {
  candidates: GitLabRepositoryCandidate[];
  selectedBindingId: string | null;
  onSelectBinding: (bindingId: string) => void;
};

export function GitLabRepositoryPicker({
  candidates,
  selectedBindingId,
  onSelectBinding,
}: GitLabRepositoryPickerProps) {
  const enabledCandidates = candidates.filter((c) => c.binding?.enabled);
  if (enabledCandidates.length <= 1) return null;

  return (
    <div className="gitlab-picker">
      <label className="gitlab-picker-label" htmlFor="gitlab-repo-select">
        <Icon name="branch" size={13} />
        <span>Repository</span>
      </label>
      <div className="gitlab-picker-control">
        <span className="gitlab-select">
          <select
            id="gitlab-repo-select"
            value={selectedBindingId ?? ""}
            onChange={(event) => onSelectBinding(event.target.value)}
          >
            {enabledCandidates.map((candidate) => (
              <option key={candidate.binding!.id} value={candidate.binding!.id}>
                {candidate.displayName}
                {candidate.branch ? ` (${candidate.branch})` : ""}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={13} />
        </span>
      </div>
    </div>
  );
}
