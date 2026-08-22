import { createEffect, createSignal } from "solid-js";
import { Icon } from "../../components/Icon";
import type { GitLabRepositoryCandidate } from "../../types";
import { GitLabSetupDialog } from "../gitlab/GitLabSetupDialog";
import { JiraSettings } from "../jira/JiraSettings";

type IntegrationsSettingsProps = {
  projectId: string;
  rootRevision: number;
};

export function IntegrationsSettings({
  projectId,
  rootRevision,
}: IntegrationsSettingsProps) {
  const [candidates, setCandidates] = createSignal<GitLabRepositoryCandidate[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [setupCandidate, setSetupCandidate] = createSignal<GitLabRepositoryCandidate | null>(null);
  const [deactivatingId, setDeactivatingId] = createSignal<string | null>(null);

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

  createEffect(() => {
    void loadCandidates();
  });

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

  const activeCount = candidates().filter((cand) => cand.binding?.enabled).length;

  return (
    <div class="integrations-settings-section">
      <div class="integration-card">
        <header class="integration-card-header">
          <div class="integration-title-group">
            <span class="integration-icon gitlab-icon-color">
              <Icon name="gitlab" size={20} />
            </span>
            <div>
              <h4>GitLab</h4>
              <p>Merge Requests und Review-Threads pro Repository verbinden (optional)</p>
            </div>
          </div>
          <span class="optional-tag">optional</span>
        </header>

        <div class="integration-card-body">
          {error() && (
            <div class="gitlab-error-banner">
              <Icon name="warning" size={15} />
              <span>{error()}</span>
            </div>
          )}

          {loading() && candidates().length === 0 && (
            <div class="integration-loading">
              <span class="mini-spinner" /> Lokale Repositories werden analysiert …
            </div>
          )}

          {!loading() && candidates().length === 0 && (
            <p class="no-repos-hint">
              Keine Git-Repositories in den Ordnern dieses Projekts erkannt.
            </p>
          )}

          {candidates().length > 0 && (
            <div class="repository-candidates">
              <div class="field-heading">
                <div>
                  <span>Repositories</span>
                  <small>
                    {activeCount}/{candidates().length} aktiviert
                  </small>
                </div>
                <button
                  type="button"
                  onClick={() => void loadCandidates()}
                  disabled={loading()}
                >
                  {loading() ? (
                    <span class="mini-spinner" />
                  ) : (
                    <Icon name="refresh" size={14} />
                  )}
                  Aktualisieren
                </button>
              </div>
              <div class="repository-candidates-list">
              {candidates().map((cand) => {
                const isEnabled = Boolean(cand.binding?.enabled);
                const firstRemote = cand.remotes[0];

                return (
                  <div  class="repo-candidate-card">
                    <div class="candidate-info">
                      <div class="candidate-header-row">
                        <Icon name="branch" size={15} />
                        <strong>{cand.displayName}</strong>
                        {cand.branch && <span class="branch-tag">{cand.branch}</span>}
                        <span class={`status-pill ${isEnabled ? "status-pill--active" : "status-pill--inactive"}`}>
                          {isEnabled ? "Aktiviert" : "Nicht aktiviert"}
                        </span>
                      </div>

                      {firstRemote && (
                        <p class="remote-summary">
                          {firstRemote.name} → {firstRemote.suggestedProjectPath || firstRemote.url}
                        </p>
                      )}

                      {isEnabled && cand.binding && (
                        <div class="binding-meta">
                          <span>Verbunden mit: <strong>{cand.binding.sourceProjectPath}</strong></span>
                        </div>
                      )}
                    </div>

                    <div class="candidate-actions">
                      {isEnabled ? (
                        <button
                          type="button"
                          class="secondary-button danger-button-text"
                          onClick={() => handleDisableBinding(cand.binding!.id)}
                          disabled={deactivatingId() === cand.binding!.id}
                        >
                          {deactivatingId() === cand.binding!.id ? "Deaktivieren …" : "Deaktivieren"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          class="primary-button"
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

      <JiraSettings projectId={projectId} />

      <GitLabSetupDialog
        open={setupCandidate() !== null}
        candidate={setupCandidate()}
        projectId={projectId}
        rootRevision={rootRevision}
        onClose={() => setSetupCandidate(null)}
        onActivated={() => void loadCandidates()}
      />
    </div>
  );
}
