import { useEffect, useMemo, useState } from "react";
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

export function ProjectSettingsDialog({
  open,
  project,
  maxAdditionalRoots,
  onClose,
  onSave,
  onDelete,
}: ProjectSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<"general" | "integrations">("general");
  const [name, setName] = useState("");
  const [additional, setAdditional] = useState<ProjectRootCandidate[]>([]);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalPolicy, setApprovalPolicy] =
    useState<ProjectApprovalPolicy | null>(null);
  const [selectedModeId, setSelectedModeId] = useState("");
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [unrestrictedConfirmed, setUnrestrictedConfirmed] = useState(false);
  const [reauthorizingRootId, setReauthorizingRootId] = useState<string | null>(
    null,
  );
  const [authorizedRootIds, setAuthorizedRootIds] = useState<Set<string>>(
    () => new Set(),
  );

  const primary = useMemo(
    () => project?.roots.find((root) => root.kind === "primary") ?? null,
    [project],
  );

  useEffect(() => {
    if (!open || !project) return;
    setName(project.name);
    setAdditional(
      project.roots
        .filter((root) => root.kind === "additional")
        .map((root) => ({ path: root.path, label: root.label })),
    );
    setError(null);
    setAuthorizedRootIds(new Set());
  }, [open, project]);

  useEffect(() => {
    if (!open || !project) return;
    let current = true;
    setApprovalLoading(true);
    setApprovalPolicy(null);
    setUnrestrictedConfirmed(false);
    window.gemUi.projects
      .getApprovalPolicy({ projectId: project.id })
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
  }, [open, project]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving && !deleting) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deleting, onClose, open, saving]);

  if (!open || !project || !primary) return null;

  const addFolders = async () => {
    setPicking(true);
    setError(null);
    try {
      const candidates = await window.gemUi.projects.pickFolders();
      const byPath = new Map(additional.map((root) => [root.path, root]));
      for (const candidate of candidates) {
        if (candidate.path !== primary.path) byPath.set(candidate.path, candidate);
      }
      if (byPath.size > maxAdditionalRoots) {
        setError(
          `Gemini unterstützt derzeit höchstens ${maxAdditionalRoots} zusätzliche Ordner.`,
        );
      }
      setAdditional([...byPath.values()].slice(0, maxAdditionalRoots));
    } catch (pickError) {
      setError(errorText(pickError));
    } finally {
      setPicking(false);
    }
  };

  const reauthorizeRoot = async (root: ProjectRoot) => {
    if (reauthorizingRootId) return;
    setReauthorizingRootId(root.id);
    setError(null);
    try {
      const result = await window.gemUi.projects.reauthorizeRoot({
        projectId: project.id,
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
    if (!name.trim() || saving || deleting) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        additionalRootPaths: additional.map((root) => root.path),
      });
      const nextModeId = selectedModeId || null;
      if (approvalPolicy && nextModeId !== approvalPolicy.modeId) {
        const nextPolicy = await window.gemUi.projects.setApprovalPolicy({
          projectId: project.id,
          modeId: nextModeId,
          confirmUnrestricted: unrestrictedConfirmed,
          clientRequestId: createClientRequestId(),
        });
        setApprovalPolicy(nextPolicy);
      }
      onClose();
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  };

  const selectedApprovalMode = approvalPolicy?.availableModes.find(
    (mode) => mode.id === selectedModeId,
  );
  const storedModeUnavailable = Boolean(
    approvalPolicy?.modeId &&
      !approvalPolicy.availableModes.some(
        (mode) => mode.id === approvalPolicy.modeId,
      ),
  );
  const changedToUnrestricted = Boolean(
    selectedApprovalMode?.unrestricted &&
      selectedModeId !== approvalPolicy?.modeId,
  );

  const removeProject = async () => {
    if (saving || deleting) return;
    if (
      !window.confirm(
        `„${project.name}“ samt lokaler Session-Liste aus GeminUI löschen? Die Projektdateien bleiben erhalten.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (deleteError) {
      setError(errorText(deleteError));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="modal-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !saving && !deleting) onClose();
      }}
    >
      <section
        className="project-dialog project-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
      >
        <header>
          <div>
            <p className="eyebrow">Projektverwaltung</p>
            <h2 id="project-settings-title">Projekt bearbeiten</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            disabled={saving || deleting}
            aria-label="Dialog schließen"
          >
            <Icon name="x" size={19} />
          </button>
        </header>

        <div className="dialog-tab-bar">
          <button
            type="button"
            className={`dialog-tab ${activeTab === "general" ? "dialog-tab--active" : ""}`}
            onClick={() => setActiveTab("general")}
          >
            Allgemein
          </button>
          <button
            type="button"
            className={`dialog-tab ${activeTab === "integrations" ? "dialog-tab--active" : ""}`}
            onClick={() => setActiveTab("integrations")}
          >
            <Icon name="gitlab" size={14} /> Integrationen
          </button>
        </div>

        {activeTab === "integrations" ? (
          <div className="dialog-body">
            {project && (
              <IntegrationsSettings
                projectId={project.id}
                rootRevision={project.rootRevision}
              />
            )}
          </div>
        ) : (
          <div className="dialog-body">
            <label className="field-label">
              <span>Projektname</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
                autoFocus
              />
            </label>

          <div className="approval-policy-field">
            <div className="field-heading">
              <div>
                <span>Freigaben für neue Sessions</span>
                <small>Wird nach jedem Erstellen oder Laden erneut mit Gemini geprüft</small>
              </div>
              {approvalLoading && <span className="mini-spinner" />}
            </div>
            <label className="approval-mode-select">
              <span className="sr-only">Projektweiter Gemini-Modus</span>
              <select
                value={selectedModeId}
                onChange={(event) => {
                  setSelectedModeId(event.target.value);
                  setUnrestrictedConfirmed(false);
                }}
                disabled={approvalLoading || !approvalPolicy}
              >
                <option value="">Gemini-Standard (jedes Mal nachfragen)</option>
                {storedModeUnavailable && approvalPolicy?.modeId && (
                  <option value={approvalPolicy.modeId} disabled>
                    Nicht verfügbar: {approvalPolicy.modeId}
                  </option>
                )}
                {approvalPolicy?.availableModes.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.unrestricted
                      ? `Alles erlauben (${mode.name})`
                      : mode.name}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={14} />
            </label>
            {selectedApprovalMode?.description && (
              <p className="approval-mode-description">
                {selectedApprovalMode.description}
              </p>
            )}
            {approvalPolicy?.message && (
              <div className="approval-policy-status" role="status">
                <Icon name="warning" size={15} />
                <span>{approvalPolicy.message}</span>
              </div>
            )}
            {selectedApprovalMode?.unrestricted && (
              <div className="unrestricted-warning" role="alert">
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
                        checked={unrestrictedConfirmed}
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

          <div className="folder-field">
            <div className="field-heading">
              <div>
                <span>Hauptordner</span>
                <small>Bleibt für bestehende Gemini-Sessions unveränderlich</small>
              </div>
            </div>
            <div className="selected-folder selected-folder--primary">
              <span className="folder-tile"><Icon name="folder" size={19} /></span>
              <div><strong>{displayName(primary)}</strong><span>{primary.path}</span></div>
              <div className="selected-folder-actions">
                <span className="primary-badge">Primär</span>
                <button
                  className="folder-reauthorize-button"
                  type="button"
                  onClick={() => void reauthorizeRoot(primary)}
                  disabled={Boolean(reauthorizingRootId)}
                  title="Ordnerzugriff über macOS erneut erteilen"
                  aria-label={`Zugriff auf ${displayName(primary)} erneut erteilen`}
                >
                  {reauthorizingRootId === primary.id ? (
                    <span className="mini-spinner" />
                  ) : authorizedRootIds.has(primary.id) ? (
                    <Icon name="check" size={14} />
                  ) : (
                    <Icon name="refresh" size={14} />
                  )}
                  {authorizedRootIds.has(primary.id) ? "Erlaubt" : "Zugriff"}
                </button>
              </div>
            </div>
          </div>

          <div className="folder-field">
            <div className="field-heading">
              <div>
                <span>Zusätzliche Ordner</span>
                <small>{additional.length}/{maxAdditionalRoots}</small>
              </div>
              <button
                type="button"
                onClick={() => void addFolders()}
                disabled={picking || additional.length >= maxAdditionalRoots}
              >
                {picking ? <span className="mini-spinner" /> : <Icon name="plus" size={14} />}
                Hinzufügen
              </button>
            </div>
            {additional.length > 0 ? (
              <div className="additional-folder-list">
                {additional.map((candidate) => {
                  const storedRoot = project.roots.find(
                    (root) =>
                      root.kind === "additional" && root.path === candidate.path,
                  );
                  return (
                    <div className="selected-folder" key={candidate.path}>
                      <span className="folder-tile"><Icon name="folder" size={17} /></span>
                      <div><strong>{displayName(candidate)}</strong><span>{candidate.path}</span></div>
                      <div className="selected-folder-actions">
                        {storedRoot && (
                          <button
                            className="folder-reauthorize-button"
                            type="button"
                            onClick={() => void reauthorizeRoot(storedRoot)}
                            disabled={Boolean(reauthorizingRootId)}
                            title="Ordnerzugriff über macOS erneut erteilen"
                            aria-label={`Zugriff auf ${displayName(candidate)} erneut erteilen`}
                          >
                            {reauthorizingRootId === storedRoot.id ? (
                              <span className="mini-spinner" />
                            ) : authorizedRootIds.has(storedRoot.id) ? (
                              <Icon name="check" size={14} />
                            ) : (
                              <Icon name="refresh" size={14} />
                            )}
                            {authorizedRootIds.has(storedRoot.id) ? "Erlaubt" : "Zugriff"}
                          </button>
                        )}
                        <button
                          className="folder-remove-button"
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
                className="empty-additional"
                type="button"
                onClick={() => void addFolders()}
                disabled={picking}
              >
                <Icon name="plus" size={16} /> Ordner hinzufügen
              </button>
            )}
          </div>

          <div className="access-note">
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

          <div className="project-danger-zone">
            <div>
              <strong>Projekt aus GeminUI löschen</strong>
              <span>Dateien in den verbundenen Ordnern werden nicht gelöscht.</span>
            </div>
            <button
              className="danger-button"
              type="button"
              onClick={() => void removeProject()}
              disabled={saving || deleting}
            >
              <Icon name="trash" size={14} /> {deleting ? "Wird gelöscht …" : "Löschen"}
            </button>
          </div>

          {error && (
            <div className="dialog-error" role="alert">
              <Icon name="warning" size={16} /> {error}
            </div>
          )}
        </div>
        )}

        <footer>
          <button
            className="secondary-button"
            type="button"
            onClick={onClose}
            disabled={saving || deleting}
          >
            {activeTab === "integrations" ? "Schließen" : "Abbrechen"}
          </button>
          {activeTab === "general" && (
            <button
              className="primary-button"
              type="button"
              onClick={() => void save()}
              disabled={
                !name.trim() ||
                saving ||
                deleting ||
                approvalLoading ||
                (changedToUnrestricted && !unrestrictedConfirmed)
              }
            >
              {saving && <span className="mini-spinner" />} Änderungen speichern
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
