import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../../components/Icon";
import type {
  AppProject,
  GitFileChange,
  GitFileDiff,
} from "../../types";

export type DiffSelection = {
  repositoryId: string;
  fileId: string;
  path: string;
  area: "unstaged" | "staged";
};

type DiffViewerProps = {
  project: AppProject;
  selection: DiffSelection | null;
  change: GitFileChange | null;
  onBack: () => void;
};

type DiffRow =
  | { key: string; type: "hunk"; header: string }
  | {
      key: string;
      type: "line";
      kind: "context" | "addition" | "deletion" | "no_newline";
      content: string;
      oldLine: number | null;
      newLine: number | null;
    };

export function DiffViewer({
  project,
  selection,
  change,
  onBack,
}: DiffViewerProps) {
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selection) {
      setDiff(null);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    window.gemUi.git.getFileDiff({
      projectId: project.id,
      expectedRootRevision: project.rootRevision,
      repositoryId: selection.repositoryId,
      fileId: selection.fileId,
      area: selection.area,
    }).then((next) => {
      if (current) setDiff(next);
    }).catch((reason: unknown) => {
      if (current) {
        setDiff(null);
        setError(reason instanceof Error ? reason.message : "Der Diff konnte nicht geladen werden.");
      }
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [project.id, project.rootRevision, selection]);

  const rows = useMemo<DiffRow[]>(() => {
    if (!diff || diff.state !== "text") return [];
    return diff.hunks.flatMap((hunk) => [
      { key: hunk.hunkId, type: "hunk" as const, header: hunk.header },
      ...hunk.lines.map((line, index) => ({
        key: `${hunk.hunkId}:${index}`,
        type: "line" as const,
        ...line,
      })),
    ]);
  }, [diff]);

  if (!selection || !change) {
    return (
      <div className="git-diff-empty">
        <span><Icon name="changes" size={22} /></span>
        <strong>Datei auswählen</strong>
        <p>Öffne eine Änderung, um ihren vollständigen Unified Diff zu sehen.</p>
      </div>
    );
  }

  return (
    <section className="git-diff-view" aria-label={`Diff für ${selection.path}`}>
      <header className="git-diff-header">
        <button className="icon-button git-diff-back" type="button" onClick={onBack} aria-label="Zurück zur Änderungsliste">
          <Icon name="arrow-left" size={17} />
        </button>
        <div>
          <strong title={selection.path}>{fileName(selection.path)}</strong>
          <span title={selection.path}>
            {change.previousPath ? `${change.previousPath} → ${change.path}` : change.path}
          </span>
        </div>
        <span className={`git-area-badge git-area-badge--${selection.area}`}>
          {selection.area === "staged" ? "Vorgemerkt" : "Arbeitskopie"}
        </span>
      </header>

      {loading ? (
        <div className="git-diff-state"><span className="mini-spinner" /><p>Diff wird vollständig geladen …</p></div>
      ) : error ? (
        <div className="git-diff-state git-diff-state--error"><Icon name="warning" size={22} /><strong>Diff nicht verfügbar</strong><p>{error}</p></div>
      ) : diff && diff.state !== "text" ? (
        <DiffSpecialState diff={diff} />
      ) : diff ? (
        <>
          <div className="git-diff-summary">
            <span className="diff-additions">+{diff.additions}</span>
            <span className="diff-deletions">−{diff.deletions}</span>
            {diff.metadata.filter((line) => !line.startsWith("diff --git ") && !line.startsWith("--- ") && !line.startsWith("+++ ")).slice(0, 3).map((line) => (
              <code key={line}>{line}</code>
            ))}
          </div>
          {rows.length > 0 ? (
            <VirtualDiffRows rows={rows} />
          ) : (
            <div className="git-diff-state"><strong>Nur Metadaten geändert</strong><p>Git meldet beispielsweise eine Modus- oder Rename-Änderung ohne Textzeilen.</p></div>
          )}
        </>
      ) : null}
    </section>
  );
}

function DiffSpecialState({ diff }: { diff: GitFileDiff }) {
  const title = {
    binary: "Binärdatei",
    submodule: "Submodule geändert",
    conflict: "Merge-Konflikt",
    too_large: "Diff zu groß",
    unavailable: "Diff nicht mehr verfügbar",
    error: "Diff fehlgeschlagen",
    text: "Diff",
  }[diff.state];
  return (
    <div className={`git-diff-state git-diff-state--${diff.state}`}>
      <Icon name={diff.state === "error" || diff.state === "conflict" ? "warning" : "changes"} size={23} />
      <strong>{title}</strong>
      <p>{diff.message}</p>
      {diff.metadata.map((line) => <code key={line}>{line}</code>)}
    </div>
  );
}

function VirtualDiffRows({ rows }: { rows: DiffRow[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(420);
  const rowHeight = 23;
  const overscan = 35;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan,
  );

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setViewportHeight(element.clientHeight || 420);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="git-diff-rows"
      ref={container}
      role="table"
      aria-label="Unified Diff-Zeilen"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="git-diff-rows-space" style={{ height: rows.length * rowHeight }}>
        {rows.slice(start, end).map((row, visibleIndex) => (
          <DiffRowView
            key={row.key}
            row={row}
            top={(start + visibleIndex) * rowHeight}
          />
        ))}
      </div>
    </div>
  );
}

function DiffRowView({ row, top }: { row: DiffRow; top: number }) {
  if (row.type === "hunk") {
    return (
      <div className="git-diff-row git-diff-row--hunk" role="row" style={{ top }}>
        <span role="cell">{row.header}</span>
      </div>
    );
  }
  const prefix = row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : row.kind === "no_newline" ? "\\" : " ";
  return (
    <div className={`git-diff-row git-diff-row--${row.kind}`} role="row" style={{ top }}>
      <span className="git-line-number" role="cell">{row.oldLine ?? ""}</span>
      <span className="git-line-number" role="cell">{row.newLine ?? ""}</span>
      <span className="git-line-prefix" aria-hidden="true">{prefix}</span>
      <code role="cell">{row.content || " "}</code>
    </div>
  );
}

function fileName(value: string): string {
  return value.split("/").at(-1) || value;
}
