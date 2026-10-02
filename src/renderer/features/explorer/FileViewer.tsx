import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type {
  AppProject,
  ProjectFileSearchEntry,
  ReadProjectFileResult,
} from "../../types";
import { detectLanguage, highlightCode } from "./syntax-highlighter";

type FileViewerProps = {
  project: AppProject;
  file: {
    rootId: string;
    rootLabel?: string;
    relativePath: string;
    displayName: string;
    kind?: string;
    size?: number;
    childCount?: number;
    contextEligible?: boolean;
    contextUnavailableReason?: string | null;
  };
  onClose: () => void;
  onBack?: () => void;
  onAddToContext?: (entry: ProjectFileSearchEntry) => void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MiB`;
}

export function FileViewer({
  project,
  file,
  onClose,
  onBack,
  onAddToContext,
}: FileViewerProps) {
  const [data, setData] = useState<ReadProjectFileResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const codeViewportRef = useRef<HTMLDivElement>(null);
  const requestGeneration = useRef(0);

  const handleClose = onBack || onClose;

  const loadFile = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.gemUi.projectFiles.readFile({
        projectId: project.id,
        expectedRootRevision: project.rootRevision,
        rootId: file.rootId,
        relativePath: file.relativePath,
      });
      if (generation !== requestGeneration.current) return;
      setData(result);
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      setError(
        err instanceof Error ? err.message : "Datei konnte nicht geladen werden.",
      );
      setData(null);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [project.id, project.rootRevision, file.rootId, file.relativePath]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  // Keyboard shortcut: Escape to close viewer
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose]);

  const highlightedLines = useMemo(() => {
    if (!data?.content || data.binary) return [];
    const language = data.language || detectLanguage(file.displayName || file.relativePath);
    return highlightCode(data.content, language);
  }, [data, file.displayName, file.relativePath]);
  const virtualize = highlightedLines.length > 500 && !wrapLines;
  const firstVisibleLine = virtualize ? Math.max(0, Math.floor(scrollTop / 20) - 20) : 0;
  const visibleLineCount = virtualize ? Math.ceil(viewportHeight / 20) + 40 : highlightedLines.length;
  const visibleLines = highlightedLines.slice(firstVisibleLine, firstVisibleLine + visibleLineCount);

  const handleCopy = async () => {
    if (!data?.content || data.binary) return;
    try {
      await navigator.clipboard.writeText(data.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard error
    }
  };

  const handleAddToContext = () => {
    if (!onAddToContext) return;
    const entry: ProjectFileSearchEntry = {
      rootId: file.rootId,
      rootLabel: file.rootLabel || project.name,
      relativePath: file.relativePath,
      displayName: file.displayName,
      kind: "file",
      size: data?.size ?? file.size ?? 0,
      childCount: 0,
      contextEligible: file.contextEligible !== false,
      contextUnavailableReason: file.contextUnavailableReason ?? null,
    };
    onAddToContext(entry);
  };

  const isImage = data?.binary && data?.content && data.mimeType.startsWith("image/");
  const isBinaryOther = data?.binary && !isImage;

  return (
    <div
      className="file-viewer file-viewer-main"
      role="region"
      aria-label={`Dateiinhalt: ${file.displayName}`}
    >
      <header className="file-viewer-header">
        <div className="file-viewer-header-left">
          <span className="file-viewer-file-icon">
            <Icon name="file-text" size={18} />
          </span>
          <div className="file-viewer-titles">
            <h2 className="file-viewer-filename" title={file.displayName}>
              {file.displayName}
            </h2>
            <span className="file-viewer-filepath" title={file.relativePath}>
              {file.rootLabel ? `${file.rootLabel}/${file.relativePath}` : file.relativePath}
            </span>
          </div>

          <div className="file-viewer-badges">
            {data && (
              <>
                <span className="file-viewer-badge file-viewer-badge--size">
                  {formatBytes(data.size)}
                </span>
                {data.language && (
                  <span className="file-viewer-badge file-viewer-badge--lang">
                    {data.language}
                  </span>
                )}
                {!data.binary && (
                  <span className="file-viewer-badge file-viewer-badge--lines">
                    {data.lineCount} {data.lineCount === 1 ? "Zeile" : "Zeilen"}
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="file-viewer-header-right">
          <div className="file-viewer-actions">
            {!data?.binary && (
              <button
                className={`file-viewer-action-btn ${wrapLines ? "file-viewer-action-btn--active" : ""}`}
                type="button"
                onClick={() => setWrapLines((w) => !w)}
                title={wrapLines ? "Zeilenumbruch deaktivieren" : "Zeilenumbruch aktivieren"}
                aria-label="Zeilenumbruch umschalten"
              >
                <Icon name="checklist" size={13} />
                <span>Umbruch</span>
              </button>
            )}

            {!data?.binary && (
              <button
                className="file-viewer-action-btn"
                type="button"
                onClick={handleCopy}
                disabled={!data?.content}
                title="Inhalt in die Zwischenablage kopieren"
                aria-label="Inhalt kopieren"
              >
                <Icon name="checklist" size={13} />
                <span>{copied ? "Kopiert!" : "Kopieren"}</span>
              </button>
            )}

            {onAddToContext && (
              <button
                className="file-viewer-action-btn file-viewer-action-btn--primary"
                type="button"
                onClick={handleAddToContext}
                title="Datei als Prompt-Kontext übernehmen"
                aria-label="Datei in Chat übernehmen"
              >
                <Icon name="folder-plus" size={13} />
                <span>In Chat</span>
              </button>
            )}

            <button
              className="icon-button file-viewer-close-btn"
              type="button"
              onClick={handleClose}
              aria-label="Dateivorschau schließen"
              title="Dateivorschau schließen (Esc)"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
      </header>

      <div className="file-viewer-body">
        {loading && (
          <div className="file-viewer-loading">
            <span className="mini-spinner" />
            <p>Datei wird geladen …</p>
          </div>
        )}

        {error && (
          <div className="file-viewer-error" role="alert">
            <Icon name="warning" size={18} />
            <div>
              <strong>Fehler beim Laden</strong>
              <p>{error}</p>
            </div>
            <button type="button" onClick={() => void loadFile()}>
              Erneut versuchen
            </button>
          </div>
        )}

        {!loading && !error && isImage && (
          <div className="file-viewer-image-preview">
            <img src={data!.content!} alt={file.displayName} />
          </div>
        )}

        {!loading && !error && isBinaryOther && (
          <div className="file-viewer-empty">
            <span>
              <Icon name="file-text" size={26} />
            </span>
            <strong>Binärdatei</strong>
            <p>
              Für diese Datei ({data?.mimeType || "Binärformat"}) ist keine Textvorschau verfügbar.
            </p>
          </div>
        )}

        {!loading && !error && !data?.binary && (
            <div
            ref={codeViewportRef}
            onScroll={(event) => {
              setScrollTop(event.currentTarget.scrollTop);
              setViewportHeight(event.currentTarget.clientHeight);
            }}
            className={`file-viewer-code-wrapper ${
              wrapLines ? "file-viewer-code-wrapper--wrap" : ""
            } ${virtualize ? "file-viewer-code-wrapper--virtual" : ""}`}
            tabIndex={0}
            role="region"
            aria-label="Quellcode"
          >
            {data?.truncated && (
              <div className="file-viewer-truncated-banner">
                Vorschau auf die ersten 1 MiB begrenzt.
              </div>
            )}
            <div className="file-viewer-lines">
              {virtualize && <div aria-hidden="true" style={{ height: firstVisibleLine * 20, flexShrink: 0 }} />}
              {visibleLines.map((lineTokens, visibleIndex) => {
                const index = firstVisibleLine + visibleIndex;
                return (
                <div key={index} className="file-viewer-line">
                  <span className="file-viewer-line-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="file-viewer-line-content">
                    <code>
                      {lineTokens.length === 0 ? (
                        " "
                      ) : (
                        lineTokens.map((token, tIdx) => (
                          <span key={tIdx} className={`tok tok-${token.type}`}>
                            {token.text}
                          </span>
                        ))
                      )}
                    </code>
                  </span>
                </div>
              );})}
              {virtualize && <div aria-hidden="true" style={{ height: Math.max(0, highlightedLines.length - firstVisibleLine - visibleLines.length) * 20, flexShrink: 0 }} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
