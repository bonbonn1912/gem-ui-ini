import { createEffect, createSignal, onCleanup } from "solid-js";
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
  const [connections, setConnections] = createSignal<GitLabConnectionSummary[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = createSignal<string | null>(null);
  const [selectedRemoteIndex, setSelectedRemoteIndex] = createSignal<number>(0);
  const [isAddingNew, setIsAddingNew] = createSignal(false);

  // New connection form fields
  const [instanceUrl, setInstanceUrl] = createSignal("https://gitlab.com");
  const [token, setToken] = createSignal("");
  const [allowSelfSignedTls, setAllowSelfSignedTls] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [testSuccess, setTestSuccess] = createSignal<GitLabConnectionSummary | null>(null);

  createEffect(() => {
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
  });

  createEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving() && !testing()) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    onCleanup(() => window.removeEventListener("keydown", closeOnEscape));
  });

  if (!open || !candidate) return null;

  const activeRemote = candidate.remotes[selectedRemoteIndex()] ?? candidate.remotes[0];

  const handleTestAndSave = async (e: SubmitEvent) => {
    e.preventDefault();
    if (!token().trim()) return;
    setTesting(true);
    setError(null);
    try {
      const clientRequestId = globalThis.crypto.randomUUID();
      const saved = await window.gemUi.gitlab.saveConnection({
        clientRequestId,
        instanceUrl: instanceUrl().trim(),
        token: token().trim(),
        allowSelfSignedTls: allowSelfSignedTls(),
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
    if (!selectedConnectionId() || !activeRemote) return;
    setSaving(true);
    setError(null);
    try {
      const connection = connections().find((c) => c.id === selectedConnectionId());
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
        connectionId: selectedConnectionId(),
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

  return (
    <div
      class="modal-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !saving() && !testing()) onClose();
      }}
    >
      <section
        class="project-dialog gitlab-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="GitLab für Repository einrichten"
      >
        <header>
          <div class="dialog-title-group">
            <span class="gitlab-icon-badge"><Icon name="gitlab" size={18} /></span>
            <div>
              <h3>GitLab verbinden</h3>
              <p>Repository: <strong>{candidate.displayName}</strong> {candidate.branch ? `(Branch: ${candidate.branch})` : ""}</p>
            </div>
          </div>
          <button class="icon-button" type="button" onClick={onClose} aria-label="Schließen"><Icon name="x" size={19} /></button>
        </header>

        <div class="dialog-body">
          {error() && (
            <div class="gitlab-error-banner">
              <Icon name="warning" size={16} />
              <span>{error()}</span>
            </div>
          )}

          {/* Remote Selection if multiple */}
          {candidate.remotes.length > 1 && (
            <div class="form-group">
              <label for="gitlab-remote-select">Git-Remote auswählen</label>
              <select
                id="gitlab-remote-select"
                value={selectedRemoteIndex()}
                onChange={(e) => setSelectedRemoteIndex(parseInt(e.target.value, 10))}
              >
                {candidate.remotes.map((r, i) => (
                  <option  value={i}>
                    {r.name} ({r.url})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Connection Selection / New Form */}
          {!isAddingNew() && connections().length > 0 ? (
            <div class="gitlab-connection-selector">
              <label>Gespeicherte GitLab-Verbindung verwenden</label>
              <div class="connection-cards">
                {connections().map((c) => (
                  <div

                    class={`connection-card ${c.id === selectedConnectionId() ? "connection-card--selected" : ""}`}
                    onClick={() => setSelectedConnectionId(c.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div class="connection-card-header">
                      <span class="connection-card-host">{new URL(c.instanceUrl).hostname}</span>
                      <span class={`connection-access-badge connection-access-badge--${c.access}`}>
                        {c.access === "read_write" ? "Schreibzugriff (api)" : c.access === "read_only" ? "Nur Lesen (read_api)" : c.access}
                      </span>
                    </div>
                    <div class="connection-card-user">
                      <strong>@{c.user.username}</strong> ({c.user.name})
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                class="secondary-button add-connection-btn"
                onClick={() => setIsAddingNew(true)}
              >
                <Icon name="plus" size={14} /> Anderes GitLab-Konto verbinden
              </button>
            </div>
          ) : (
            <form onSubmit={handleTestAndSave} class="new-connection-form">
              <h4>Neue GitLab-Verbindung programmweit speichern</h4>
              <div class="form-group">
                <label for="gitlab-instance-url">GitLab Instanz-URL</label>
                <input
                  id="gitlab-instance-url"
                  type="url"
                  placeholder="https://gitlab.com oder https://gitlab.company.dev"
                  value={instanceUrl()}
                  onChange={(e) => setInstanceUrl(e.target.value)}
                  required
                />
              </div>

              <div class="form-group">
                <label for="gitlab-token">Personal / Project Access Token</label>
                <input
                  id="gitlab-token"
                  type="password"
                  placeholder="glpat-••••••••••••••••••••"
                  value={token()}
                  onChange={(e) => setToken(e.target.value)}
                  required
                />
                <small class="form-hint">
                  Empfohlener Scope: <code>api</code> (für Antworten & Threads auflösen) oder <code>read_api</code> (schreibgeschützt). Der Token wird sicher verschlüsselt in SQLite gespeichert.
                </small>
              </div>

              <div class="form-group">
                <label class="checkbox-label">
                  <input
                    type="checkbox"
                    checked={allowSelfSignedTls()}
                    onChange={(e) => setAllowSelfSignedTls(e.target.checked)}
                  />
                  <span>SSL/TLS-Zertifikatsprüfung überspringen (z. B. für Self-Hosted / interne Firmenzertifikate)</span>
                </label>
              </div>

              <div class="form-actions-inline">
                {connections().length > 0 && (
                  <button type="button" class="secondary-button" onClick={() => setIsAddingNew(false)}>
                    Abbrechen
                  </button>
                )}
                <button type="submit" class="primary-button" disabled={testing() || !token().trim()}>
                  {testing() ? <><span class="mini-spinner" /> Verbindung testen …</> : "Verbindung testen & speichern"}
                </button>
              </div>
            </form>
          )}

          {testSuccess() && (
            <div class="gitlab-success-banner">
              <Icon name="check" size={16} />
              <span>Verbindung zu @{testSuccess().user.username} ({new URL(testSuccess().instanceUrl).hostname}) erfolgreich hergestellt!</span>
            </div>
          )}
        </div>

        <footer>
          <button type="button" class="secondary-button" onClick={onClose}>
            Abbrechen
          </button>
          <button
            type="button"
            class="primary-button"
            onClick={handleActivate}
            disabled={saving() || !selectedConnectionId() || isAddingNew()}
          >
            {saving() ? <><span class="mini-spinner" /> Aktivieren …</> : "Für dieses Repository aktivieren"}
          </button>
        </footer>
      </section>
    </div>
  );
}
