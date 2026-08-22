import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import type {
  AppProject,
  ProjectApprovalPolicy,
  ProjectRoot,
  ProjectRootCandidate,
} from "../../types";
import { createClientRequestId } from "../../utils/client-request-id";
import { IntegrationsSettings } from "../integrations/IntegrationsSettings";

type ProjectSettingsDialogProps = {
  open: boolean;
  project: AppProject | null;
  maxAdditionalRoots: number;
  onClose: () => void;
  onSave: (input: {
    name: string;
    additionalRootPaths: string[];
  }) => Promise<void>;
  onDelete: () => Promise<void>;
};

function displayName(candidate: ProjectRootCandidate): string {
  return (
    candidate.label ||
    candidate.path.split(/[\\/]/).filter(Boolean).at(-1) ||
    candidate.path
  );
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Das Projekt konnte nicht aktualisiert werden.";
}

export function ProjectSettingsDialog(props: ProjectSettingsDialogProps) {
  const [activeTab, setActiveTab] = createSignal<"general" | "integrations">("general");
  const [name, setName] = createSignal("");
  const [additional, setAdditional] = createSignal<ProjectRootCandidate[]>([]);
  const [picking, setPicking] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [approvalPolicy, setApprovalPolicy] =
    createSignal<ProjectApprovalPolicy | null>(null);
  const [selectedModeId, setSelectedModeId] = createSignal("");
  const [approvalLoading, setApprovalLoading] = createSignal(false);
  const [unrestrictedConfirmed, setUnrestrictedConfirmed] = createSignal(false);
  const [reauthorizingRootId, setReauthorizingRootId] = createSignal<string | null>(
    null,
  );
  const [authorizedRootIds, setAuthorizedRootIds] = createSignal<Set<string>>(new Set<string>());

  const primary = createMemo(
    () => props.project?.roots.find((root) => root.kind === "primary") ?? null,
  );

  createEffect(() => {
    if (!props.open || !props.project) return;
    setName(props.project.name);
    setAdditional(
      props.project.roots
        .filter((root) => root.kind === "additional")
        .map((root) => ({ path: root.path, label: root.label })),
    );
    setError(null);
    setAuthorizedRootIds(new Set<string>());
  });

  createEffect(() => {
    if (!props.open || !props.project) return;
    let current = true;
    setApprovalLoading(true);
    setApprovalPolicy(null);
    setUnrestrictedConfirmed(false);
    window.gemUi.projects
      .getApprovalPolicy({ projectId: props.project.id })
      .then((policy) => {
        if (!current) return;
        setApprovalPolicy(policy);
        setSelectedModeId(policy.modeId ?? "");
      })
      .catch((policyError) => {
        if (current) setError(errorText(policyError));
      })
      .finally(() => {
        if (current) setApprovalLoading(false);
      });
    return () => {
      current = false;
    };
  });

  createEffect(() => {
    if (!props.open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving() && !deleting()) props.onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  });

  const addFolders = async () => {
    setPicking(true);
    setError(null);
    try {
      const candidates = await window.gemUi.projects.pickFolders();
      const byPath = new Map(additional().map((root) => [root.path, root]));
      for (const candidate of candidates) {
        if (candidate.path !== primary()!.path) byPath.set(candidate.path, candidate);
      }
      if (byPath.size > props.maxAdditionalRoots) {
        setError(
          `Gemini unterstützt derzeit höchstens ${props.maxAdditionalRoots} zusätzliche Ordner.`,
        );
      }
      setAdditional([...byPath.values()].slice(0, props.maxAdditionalRoots));
    } catch (pickError) {
      setError(errorText(pickError));
    } finally {
      setPicking(false);
    }
  };

  const reauthorizeRoot = async (root: ProjectRoot) => {
    if (reauthorizingRootId()) return;
    setReauthorizingRootId(root.id);
    setError(null);
    try {
      const result = await window.gemUi.projects.reauthorizeRoot({
        projectId: props.project!.id,
        rootId: root.id,
      });
      if (result.status === "authorized") {
        setAuthorizedRootIds((current) => new Set(current).add(root.id));
      }
    } catch (reauthorizeError) {
      setError(errorText(reauthorizeError));
    } finally {
      setReauthorizingRootId(null);
    }
  };

  const save = async () => {
    if (!name().trim() || saving() || deleting()) return;
    setSaving(true);
    setError(null);
    try {
      await props.onSave({
        name: name().trim(),
        additionalRootPaths: additional().map((root) => root.path),
      });
      const nextModeId = selectedModeId() || null;
      if (approvalPolicy() && nextModeId !== approvalPolicy().modeId) {
        const nextPolicy = await window.gemUi.projects.setApprovalPolicy({
          projectId: props.project!.id,
          modeId: nextModeId,
          confirmUnrestricted: unrestrictedConfirmed(),
          clientRequestId: createClientRequestId(),
        });
        setApprovalPolicy(nextPolicy);
      }
      props.onClose();
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  const selectedApprovalMode = approvalPolicy()?.availableModes.find(
    (mode) => mode.id === selectedModeId(),
  );
  const storedModeUnavailable = Boolean(
    approvalPolicy()?.modeId &&
      !approvalPolicy().availableModes.some(
        (mode) => mode.id === approvalPolicy().modeId,
      ),
  );
  const changedToUnrestricted = Boolean(
    selectedApprovalMode?.unrestricted &&
      selectedModeId() !== approvalPolicy()?.modeId,
  );

  const removeProject = async () => {
    if (saving() || deleting()) return;
    if (
      !window.confirm(
        `„${props.project!.name}“ samt lokaler Session-Liste aus GeminUI löschen? Die Projektdateien bleiben erhalten.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await props.onDelete();
      props.onClose();
    } catch (deleteError) {
      setError(errorText(deleteError));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Show when={props.open && props.project && primary()}>
    <div
      class="modal-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !saving() && !deleting()) props.onClose();
      }}
    >
      <section
        class="project-dialog project-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
      >
        <header>
          <div>
            <p class="eyebrow">Projektverwaltung</p>
            <h2 id="project-settings-title">Projekt bearbeiten</h2>
          </div>
          <button
            class="icon-button"
            type="button"
            onClick={props.onClose}
            disabled={saving() || deleting()}
            aria-label="Dialog schließen"
          >
            <Icon name="x" size={19} />
          </button>
        </header>

        <div class="dialog-tab-bar">
          <button
            type="button"
              class={`dialog-tab ${activeTab() === "general" ? "dialog-tab--active" : ""}`}
            onClick={() => setActiveTab("general")}
          >
            Allgemein
          </button>
          <button
            type="button"
              class={`dialog-tab ${activeTab() === "integrations" ? "dialog-tab--active" : ""}`}
            onClick={() => setActiveTab("integrations")}
          >
            <Icon name="gitlab" size={14} /> Integrationen
          </button>
        </div>

        {activeTab() === "integrations" ? (
          <div class="dialog-body">
            {props.project && (
              <IntegrationsSettings
                projectId={props.project.id}
                rootRevision={props.project.rootRevision}
              />
            )}
          </div>
        ) : (
          <div class="dialog-body">
            <label class="field-label">
              <span>Projektname</span>
              <input
                value={name()}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                autofocus
              />
            </label>

          <div class="approval-policy-field">
            <div class="field-heading">
              <div>
                <span>Freigaben für neue Sessions</span>
                <small>Wird nach jedem Erstellen oder Laden erneut mit Gemini geprüft</small>
              </div>
              {approvalLoading() && <span class="mini-spinner" />}
            </div>
            <label class="approval-mode-select">
              <span class="sr-only">Projektweiter Gemini-Modus</span>
              <select
                value={selectedModeId()}
                onChange={(event) => {
                  setSelectedModeId(event.target.value);
                  setUnrestrictedConfirmed(false);
                }}
                disabled={approvalLoading() || !approvalPolicy()}
              >
                <option value="">Gemini-Standard (jedes Mal nachfragen)</option>
                {storedModeUnavailable && approvalPolicy()?.modeId && (
                  <option value={approvalPolicy().modeId} disabled>
                    Nicht verfügbar: {approvalPolicy().modeId}
                  </option>
                )}
                {approvalPolicy()?.availableModes.map((mode) => (
                  <option  value={mode.id}>
                    {mode.unrestricted
                      ? `Alles erlauben (${mode.name})`
                      : mode.name}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={14} />
            </label>
            {selectedApprovalMode?.description && (
              <p class="approval-mode-description">
                {selectedApprovalMode.description}
              </p>
            )}
            {approvalPolicy()?.message && (
              <div class="approval-policy-status" role="status">
                <Icon name="warning" size={15} />
                <span>{approvalPolicy().message}</span>
              </div>
            )}
            {selectedApprovalMode?.unrestricted && (
              <div class="unrestricted-warning" role="alert">
                <Icon name="warning" size={17} />
                <div>
                  <strong>Weitester Gemini-Modus</strong>
                  <span>
                    Gemini darf Tools einschließlich Schreib- und Shell-Aktionen ohne
                    einzelne Rückfrage ausführen. Das gilt projektweit für neu geladene
                    Sessions.
                  </span>
                  {changedToUnrestricted && (
                    <label>
                      <input
                        type="checkbox"
                        checked={unrestrictedConfirmed()}
                        onChange={(event) =>
                          setUnrestrictedConfirmed(event.target.checked)
                        }
                      />
                      Ich möchte „Alles erlauben“ für dieses Projekt aktivieren.
                    </label>
                  )}
                </div>
              </div>
            )}
          </div>

          <div class="folder-field">
            <div class="field-heading">
              <div>
                <span>Hauptordner</span>
                <small>Bleibt für bestehende Gemini-Sessions unveränderlich</small>
              </div>
            </div>
            <div class="selected-folder selected-folder--primary">
              <span class="folder-tile"><Icon name="folder" size={19} /></span>
              <div><strong>{displayName(primary()!)}</strong><span>{primary()!.path}</span></div>
              <div class="selected-folder-actions">
                <span class="primary-badge">Primär</span>
                <button
                  class="folder-reauthorize-button"
                  type="button"
                  onClick={() => void reauthorizeRoot(primary()!)}
                  disabled={Boolean(reauthorizingRootId())}
                  title="Ordnerzugriff über macOS erneut erteilen"
                  aria-label={`Zugriff auf ${displayName(primary()!)} erneut erteilen`}
                >
                  {reauthorizingRootId() === primary()!.id ? (
                    <span class="mini-spinner" />
                  ) : authorizedRootIds().has(primary()!.id) ? (
                    <Icon name="check" size={14} />
                  ) : (
                    <Icon name="refresh" size={14} />
                  )}
                  {authorizedRootIds().has(primary()!.id) ? "Erlaubt" : "Zugriff"}
                </button>
              </div>
            </div>
          </div>

          <div class="folder-field">
            <div class="field-heading">
              <div>
                <span>Zusätzliche Ordner</span>
                <small>{additional().length}/{props.maxAdditionalRoots}</small>
              </div>
              <button
                type="button"
                onClick={() => void addFolders()}
                  disabled={picking() || additional().length >= props.maxAdditionalRoots}
              >
                {picking() ? <span class="mini-spinner" /> : <Icon name="plus" size={14} />}
                Hinzufügen
              </button>
            </div>
            {additional().length > 0 ? (
              <div class="additional-folder-list">
                {additional().map((candidate) => {
                  const storedRoot = props.project!.roots.find(
                    (root) =>
                      root.kind === "additional" && root.path === candidate.path,
                  );
                  return (
                    <div class="selected-folder" >
                      <span class="folder-tile"><Icon name="folder" size={17} /></span>
                      <div><strong>{displayName(candidate)}</strong><span>{candidate.path}</span></div>
                      <div class="selected-folder-actions">
                        {storedRoot && (
                          <button
                            class="folder-reauthorize-button"
                            type="button"
                            onClick={() => void reauthorizeRoot(storedRoot)}
                            disabled={Boolean(reauthorizingRootId())}
                            title="Ordnerzugriff über macOS erneut erteilen"
                            aria-label={`Zugriff auf ${displayName(candidate)} erneut erteilen`}
                          >
                            {reauthorizingRootId() === storedRoot.id ? (
                              <span class="mini-spinner" />
                            ) : authorizedRootIds().has(storedRoot.id) ? (
                              <Icon name="check" size={14} />
                            ) : (
                              <Icon name="refresh" size={14} />
                            )}
                            {authorizedRootIds().has(storedRoot.id) ? "Erlaubt" : "Zugriff"}
                          </button>
                        )}
                        <button
                          class="folder-remove-button"
                          type="button"
                          onClick={() =>
                            setAdditional((current) =>
                              current.filter((root) => root.path !== candidate.path),
                            )
                          }
                          aria-label={`${displayName(candidate)} entfernen`}
                        >
                          <Icon name="x" size={15} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <button
                class="empty-additional"
                type="button"
                onClick={() => void addFolders()}
                disabled={picking()}
              >
                <Icon name="plus" size={16} /> Ordner hinzufügen
              </button>
            )}
          </div>

          <div class="access-note">
            <Icon name="refresh" size={18} />
            <p>
              <strong>Ordnerzugriff nach einem macOS-Neustart</strong>
              <span>
                Falls macOS einen gespeicherten Ordner blockiert, klicke beim betroffenen
                Root auf „Zugriff“ und wähle exakt denselben Ordner erneut aus. Der Root-Satz
                und bestehende Sessions bleiben dabei unverändert.
              </span>
            </p>
          </div>

          <div class="project-danger-zone">
            <div>
              <strong>Projekt aus GeminUI löschen</strong>
              <span>Dateien in den verbundenen Ordnern werden nicht gelöscht.</span>
            </div>
            <button
              class="danger-button"
              type="button"
              onClick={() => void removeProject()}
              disabled={saving() || deleting()}
            >
              <Icon name="trash" size={14} /> {deleting() ? "Wird gelöscht …" : "Löschen"}
            </button>
          </div>

          {error() && (
            <div class="dialog-error" role="alert">
              <Icon name="warning" size={16} /> {error()}
            </div>
          )}
        </div>
        )}

        <footer>
          <button
            class="secondary-button"
            type="button"
            onClick={props.onClose}
            disabled={saving() || deleting()}
          >
            {activeTab() === "integrations" ? "Schließen" : "Abbrechen"}
          </button>
          {activeTab() === "general" && (
            <button
              class="primary-button"
              type="button"
              onClick={() => void save()}
              disabled={
                !name().trim() ||
                saving() ||
                deleting() ||
                approvalLoading() ||
                (changedToUnrestricted && !unrestrictedConfirmed())
              }
            >
              {saving() && <span class="mini-spinner" />} Änderungen speichern
            </button>
          )}
        </footer>
      </section>
    </div>
    </Show>
  );
}
