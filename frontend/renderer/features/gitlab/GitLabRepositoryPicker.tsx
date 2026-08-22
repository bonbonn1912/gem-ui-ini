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
    <div class="gitlab-picker">
      <label class="gitlab-picker-label" for="gitlab-repo-select">
        <Icon name="branch" size={13} />
        <span>Repository</span>
      </label>
      <div class="gitlab-picker-control">
        <span class="gitlab-select">
          <select
            id="gitlab-repo-select"
            value={selectedBindingId ?? ""}
            onChange={(event) => onSelectBinding(event.target.value)}
          >
            {enabledCandidates.map((candidate) => (
              <option value={candidate.binding!.id}>
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
