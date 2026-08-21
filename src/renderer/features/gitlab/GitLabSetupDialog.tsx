import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type {
  GitLabConnectionSummary,
  GitLabRepositoryCandidate,
} from "../../types";

type GitLabSetupDialogProps = {
  open: boolean;
  candidate: GitLabRepositoryCandidate | null;
  projectId: string;
  rootRevision: number;
  onClose: () => void;
  onActivated: () => void;
};

export function GitLabSetupDialog({
  open,
  candidate,
  projectId,
  rootRevision,
  onClose,
  onActivated,
}: GitLabSetupDialogProps) {
  const [connections, setConnections] = useState<GitLabConnectionSummary[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [selectedRemoteIndex, setSelectedRemoteIndex] = useState<number>(0);
  const [isAddingNew, setIsAddingNew] = useState(false);

  // New connection form fields
  const [instanceUrl, setInstanceUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [allowSelfSignedTls, setAllowSelfSignedTls] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState<GitLabConnectionSummary | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTestSuccess(null);
    setToken("");
    setAllowSelfSignedTls(false);

    window.gemUi.gitlab
      .listConnections()
      .then((list) => {
        setConnections(list);
        if (candidate?.remotes && candidate.remotes.length > 0) {
          const suggested = candidate.remotes[0]?.suggestedInstanceUrl;
          if (suggested) {
            const matched = list.find((c) => {
              try {
                return new URL(c.instanceUrl).origin.toLowerCase() === new URL(suggested).origin.toLowerCase();
              } catch {
                return false;
              }
            });
            if (matched) {
              setSelectedConnectionId(matched.id);
              setIsAddingNew(false);
              return;
            }
          }
        }
        if (list.length > 0) {
          setSelectedConnectionId(list[0]!.id);
          setIsAddingNew(false);
        } else {
          setIsAddingNew(true);
        }
      })
      .catch((err) => setError((err as Error).message));
  }, [open, candidate]);

  if (!open || !candidate) return null;

  const activeRemote = candidate.remotes[selectedRemoteIndex] ?? candidate.remotes[0];

  const handleTestAndSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setTesting(true);
    setError(null);
    try {
      const clientRequestId = globalThis.crypto.randomUUID();
      const saved = await window.gemUi.gitlab.saveConnection({
        clientRequestId,
        instanceUrl: instanceUrl.trim(),
        token: token.trim(),
        allowSelfSignedTls,
      });
      setConnections((prev) => [saved, ...prev.filter((c) => c.id !== saved.id)]);
      setSelectedConnectionId(saved.id);
      setIsAddingNew(false);
      setTestSuccess(saved);
      setToken("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const handleActivate = async () => {
    if (!selectedConnectionId || !activeRemote) return;
    setSaving(true);
    setError(null);
    try {
      const connection = connections.find((c) => c.id === selectedConnectionId);
      if (!connection) throw new Error("Verbindung nicht gefunden.");

      // Parse project path from remote
      const projectPath = activeRemote.suggestedProjectPath || "project";
      const clientRequestId = globalThis.crypto.randomUUID();

      // Enable binding
      await window.gemUi.gitlab.enableBinding({
        clientRequestId,
        projectId,
        expectedRootRevision: rootRevision,
        rootId: candidate.rootIds[0]!,
        repositoryKey: candidate.candidateId,
        connectionId: selectedConnectionId,
        remoteName: activeRemote.name,
        remoteUrl: activeRemote.url,
        sourceProjectId: 1, // Fallback default, resolved dynamically on first MR sync
        sourceProjectPath: projectPath,
      });

      onActivated();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const selectedConnection = connections.find((c) => c.id === selectedConnectionId);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog gitlab-setup-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="GitLab für Repository einrichten">
        <header className="dialog-header">
          <div className="dialog-title-group">
            <span className="gitlab-icon-badge"><Icon name="gitlab" size={18} /></span>
            <div>
              <h3>GitLab verbinden</h3>
              <p>Repository: <strong>{candidate.displayName}</strong> {candidate.branch ? `(Branch: ${candidate.branch})` : ""}</p>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Schließen"><Icon name="x" size={16} /></button>
        </header>

        <div className="dialog-body">
          {error && (
            <div className="gitlab-error-banner">
              <Icon name="warning" size={16} />
              <span>{error}</span>
            </div>
          )}

          {/* Remote Selection if multiple */}
          {candidate.remotes.length > 1 && (
            <div className="form-group">
              <label htmlFor="gitlab-remote-select">Git-Remote auswählen</label>
              <select
                id="gitlab-remote-select"
                value={selectedRemoteIndex}
                onChange={(e) => setSelectedRemoteIndex(parseInt(e.target.value, 10))}
              >
                {candidate.remotes.map((r, i) => (
                  <option key={i} value={i}>
                    {r.name} ({r.url})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Connection Selection / New Form */}
          {!isAddingNew && connections.length > 0 ? (
            <div className="gitlab-connection-selector">
              <label>Gespeicherte GitLab-Verbindung verwenden</label>
              <div className="connection-cards">
                {connections.map((c) => (
                  <div
                    key={c.id}
                    className={`connection-card ${c.id === selectedConnectionId ? "connection-card--selected" : ""}`}
                    onClick={() => setSelectedConnectionId(c.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="connection-card-header">
                      <span className="connection-card-host">{new URL(c.instanceUrl).hostname}</span>
                      <span className={`connection-access-badge connection-access-badge--${c.access}`}>
                        {c.access === "read_write" ? "Schreibzugriff (api)" : c.access === "read_only" ? "Nur Lesen (read_api)" : c.access}
                      </span>
                    </div>
                    <div className="connection-card-user">
                      <strong>@{c.user.username}</strong> ({c.user.name})
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="secondary-button add-connection-btn"
                onClick={() => setIsAddingNew(true)}
              >
                <Icon name="plus" size={14} /> Anderes GitLab-Konto verbinden
              </button>
            </div>
          ) : (
            <form onSubmit={handleTestAndSave} className="new-connection-form">
              <h4>Neue GitLab-Verbindung programmweit speichern</h4>
              <div className="form-group">
                <label htmlFor="gitlab-instance-url">GitLab Instanz-URL</label>
                <input
                  id="gitlab-instance-url"
                  type="url"
                  placeholder="https://gitlab.com oder https://gitlab.company.dev"
                  value={instanceUrl}
                  onChange={(e) => setInstanceUrl(e.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="gitlab-token">Personal / Project Access Token</label>
                <input
                  id="gitlab-token"
                  type="password"
                  placeholder="glpat-••••••••••••••••••••"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                />
                <small className="form-hint">
                  Empfohlener Scope: <code>api</code> (für Antworten & Threads auflösen) oder <code>read_api</code> (schreibgeschützt). Der Token wird sicher verschlüsselt in SQLite gespeichert.
                </small>
              </div>

              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={allowSelfSignedTls}
                    onChange={(e) => setAllowSelfSignedTls(e.target.checked)}
                  />
                  <span>SSL/TLS-Zertifikatsprüfung überspringen (z. B. für Self-Hosted / interne Firmenzertifikate)</span>
                </label>
              </div>

              <div className="form-actions-inline">
                {connections.length > 0 && (
                  <button type="button" className="secondary-button" onClick={() => setIsAddingNew(false)}>
                    Abbrechen
                  </button>
                )}
                <button type="submit" className="primary-button" disabled={testing || !token.trim()}>
                  {testing ? <><span className="mini-spinner" /> Verbindung testen …</> : "Verbindung testen & speichern"}
                </button>
              </div>
            </form>
          )}

          {testSuccess && (
            <div className="gitlab-success-banner">
              <Icon name="check" size={16} />
              <span>Verbindung zu @{testSuccess.user.username} ({new URL(testSuccess.instanceUrl).hostname}) erfolgreich hergestellt!</span>
            </div>
          )}
        </div>

        <footer className="dialog-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            Abbrechen
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={handleActivate}
            disabled={saving || !selectedConnectionId || isAddingNew}
          >
            {saving ? <><span className="mini-spinner" /> Aktivieren …</> : "Für dieses Repository aktivieren"}
          </button>
        </footer>
      </div>
    </div>
  );
}
