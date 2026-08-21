import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type { GitLabMergeRequestSummary } from "../../types";

type GitLabMergeRequestPickerProps = {
  projectId: string;
  bindingId: string;
  selectedMr: GitLabMergeRequestSummary | null;
  onSelectMr: (targetProjectId: number, targetProjectPath: string, iid: number) => Promise<void>;
  onConnectMrUrl: (url: string) => Promise<void>;
  onOpenExternal: (url: string) => void;
};

export function GitLabMergeRequestPicker({
  projectId,
  bindingId,
  selectedMr,
  onSelectMr,
  onConnectMrUrl,
  onOpenExternal,
}: GitLabMergeRequestPickerProps) {
  const [mrList, setMrList] = useState<GitLabMergeRequestSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [mrUrlInput, setMrUrlInput] = useState("");
  const [connectingUrl, setConnectingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId || !bindingId) return;
    setLoading(true);
    window.gemUi.gitlab
      .listMergeRequests({ projectId, expectedRootRevision: 1, bindingId })
      .then((list) => setMrList(list))
      .catch(() => setMrList([]))
      .finally(() => setLoading(false));
  }, [projectId, bindingId]);

  const handleConnectUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mrUrlInput.trim()) return;
    setConnectingUrl(true);
    setUrlError(null);
    try {
      await onConnectMrUrl(mrUrlInput.trim());
      setUrlDialogOpen(false);
      setMrUrlInput("");
    } catch (err) {
      setUrlError((err as Error).message);
    } finally {
      setConnectingUrl(false);
    }
  };

  return (
    <div className="gitlab-mr-picker-container">
      <div className="gitlab-mr-picker-row">
        <label htmlFor="gitlab-mr-select" className="mr-picker-label">
          <Icon name="link" size={14} />
          <span>Merge Request:</span>
        </label>

        {mrList.length > 0 ? (
          <select
            id="gitlab-mr-select"
            className="gitlab-mr-select"
            value={selectedMr ? `${selectedMr.targetProjectId}:${selectedMr.iid}` : ""}
            onChange={(e) => {
              const [targetProjIdStr, iidStr] = e.target.value.split(":");
              const match = mrList.find(
                (m) => m.targetProjectId === parseInt(targetProjIdStr!, 10) && m.iid === parseInt(iidStr!, 10),
              );
              if (match) {
                void onSelectMr(match.targetProjectId, match.targetProjectPath, match.iid);
              }
            }}
          >
            {selectedMr && !mrList.some((m) => m.iid === selectedMr.iid && m.targetProjectId === selectedMr.targetProjectId) && (
              <option value={`${selectedMr.targetProjectId}:${selectedMr.iid}`}>
                !{selectedMr.iid} {selectedMr.title}
              </option>
            )}
            {mrList.map((m) => (
              <option key={`${m.targetProjectId}:${m.iid}`} value={`${m.targetProjectId}:${m.iid}`}>
                !{m.iid} {m.title} ({m.sourceBranch} → {m.targetBranch})
              </option>
            ))}
          </select>
        ) : selectedMr ? (
          <div className="selected-mr-badge">
            <strong>!{selectedMr.iid}</strong> {selectedMr.title}
          </div>
        ) : (
          <span className="no-mr-text">{loading ? "MRs werden geladen …" : "Kein offener MR zur Branch gefunden"}</span>
        )}

        <button
          type="button"
          className="icon-button mr-url-btn"
          onClick={() => setUrlDialogOpen(true)}
          title="Merge-Request-URL verbinden (z. B. für Forks)"
          aria-label="MR-URL verbinden"
        >
          <Icon name="plus" size={14} />
        </button>

        {selectedMr && (
          <button
            type="button"
            className="icon-button mr-open-btn"
            onClick={() => onOpenExternal(selectedMr.webUrl)}
            title="In GitLab öffnen"
            aria-label="In GitLab öffnen"
          >
            <Icon name="external" size={14} />
          </button>
        )}
      </div>

      {urlDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setUrlDialogOpen(false)}>
          <div className="dialog mr-url-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Merge-Request-URL verbinden">
            <header className="dialog-header">
              <h3>Merge-Request-URL verbinden</h3>
              <button className="icon-button" type="button" onClick={() => setUrlDialogOpen(false)} aria-label="Schließen"><Icon name="x" size={16} /></button>
            </header>
            <form onSubmit={handleConnectUrl}>
              <div className="dialog-body">
                {urlError && (
                  <div className="gitlab-error-banner">
                    <Icon name="warning" size={15} />
                    <span>{urlError}</span>
                  </div>
                )}
                <div className="form-group">
                  <label htmlFor="gitlab-mr-url-input">GitLab Merge Request URL</label>
                  <input
                    id="gitlab-mr-url-input"
                    type="url"
                    placeholder="https://gitlab.example.com/group/project/-/merge_requests/42"
                    value={mrUrlInput}
                    onChange={(e) => setMrUrlInput(e.target.value)}
                    required
                    autoFocus
                  />
                  <small className="form-hint">
                    Geben Sie die vollständige URL eines Merge Requests ein. Funktioniert auch für Upstream-MRs aus Forks.
                  </small>
                </div>
              </div>
              <footer className="dialog-footer">
                <button type="button" className="secondary-button" onClick={() => setUrlDialogOpen(false)}>
                  Abbrechen
                </button>
                <button type="submit" className="primary-button" disabled={connectingUrl || !mrUrlInput.trim()}>
                  {connectingUrl ? <span className="mini-spinner" /> : "Verbinden"}
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
