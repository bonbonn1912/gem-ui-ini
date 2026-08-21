import { Icon } from "../../components/Icon";
import type { DiffSelection } from "./DiffViewer";
import type {
  GitFilePreview,
  GitPreviewGroup,
} from "./useGitChangePreviews";

type InlineDiffPreviewsProps = {
  group: GitPreviewGroup;
  onOpenDiff: (selection: DiffSelection) => void;
};

export function InlineDiffPreviews({
  group,
  onOpenDiff,
}: InlineDiffPreviewsProps) {
  return (
    <section className="inline-diff-group" aria-label="Dateiänderungen dieses Werkzeugs" aria-live="polite">
      <header>
        <span><Icon name="changes" size={15} /></span>
        <div>
          <strong>Dateiänderungen</strong>
          <small>{group.loading ? "Aktueller Git-Stand wird geprüft …" : fileCountLabel(group.totalFiles)}</small>
        </div>
        {group.loading && <span className="mini-spinner" />}
      </header>

      {!group.loading && (
        <div className="inline-diff-list">
          {group.previews.map((preview) => (
            <InlineFilePreview
              key={preview.key}
              preview={preview}
              onOpen={() => onOpenDiff(preview)}
            />
          ))}
          {group.totalFiles > group.previews.length && (
            <p className="inline-diff-more">
              +{group.totalFiles - group.previews.length} weitere geänderte {group.totalFiles - group.previews.length === 1 ? "Datei" : "Dateien"} im Changes-Panel
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function InlineFilePreview({
  preview,
  onOpen,
}: {
  preview: GitFilePreview;
  onOpen: () => void;
}) {
  return (
    <article className={`inline-file-diff inline-file-diff--${preview.state}`}>
      <header>
        <button type="button" onClick={onOpen} aria-label={`Vollständigen Diff für ${preview.path} in ${preview.repositoryLabel} anzeigen`}>
          <span className="inline-file-status">{preview.area === "staged" ? "S" : preview.state === "conflict" ? "U" : "M"}</span>
          <span className="inline-file-name">
            <strong>{fileName(preview.path)}</strong>
            <small title={preview.path}>
              {preview.repositoryLabel} · {preview.previousPath ? `${preview.previousPath} → ${preview.path}` : preview.path}
            </small>
          </span>
          <span className="inline-diff-counts">
            <i>+{preview.additions}</i>
            <b>−{preview.deletions}</b>
          </span>
          <Icon name="chevron-down" size={14} className="inline-diff-open" />
        </button>
      </header>

      {preview.state === "text" && preview.lines.length > 0 ? (
        <div className="inline-diff-lines" role="table" aria-label={`Diff-Vorschau für ${preview.path}`}>
          {preview.lines.map((line, index) => (
            <div className={`inline-diff-line inline-diff-line--${line.kind}`} role="row" key={`${index}:${line.oldLine}:${line.newLine}`}>
              <span aria-hidden="true">{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : line.kind === "no_newline" ? "\\" : " "}</span>
              <code role="cell">{line.content || " "}</code>
            </div>
          ))}
        </div>
      ) : (
        <p className="inline-diff-special">
          {preview.message ?? "Git meldet eine Änderung ohne darstellbare Textzeilen."}
        </p>
      )}
    </article>
  );
}

function fileName(value: string): string {
  return value.split("/").at(-1) || value;
}

function fileCountLabel(count: number): string {
  return `${count} geänderte ${count === 1 ? "Datei" : "Dateien"}`;
}
