import { createEffect, createSignal } from "solid-js";
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
  const [configs, setConfigs] = createSignal<JiraConfig[]>([]);
  const [integration, setIntegration] = createSignal<JiraProjectIntegration | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [editor, setEditor] = createSignal<EditorState | null>(null);

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

  createEffect(() => {
    void load();
  });

  const activeId = integration()?.activeConfigId ?? null;

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
    if (!editor()) return;
    const prefixes = parsePrefixes(editor().prefixes);
    const broken = invalidPrefixes(prefixes);
    if (!editor().name.trim()) {
      setError("Bitte vergib einen Namen für diese Jira-Integration.");
      return;
    }
    if (!editor().baseUrl.trim()) {
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
        configId: editor().configId,
        name: editor().name.trim(),
        baseUrl: editor().baseUrl.trim().replace(/\/+$/, ""),
        issuePrefixes: prefixes,
      });
      setEditor(null);
      await load();
      // A freshly created configuration is what the person just described, so
      // activating it here saves the extra click the list would otherwise ask
      // for. Editing an existing one leaves the activation untouched.
      if (editor().configId === null) await activate(saved.id);
      else onChanged?.();
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="integration-card">
      <header class="integration-card-header">
        <div class="integration-title-group">
          <span class="integration-icon jira-icon-color">
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
        <span class="optional-tag">optional</span>
      </header>

      <div class="integration-card-body">
        {error() && (
          <div class="gitlab-error-banner">
            <Icon name="warning" size={15} />
            <span>{error()}</span>
          </div>
        )}

        {loading() && configs().length === 0 && (
          <div class="integration-loading">
            <span class="mini-spinner" /> Jira-Integrationen werden geladen …
          </div>
        )}

        {!loading() && configs().length === 0 && !editor() && (
          <p class="no-repos-hint">
            Noch keine Jira-Integration angelegt. Einmal gespeichert, steht sie in jedem
            Projekt zur Auswahl.
          </p>
        )}

        {configs().length > 0 && (
          <div class="repository-candidates">
            <div class="field-heading">
              <div>
                <span>Gespeicherte Jira-Integrationen</span>
                <small>
                  {activeId ? "1 in diesem Projekt aktiv" : "keine in diesem Projekt aktiv"}
                </small>
              </div>
              <button type="button" onClick={() => void load()} disabled={loading()}>
                {loading() ? <span class="mini-spinner" /> : <Icon name="refresh" size={14} />}
                Aktualisieren
              </button>
            </div>

            <div class="repository-candidates-list">
              {configs().map((config) => {
                const isActive = config.id === activeId;
                return (
                  <div  class="repo-candidate-card">
                    <div class="candidate-info">
                      <div class="candidate-header-row">
                        <Icon name="jira" size={15} />
                        <strong>{config.name}</strong>
                        <span
                          class={`status-pill ${isActive ? "status-pill--active" : "status-pill--inactive"}`}
                        >
                          {isActive ? "Aktiviert" : "Nicht aktiviert"}
                        </span>
                      </div>
                      <p class="remote-summary">{config.baseUrl}</p>
                      <div class="jira-prefix-tags">
                        {config.issuePrefixes.map((prefix) => (
                          <span  class="jira-prefix-tag">
                            {prefix}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div class="candidate-actions">
                      <button
                        type="button"
                        class="icon-button"
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
                        class="icon-button"
                        aria-label={`${config.name} löschen`}
                        title="Löschen"
                        onClick={() => void removeConfig(config)}
                disabled={busyId() === config.id}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                      {isActive ? (
                        <button
                          type="button"
                          class="secondary-button danger-button-text"
                          onClick={() => void deactivate()}
                          disabled={busyId() === config.id}
                        >
                          {busyId() === config.id ? "Deaktivieren …" : "Deaktivieren"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          class="primary-button"
                          onClick={() => void activate(config.id)}
                          disabled={busyId() === config.id}
                        >
                          {busyId() === config.id ? "Aktivieren …" : "Aktivieren"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {editor() ? (
          <div class="jira-editor">
            <div class="field-heading">
              <div>
                <span>{editor().configId ? "Jira-Integration bearbeiten" : "Neue Jira-Integration"}</span>
                <small>Name, Base URL und die Issue-Prefixe dieser Instanz</small>
              </div>
            </div>

            <label class="field-label">
              <span>Name</span>
              <input
                value={editor().name}
                maxLength={100}
                placeholder="z. B. Firmen-Jira"
                onChange={(event) =>
                  setEditor((current) => (current ? { ...current, name: event.target.value } : current))
                }
                autofocus
              />
            </label>

            <label class="field-label">
              <span>Base URL</span>
              <input
                value={editor().baseUrl}
                maxLength={2048}
                placeholder="https://jira.example.com"
                spellcheck={false}
                onChange={(event) =>
                  setEditor((current) => (current ? { ...current, baseUrl: event.target.value } : current))
                }
              />
            </label>

            <label class="field-label">
              <span>Issue-Prefixe</span>
              <input
                value={editor().prefixes}
                maxLength={600}
                placeholder="AML, BUG, INFRA"
                spellcheck={false}
                onChange={(event) =>
                  setEditor((current) => (current ? { ...current, prefixes: event.target.value } : current))
                }
              />
            </label>
            <p class="jira-editor-hint">
              Mehrere durch Komma oder Leerzeichen trennen. Enthält ein Session-Name einen
              Key wie <code>AML-1234</code>, erscheint das Jira-Symbol in der rechten Leiste
              — bei mehreren Treffern zählt der erste im Namen.
            </p>

            <div class="jira-editor-actions">
              <button
                type="button"
                class="secondary-button"
                onClick={() => {
                  setEditor(null);
                  setError(null);
                }}
                disabled={saving()}
              >
                Abbrechen
              </button>
              <button
                type="button"
                class="primary-button"
                onClick={() => void submitEditor()}
                disabled={saving()}
              >
                {saving() && <span class="mini-spinner" />} Speichern
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            class="secondary-button jira-add-button"
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
