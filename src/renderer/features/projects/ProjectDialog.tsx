import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { ProjectRootCandidate } from "../../types";

type ProjectDialogProps = {
  open: boolean;
  maxAdditionalRoots: number;
  onClose: () => void;
  onCreate: (input: {
    name: string;
    primaryRoot: ProjectRootCandidate;
    additionalRoots: ProjectRootCandidate[];
  }) => Promise<void>;
};

function candidateKey(candidate: ProjectRootCandidate): string {
  return candidate.path;
}

function folderName(candidate: ProjectRootCandidate): string {
  if (candidate.label) return candidate.label;
  return candidate.path.split(/[\\/]/).filter(Boolean).at(-1) ?? candidate.path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Das Projekt konnte nicht angelegt werden.";
}

export function ProjectDialog({
  open,
  maxAdditionalRoots,
  onClose,
  onCreate,
}: ProjectDialogProps) {
  const [name, setName] = useState("");
  const [primary, setPrimary] = useState<ProjectRootCandidate | null>(null);
  const [additional, setAdditional] = useState<ProjectRootCandidate[]>([]);
  const [picking, setPicking] = useState<"primary" | "additional" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setPrimary(null);
    setAdditional([]);
    setError(null);
    window.setTimeout(() => nameRef.current?.focus(), 0);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  const pickPrimary = async () => {
    setPicking("primary");
    setError(null);
    try {
      const candidates = await window.gemUi.projects.pickFolders();
      const selected = candidates[0];
      if (!selected) return;
      setPrimary(selected);
      setAdditional((current) => current.filter((item) => candidateKey(item) !== candidateKey(selected)));
      if (!name.trim()) setName(folderName(selected));
      if (candidates.length > 1) {
        const extras = candidates.slice(1).filter((item) => candidateKey(item) !== candidateKey(selected));
        setAdditional((current) => {
          const byPath = new Map(current.map((item) => [candidateKey(item), item]));
          for (const item of extras) byPath.set(candidateKey(item), item);
          return [...byPath.values()].slice(0, maxAdditionalRoots);
        });
      }
    } catch (pickError) {
      setError(errorText(pickError));
    } finally {
      setPicking(null);
    }
  };

  const pickAdditional = async () => {
    setPicking("additional");
    setError(null);
    try {
      const candidates = await window.gemUi.projects.pickFolders();
      setAdditional((current) => {
        const byPath = new Map(current.map((item) => [candidateKey(item), item]));
        for (const item of candidates) {
          if (primary && candidateKey(item) === candidateKey(primary)) continue;
          byPath.set(candidateKey(item), item);
        }
        if (byPath.size > maxAdditionalRoots) {
          setError(`Gemini unterstützt derzeit höchstens ${maxAdditionalRoots} zusätzliche Ordner.`);
        }
        return [...byPath.values()].slice(0, maxAdditionalRoots);
      });
    } catch (pickError) {
      setError(errorText(pickError));
    } finally {
      setPicking(null);
    }
  };

  const submit = async () => {
    if (!primary || !name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), primaryRoot: primary, additionalRoots: additional });
      onClose();
    } catch (submitError) {
      setError(errorText(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !submitting) onClose();
    }}>
      <section className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <header>
          <div>
            <p className="eyebrow">Multi-Root Workspace</p>
            <h2 id="project-dialog-title">Neues Projekt</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} aria-label="Dialog schließen">
            <Icon name="x" size={19} />
          </button>
        </header>

        <div className="dialog-body">
          <label className="field-label">
            <span>Projektname</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="z. B. Kundenportal"
              maxLength={120}
            />
          </label>

          <div className="folder-field">
            <div className="field-heading">
              <div><span>Hauptordner</span><small>Arbeitsverzeichnis der Session</small></div>
              {primary && <button type="button" onClick={() => void pickPrimary()}>Ändern</button>}
            </div>
            {primary ? (
              <div className="selected-folder selected-folder--primary">
                <span className="folder-tile"><Icon name="folder" size={19} /></span>
                <div><strong>{folderName(primary)}</strong><span>{primary.path}</span></div>
                <span className="primary-badge">Primär</span>
              </div>
            ) : (
              <button className="folder-picker" type="button" onClick={() => void pickPrimary()} disabled={Boolean(picking)}>
                {picking === "primary" ? <span className="mini-spinner" /> : <Icon name="folder-plus" size={22} />}
                <span><strong>Hauptordner auswählen</strong><small>Dieser Ordner bestimmt den Session-Speicher.</small></span>
              </button>
            )}
          </div>

          <div className="folder-field">
            <div className="field-heading">
              <div><span>Zusätzliche Ordner</span><small>Optional · {additional.length}/{maxAdditionalRoots}</small></div>
              <button type="button" onClick={() => void pickAdditional()} disabled={!primary || Boolean(picking) || additional.length >= maxAdditionalRoots}>
                <Icon name="plus" size={14} /> Hinzufügen
              </button>
            </div>
            {additional.length ? (
              <div className="additional-folder-list">
                {additional.map((candidate) => (
                  <div className="selected-folder" key={candidateKey(candidate)}>
                    <span className="folder-tile"><Icon name="folder" size={17} /></span>
                    <div><strong>{folderName(candidate)}</strong><span>{candidate.path}</span></div>
                    <button type="button" onClick={() => setAdditional((current) => current.filter((item) => candidateKey(item) !== candidateKey(candidate)))} aria-label={`${folderName(candidate)} entfernen`}>
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <button className="empty-additional" type="button" onClick={() => void pickAdditional()} disabled={!primary || Boolean(picking)}>
                <Icon name="plus" size={16} /> Ordner aus anderen Verzeichnissen hinzufügen
              </button>
            )}
          </div>

          <div className="access-note">
            <Icon name="shield" size={18} />
            <p><strong>Gemeinsamer Arbeitskontext</strong><span>Gemini darf alle ausgewählten Ordner lesen und – nach den geltenden Freigaben – ändern.</span></p>
          </div>
          {error && <div className="dialog-error" role="alert"><Icon name="warning" size={16} /> {error}</div>}
        </div>

        <footer>
          <button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>Abbrechen</button>
          <button className="primary-button" type="button" onClick={() => void submit()} disabled={!primary || !name.trim() || submitting}>
            {submitting && <span className="mini-spinner" />}
            Projekt anlegen
          </button>
        </footer>
      </section>
    </div>
  );
}
