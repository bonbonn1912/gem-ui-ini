import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type { GitLabRepositoryCandidate } from "../../types";
import { GitLabSetupDialog } from "../gitlab/GitLabSetupDialog";

type IntegrationsSettingsProps = {
  projectId: string;
  rootRevision: number;
};

export function IntegrationsSettings({
  projectId,
  rootRevision,
}: IntegrationsSettingsProps) {
  const [candidates, setCandidates] = useState<GitLabRepositoryCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupCandidate, setSetupCandidate] = useState<GitLabRepositoryCandidate | null>(null);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);

  const loadCandidates = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.gemUi.gitlab.listRepositoryCandidates({ projectId });
      setCandidates(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCandidates();
  }, [projectId]);

  const handleDisableBinding = async (bindingId: string) => {
    setDeactivatingId(bindingId);
    setError(null);
    try {
      const clientRequestId = globalThis.crypto.randomUUID();
      await window.gemUi.gitlab.disableBinding({
        clientRequestId,
        projectId,
        expectedRootRevision: rootRevision,
        bindingId,
      });
      await loadCandidates();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeactivatingId(null);
    }
  };

  const activeCount = candidates.filter((cand) => cand.binding?.enabled).length;

  return (
    <div className="integrations-settings-section">
      <div className="integration-card">
        <header className="integration-card-header">
          <div className="integration-title-group">
            <span className="integration-icon gitlab-icon-color">
              <Icon name="gitlab" size={20} />
            </span>
            <div>
              <h4>GitLab</h4>
              <p>Merge Requests und Review-Threads pro Repository verbinden (optional)</p>
            </div>
          </div>
          <span className="optional-tag">optional</span>
        </header>

        <div className="integration-card-body">
          {error && (
            <div className="gitlab-error-banner">
              <Icon name="warning" size={15} />
              <span>{error}</span>
            </div>
          )}

          {loading && candidates.length === 0 && (
            <div className="integration-loading">
              <span className="mini-spinner" /> Lokale Repositories werden analysiert …
            </div>
          )}

          {!loading && candidates.length === 0 && (
            <p className="no-repos-hint">
              Keine Git-Repositories in den Ordnern dieses Projekts erkannt.
            </p>
          )}

          {candidates.length > 0 && (
            <div className="repository-candidates">
              <div className="field-heading">
                <div>
                  <span>Repositories</span>
                  <small>
                    {activeCount}/{candidates.length} aktiviert
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() => void loadCandidates()}
                  disabled={loading}
                >
                  {loading ? (
                    <span className="mini-spinner" />
                  ) : (
                    <Icon name="refresh" size={14} />
                  )}
                  Aktualisieren
                </button>
              </div>
              <div className="repository-candidates-list">
              {candidates.map((cand) => {
                const isEnabled = Boolean(cand.binding?.enabled);
                const firstRemote = cand.remotes[0];

                return (
                  <div key={cand.candidateId} className="repo-candidate-card">
                    <div className="candidate-info">
                      <div className="candidate-header-row">
                        <Icon name="branch" size={15} />
                        <strong>{cand.displayName}</strong>
                        {cand.branch && <span className="branch-tag">{cand.branch}</span>}
                        <span className={`status-pill ${isEnabled ? "status-pill--active" : "status-pill--inactive"}`}>
                          {isEnabled ? "Aktiviert" : "Nicht aktiviert"}
                        </span>
                      </div>

                      {firstRemote && (
                        <p className="remote-summary">
                          {firstRemote.name} → {firstRemote.suggestedProjectPath || firstRemote.url}
                        </p>
                      )}

                      {isEnabled && cand.binding && (
                        <div className="binding-meta">
                          <span>Verbunden mit: <strong>{cand.binding.sourceProjectPath}</strong></span>
                        </div>
                      )}
                    </div>

                    <div className="candidate-actions">
                      {isEnabled ? (
                        <button
                          type="button"
                          className="secondary-button danger-button-text"
                          onClick={() => handleDisableBinding(cand.binding!.id)}
                          disabled={deactivatingId === cand.binding!.id}
                        >
                          {deactivatingId === cand.binding!.id ? "Deaktivieren …" : "Deaktivieren"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => setSetupCandidate(cand)}
                        >
                          Aktivieren
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          )}
        </div>
      </div>

      <GitLabSetupDialog
        open={setupCandidate !== null}
        candidate={setupCandidate}
        projectId={projectId}
        rootRevision={rootRevision}
        onClose={() => setSetupCandidate(null)}
        onActivated={() => void loadCandidates()}
      />
    </div>
  );
}
