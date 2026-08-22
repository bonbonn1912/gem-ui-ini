import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type { JiraConfig, JiraProjectIntegration } from "../../types";
import { createClientRequestId } from "../../utils/client-request-id";

type JiraSettingsProps = {
  projectId: string;
  onChanged?: () => void;
};

type EditorState = {
  /** null while creating, the id of the configuration being edited otherwise. */
  configId: string | null;
  name: string;
  baseUrl: string;
  prefixes: string;
};

const EMPTY_EDITOR: EditorState = {
  configId: null,
  name: "",
  baseUrl: "",
  prefixes: "",
};

function parsePrefixes(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value.split(/[\s,;]+/)) {
    const prefix = raw.trim().toUpperCase();
    if (!prefix || seen.has(prefix)) continue;
    seen.add(prefix);
    result.push(prefix);
  }
  return result;
}

function invalidPrefixes(prefixes: readonly string[]): string[] {
  return prefixes.filter((prefix) => !/^[A-Z][A-Z0-9_]{0,19}$/.test(prefix));
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Die Jira-Integration konnte nicht gespeichert werden.";
}

/**
 * Jira in the integrations tab.
 *
 * The saved configurations are global — once an instance has been described in
 * one project, every other project lists it here instead of asking for the
 * same URL again — while the activation is per project and singular. That is
 * why the list is "suggestions" and the button on each row is "Aktivieren"
 * rather than a checkbox: picking one always replaces whatever was active.
 */
export function JiraSettings({ projectId, onChanged }: JiraSettingsProps) {
  const [configs, setConfigs] = useState<JiraConfig[]>([]);
  const [integration, setIntegration] = useState<JiraProjectIntegration | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextConfigs, nextIntegration] = await Promise.all([
        window.gemUi.jira.listConfigs(),
        window.gemUi.jira.getProjectIntegration({ projectId }),
      ]);
      setConfigs(nextConfigs);
      setIntegration(nextIntegration);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [projectId]);

  const activeId = integration?.activeConfigId ?? null;

  const activate = async (configId: string) => {
    setBusyId(configId);
    setError(null);
    try {
      const next = await window.gemUi.jira.activate({
        clientRequestId: createClientRequestId(),
        projectId,
        configId,
      });
      setIntegration(next);
      onChanged?.();
    } catch (activateError) {
      setError(errorText(activateError));
    } finally {
      setBusyId(null);
    }
  };

  const deactivate = async () => {
    setBusyId(activeId);
    setError(null);
    try {
      const next = await window.gemUi.jira.deactivate({
        clientRequestId: createClientRequestId(),
        projectId,
      });
      setIntegration(next);
      onChanged?.();
    } catch (deactivateError) {
      setError(errorText(deactivateError));
    } finally {
      setBusyId(null);
    }
  };

  const removeConfig = async (config: JiraConfig) => {
    if (
      !window.confirm(
        `„${config.name}“ löschen? Projekte, die diese Jira-Integration nutzen, haben danach keine mehr aktiviert.`,
      )
    ) {
      return;
    }
    setBusyId(config.id);
    setError(null);
    try {
      await window.gemUi.jira.deleteConfig({
        clientRequestId: createClientRequestId(),
        configId: config.id,
      });
      await load();
      onChanged?.();
    } catch (deleteError) {
      setError(errorText(deleteError));
    } finally {
      setBusyId(null);
    }
  };

  const submitEditor = async () => {
    if (!editor) return;
    const prefixes = parsePrefixes(editor.prefixes);
    const broken = invalidPrefixes(prefixes);
    if (!editor.name.trim()) {
      setError("Bitte vergib einen Namen für diese Jira-Integration.");
      return;
    }
    if (!editor.baseUrl.trim()) {
      setError("Bitte gib die Jira-Base-URL an.");
      return;
    }
    if (prefixes.length === 0) {
      setError("Bitte gib mindestens ein Issue-Prefix an, zum Beispiel AML oder BUG.");
      return;
    }
    if (broken.length > 0) {
      setError(`Ungültige Prefixe: ${broken.join(", ")}`);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const saved = await window.gemUi.jira.saveConfig({
        clientRequestId: createClientRequestId(),
        configId: editor.configId,
        name: editor.name.trim(),
        baseUrl: editor.baseUrl.trim().replace(/\/+$/, ""),
        issuePrefixes: prefixes,
      });
      setEditor(null);
      await load();
      // A freshly created configuration is what the person just described, so
      // activating it here saves the extra click the list would otherwise ask
      // for. Editing an existing one leaves the activation untouched.
      if (editor.configId === null) await activate(saved.id);
      else onChanged?.();
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="integration-card">
      <header className="integration-card-header">
        <div className="integration-title-group">
          <span className="integration-icon jira-icon-color">
            <Icon name="jira" size={20} />
          </span>
          <div>
            <h4>Jira</h4>
            <p>
              Issues aus dem Session-Namen erkennen, im Fenster öffnen und an die Session
              anhängen (optional)
            </p>
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

        {loading && configs.length === 0 && (
          <div className="integration-loading">
            <span className="mini-spinner" /> Jira-Integrationen werden geladen …
          </div>
        )}

        {!loading && configs.length === 0 && !editor && (
          <p className="no-repos-hint">
            Noch keine Jira-Integration angelegt. Einmal gespeichert, steht sie in jedem
            Projekt zur Auswahl.
          </p>
        )}

        {configs.length > 0 && (
          <div className="repository-candidates">
            <div className="field-heading">
              <div>
                <span>Gespeicherte Jira-Integrationen</span>
                <small>
                  {activeId ? "1 in diesem Projekt aktiv" : "keine in diesem Projekt aktiv"}
                </small>
              </div>
              <button type="button" onClick={() => void load()} disabled={loading}>
                {loading ? <span className="mini-spinner" /> : <Icon name="refresh" size={14} />}
                Aktualisieren
              </button>
            </div>

            <div className="repository-candidates-list">
              {configs.map((config) => {
                const isActive = config.id === activeId;
                return (
                  <div key={config.id} className="repo-candidate-card">
                    <div className="candidate-info">
                      <div className="candidate-header-row">
                        <Icon name="jira" size={15} />
                        <strong>{config.name}</strong>
                        <span
                          className={`status-pill ${isActive ? "status-pill--active" : "status-pill--inactive"}`}
                        >
                          {isActive ? "Aktiviert" : "Nicht aktiviert"}
                        </span>
                      </div>
                      <p className="remote-summary">{config.baseUrl}</p>
                      <div className="jira-prefix-tags">
                        {config.issuePrefixes.map((prefix) => (
                          <span key={prefix} className="jira-prefix-tag">
                            {prefix}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="candidate-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`${config.name} bearbeiten`}
                        title="Bearbeiten"
                        onClick={() =>
                          setEditor({
                            configId: config.id,
                            name: config.name,
                            baseUrl: config.baseUrl,
                            prefixes: config.issuePrefixes.join(", "),
                          })
                        }
                      >
                        <Icon name="pencil" size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`${config.name} löschen`}
                        title="Löschen"
                        onClick={() => void removeConfig(config)}
                        disabled={busyId === config.id}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                      {isActive ? (
                        <button
                          type="button"
                          className="secondary-button danger-button-text"
                          onClick={() => void deactivate()}
                          disabled={busyId === config.id}
                        >
                          {busyId === config.id ? "Deaktivieren …" : "Deaktivieren"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => void activate(config.id)}
                          disabled={busyId === config.id}
                        >
                          {busyId === config.id ? "Aktivieren …" : "Aktivieren"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {editor ? (
          <div className="jira-editor">
            <div className="field-heading">
              <div>
                <span>{editor.configId ? "Jira-Integration bearbeiten" : "Neue Jira-Integration"}</span>
                <small>Name, Base URL und die Issue-Prefixe dieser Instanz</small>
              </div>
            </div>

            <label className="field-label">
              <span>Name</span>
              <input
                value={editor.name}
                maxLength={100}
                placeholder="z. B. Firmen-Jira"
                onChange={(event) =>
                  setEditor((current) => (current ? { ...current, name: event.target.value } : current))
                }
                autoFocus
              />
            </label>

            <label className="field-label">
              <span>Base URL</span>
              <input
                value={editor.baseUrl}
                maxLength={2048}
                placeholder="https://jira.example.com"
                spellCheck={false}
                onChange={(event) =>
                  setEditor((current) => (current ? { ...current, baseUrl: event.target.value } : current))
                }
              />
            </label>

            <label className="field-label">
              <span>Issue-Prefixe</span>
              <input
                value={editor.prefixes}
                maxLength={600}
                placeholder="AML, BUG, INFRA"
                spellCheck={false}
                onChange={(event) =>
                  setEditor((current) => (current ? { ...current, prefixes: event.target.value } : current))
                }
              />
            </label>
            <p className="jira-editor-hint">
              Mehrere durch Komma oder Leerzeichen trennen. Enthält ein Session-Name einen
              Key wie <code>AML-1234</code>, erscheint das Jira-Symbol in der rechten Leiste
              — bei mehreren Treffern zählt der erste im Namen.
            </p>

            <div className="jira-editor-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setEditor(null);
                  setError(null);
                }}
                disabled={saving}
              >
                Abbrechen
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void submitEditor()}
                disabled={saving}
              >
                {saving && <span className="mini-spinner" />} Speichern
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="secondary-button jira-add-button"
            onClick={() => {
              setEditor({ ...EMPTY_EDITOR });
              setError(null);
            }}
          >
            <Icon name="plus" size={14} /> Jira-Integration hinzufügen
          </button>
        )}
      </div>
    </div>
  );
}
