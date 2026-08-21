import { Icon } from "../../components/Icon";
import type { GitLabRepositoryBinding, GitLabRepositoryCandidate } from "../../types";

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
    <div className="gitlab-repo-picker">
      <label htmlFor="gitlab-repo-select">
        <Icon name="branch" size={14} />
        <span>Repository:</span>
      </label>
      <select
        id="gitlab-repo-select"
        value={selectedBindingId ?? ""}
        onChange={(e) => onSelectBinding(e.target.value)}
      >
        {enabledCandidates.map((c) => (
          <option key={c.binding!.id} value={c.binding!.id}>
            {c.displayName} {c.branch ? `(${c.branch})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
