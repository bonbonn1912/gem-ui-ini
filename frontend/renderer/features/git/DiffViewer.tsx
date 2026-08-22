import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";

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

export function DiffViewer(props: DiffViewerProps) {
  const [diff, setDiff] = createSignal<GitFileDiff | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    if (!props.selection) {
      setDiff(null);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    setError(null);
    window.gemUi.git.getFileDiff({
      projectId: props.project.id,
      expectedRootRevision: props.project.rootRevision,
      repositoryId: props.selection.repositoryId,
      fileId: props.selection.fileId,
      area: props.selection.area,
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
    onCleanup(() => { current = false; });
  });

  const rows = createMemo<DiffRow[]>(() => {
    if (!diff() || diff().state !== "text") return [];
    return diff().hunks.flatMap((hunk) => [
      { key: hunk.hunkId, type: "hunk" as const, header: hunk.header },
      ...hunk.lines.map((line, index) => ({
        key: `${hunk.hunkId}:${index}`,
        type: "line" as const,
        kind: line.kind,
        content: line.content,
        oldLine: line.oldLine ?? null,
        newLine: line.newLine ?? null,
      })),
    ]);
  });

  return (
    <Show when={props.selection && props.change} fallback={
      <div class="git-diff-empty">
        <span><Icon name="changes" size={22} /></span>
        <strong>Datei auswählen</strong>
        <p>Öffne eine Änderung, um ihren vollständigen Unified Diff zu sehen.</p>
      </div>
    }>
    <section class="git-diff-view" aria-label={`Diff für ${props.selection.path}`}>
      <header class="git-diff-header">
        <button class="icon-button git-diff-back" type="button" onClick={props.onBack} aria-label="Zurück zur Änderungsliste">
          <Icon name="arrow-left" size={17} />
        </button>
        <div>
          <strong title={props.selection.path}>{fileName(props.selection.path)}</strong>
          <span title={props.selection.path}>
            {props.change.previousPath ? `${props.change.previousPath} → ${props.change.path}` : props.change.path}
          </span>
        </div>
        <span class={`git-area-badge git-area-badge--${props.selection.area}`}>
          {props.selection.area === "staged" ? "Vorgemerkt" : "Arbeitskopie"}
        </span>
      </header>

      {loading() ? (
        <div class="git-diff-state"><span class="mini-spinner" /><p>Diff wird vollständig geladen …</p></div>
      ) : error() ? (
        <div class="git-diff-state git-diff-state--error"><Icon name="warning" size={22} /><strong>Diff nicht verfügbar</strong><p>{error()}</p></div>
      ) : diff() && diff().state !== "text" ? (
        <DiffSpecialState diff={diff()} />
      ) : diff() ? (
        <>
          <div class="git-diff-summary">
            <span class="diff-additions">+{diff().additions}</span>
            <span class="diff-deletions">−{diff().deletions}</span>
            {diff().metadata.filter((line) => !line.startsWith("diff --git ") && !line.startsWith("--- ") && !line.startsWith("+++ ")).slice(0, 3).map((line) => (
              <code >{line}</code>
            ))}
          </div>
          {rows().length > 0 ? (
            <VirtualDiffRows rows={rows()} />
          ) : (
            <div class="git-diff-state"><strong>Nur Metadaten geändert</strong><p>Git meldet beispielsweise eine Modus- oder Rename-Änderung ohne Textzeilen.</p></div>
          )}
        </>
      ) : null}
    </section>
    </Show>
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
    <div class={`git-diff-state git-diff-state--${diff.state}`}>
      <Icon name={diff.state === "error" || diff.state === "conflict" ? "warning" : "changes"} size={23} />
      <strong>{title}</strong>
      <p>{diff.message}</p>
      {diff.metadata.map((line) => <code >{line}</code>)}
    </div>
  );
}

function VirtualDiffRows({ rows }: { rows: DiffRow[] }) {
  let container!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportHeight, setViewportHeight] = createSignal(420);
  const rowHeight = 23;
  const overscan = 35;
  const start = createMemo(() => Math.max(0, Math.floor(scrollTop() / rowHeight) - overscan));
  const end = createMemo(() => Math.min(
    rows.length,
    Math.ceil((scrollTop() + viewportHeight()) / rowHeight) + overscan,
  ));

  createEffect(() => {
    const element = container;
    if (!element) return;
    const update = () => setViewportHeight(element.clientHeight || 420);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      class="git-diff-rows"
      ref={container}
      role="table"
      aria-label="Unified Diff-Zeilen"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div class="git-diff-rows-space" style={{ height: `${rows.length * rowHeight}px` }}>
        {rows.slice(start(), end()).map((row, visibleIndex) => (
          <DiffRowView

            row={row}
            top={(start() + visibleIndex) * rowHeight}
          />
        ))}
      </div>
    </div>
  );
}

function DiffRowView({ row, top }: { row: DiffRow; top: number }) {
  if (row.type === "hunk") {
    return (
      <div class="git-diff-row git-diff-row--hunk" role="row" style={{ top: `${top}px` }}>
        <span role="cell">{row.header}</span>
      </div>
    );
  }
  const prefix = row.kind === "addition" ? "+" : row.kind === "deletion" ? "−" : row.kind === "no_newline" ? "\\" : " ";
  return (
    <div class={`git-diff-row git-diff-row--${row.kind}`} role="row" style={{ top: `${top}px` }}>
      <span class="git-line-number" role="cell">{row.oldLine ?? ""}</span>
      <span class="git-line-number" role="cell">{row.newLine ?? ""}</span>
      <span class="git-line-prefix" aria-hidden="true">{prefix}</span>
      <code role="cell">{row.content || " "}</code>
    </div>
  );
}

function fileName(value: string): string {
  return value.split("/").at(-1) || value;
}
