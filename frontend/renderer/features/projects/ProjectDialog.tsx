import { createEffect, createSignal, onCleanup, Show } from "solid-js";
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

export function ProjectDialog(props: ProjectDialogProps) {
  const [name, setName] = createSignal("");
  const [primary, setPrimary] = createSignal<ProjectRootCandidate | null>(null);
  const [additional, setAdditional] = createSignal<ProjectRootCandidate[]>([]);
  const [picking, setPicking] = createSignal<"primary" | "additional" | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let nameRef!: HTMLInputElement;

  createEffect(() => {
    if (!props.open) return;
    setName("");
    setPrimary(null);
    setAdditional([]);
    setError(null);
    window.setTimeout(() => nameRef?.focus(), 0);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    onCleanup(() => window.removeEventListener("keydown", closeOnEscape));
  });

  const pickPrimary = async () => {
    setPicking("primary");
    setError(null);
    try {
      const candidates = await window.gemUi.projects.pickFolders();
      const selected = candidates[0];
      if (!selected) return;
      setPrimary(selected);
      setAdditional((current) => current.filter((item) => candidateKey(item) !== candidateKey(selected)));
      if (!name().trim()) setName(folderName(selected));
      if (candidates.length > 1) {
        const extras = candidates.slice(1).filter((item) => candidateKey(item) !== candidateKey(selected));
        setAdditional((current) => {
          const byPath = new Map(current.map((item) => [candidateKey(item), item]));
          for (const item of extras) byPath.set(candidateKey(item), item);
          return [...byPath.values()].slice(0, props.maxAdditionalRoots);
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
          if (primary() && candidateKey(item) === candidateKey(primary())) continue;
          byPath.set(candidateKey(item), item);
        }
        if (byPath.size > props.maxAdditionalRoots) {
          setError(`Gemini unterstützt derzeit höchstens ${props.maxAdditionalRoots} zusätzliche Ordner.`);
        }
        return [...byPath.values()].slice(0, props.maxAdditionalRoots);
      });
    } catch (pickError) {
      setError(errorText(pickError));
    } finally {
      setPicking(null);
    }
  };

  const submit = async () => {
    if (!primary() || !name().trim() || submitting()) return;
    setSubmitting(true);
    setError(null);
    try {
      await props.onCreate({ name: name().trim(), primaryRoot: primary()!, additionalRoots: additional() });
      props.onClose();
    } catch (submitError) {
      setError(errorText(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Show when={props.open}>
      <div class="modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target && !submitting()) props.onClose();
    }}>
      <section class="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <header>
          <div>
            <p class="eyebrow">Multi-Root Workspace</p>
            <h2 id="project-dialog-title">Neues Projekt</h2>
          </div>
          <button class="icon-button" type="button" onClick={props.onClose} disabled={submitting()} aria-label="Dialog schließen">
            <Icon name="x" size={19} />
          </button>
        </header>

        <div class="dialog-body">
          <label class="field-label">
            <span>Projektname</span>
            <input
              ref={nameRef}
              value={name()}
              onChange={(event) => setName(event.target.value)}
              placeholder="z. B. Kundenportal"
              maxLength={120}
            />
          </label>

          <div class="folder-field">
            <div class="field-heading">
              <div><span>Hauptordner</span><small>Arbeitsverzeichnis der Session</small></div>
              {primary() && <button type="button" onClick={() => void pickPrimary()}>Ändern</button>}
            </div>
            {primary() ? (
              <div class="selected-folder selected-folder--primary">
                <span class="folder-tile"><Icon name="folder" size={19} /></span>
                <div><strong>{folderName(primary())}</strong><span>{primary().path}</span></div>
                <span class="primary-badge">Primär</span>
              </div>
            ) : (
              <button class="folder-picker" type="button" onClick={() => void pickPrimary()} disabled={Boolean(picking())}>
                {picking() === "primary" ? <span class="mini-spinner" /> : <Icon name="folder-plus" size={22} />}
                <span><strong>Hauptordner auswählen</strong><small>Dieser Ordner bestimmt den Session-Speicher.</small></span>
              </button>
            )}
          </div>

          <div class="folder-field">
            <div class="field-heading">
              <div><span>Zusätzliche Ordner</span><small>Optional · {additional().length}/{props.maxAdditionalRoots}</small></div>
              <button type="button" onClick={() => void pickAdditional()} disabled={!primary() || Boolean(picking()) || additional().length >= props.maxAdditionalRoots}>
                <Icon name="plus" size={14} /> Hinzufügen
              </button>
            </div>
            {additional().length ? (
              <div class="additional-folder-list">
                {additional().map((candidate) => (
                  <div class="selected-folder" >
                    <span class="folder-tile"><Icon name="folder" size={17} /></span>
                    <div><strong>{folderName(candidate)}</strong><span>{candidate.path}</span></div>
                    <button type="button" onClick={() => setAdditional((current) => current.filter((item) => candidateKey(item) !== candidateKey(candidate)))} aria-label={`${folderName(candidate)} entfernen`}>
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <button class="empty-additional" type="button" onClick={() => void pickAdditional()} disabled={!primary() || Boolean(picking())}>
                <Icon name="plus" size={16} /> Ordner aus anderen Verzeichnissen hinzufügen
              </button>
            )}
          </div>

          <div class="access-note">
            <Icon name="shield" size={18} />
            <p><strong>Gemeinsamer Arbeitskontext</strong><span>Gemini darf alle ausgewählten Ordner lesen und – nach den geltenden Freigaben – ändern.</span></p>
          </div>
          {error() && <div class="dialog-error" role="alert"><Icon name="warning" size={16} /> {error()}</div>}
        </div>

        <footer>
          <button class="secondary-button" type="button" onClick={props.onClose} disabled={submitting()}>Abbrechen</button>
          <button class="primary-button" type="button" onClick={() => void submit()} disabled={!primary() || !name().trim() || submitting()}>
            {submitting() && <span class="mini-spinner" />}
            Projekt anlegen
          </button>
        </footer>
      </section>
      </div>
    </Show>
  );
}
