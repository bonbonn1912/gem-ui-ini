import { useEffect, useMemo, useRef, useState } from "react";
import type { MessageItem, PermissionItem, TimelineItem, ToolItem } from "./reducer";
import { MarkdownContent } from "../../components/MarkdownContent";
import { Icon } from "../../components/Icon";
import type { DiffSelection } from "../git/DiffViewer";
import { InlineDiffPreviews } from "../git/InlineDiffPreviews";
import type { GitPreviewGroup } from "../git/useGitChangePreviews";

type TimelineProps = {
  items: TimelineItem[];
  sessionTitle: string;
  gitPreviewGroups: ReadonlyMap<string, GitPreviewGroup>;
  onOpenExternal: (url: string) => void;
  onOpenGitDiff: (selection: DiffSelection) => void;
  onRespondToPermission: (requestId: string, optionId: string) => void;
};

function formatPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractMarkdownPayload(input: unknown, output: unknown, locations?: { path: string }[]): string | null {
  const isMdLocation = locations?.some((loc) => loc.path.toLowerCase().endsWith(".md")) || false;
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    const target = String(record.TargetFile ?? record.target_file ?? record.path ?? record.filePath ?? "");
    const content = record.CodeContent ?? record.content ?? record.replacementContent ?? record.text;
    if ((target.toLowerCase().endsWith(".md") || target.toLowerCase().includes("plan.md") || isMdLocation) && typeof content === "string" && content.trim()) {
      return content;
    }
  }
  if (typeof output === "string" && (isMdLocation || output.trim().startsWith("#"))) {
    return output;
  }
  if (typeof output === "object" && output !== null) {
    const record = output as Record<string, unknown>;
    const content = record.content ?? record.text ?? record.output;
    if (isMdLocation && typeof content === "string" && content.trim()) {
      return content;
    }
  }
  return null;
}

function ToolCard({ item, onOpenExternal }: { item: ToolItem; onOpenExternal?: (url: string) => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const markdownPayload = useMemo(
    () => extractMarkdownPayload(item.input, item.output, item.locations),
    [item.input, item.output, item.locations],
  );

  const statusLabel =
    item.status === "running"
      ? "Läuft"
      : item.status === "completed"
        ? "Abgeschlossen"
        : "Fehlgeschlagen";

  return (
    <details className={`tool-card tool-card--${item.status}`} open={item.status === "failed"}>
      <summary>
        <span className="tool-icon">
          {item.status === "completed" ? (
            <Icon name="check" size={16} />
          ) : item.status === "failed" ? (
            <Icon name="warning" size={16} />
          ) : (
            <Icon name="tool" size={16} />
          )}
        </span>
        <span className="tool-title">{item.title}</span>
        <span className={`tool-status tool-status--${item.status}`}>
          {item.status === "running" && <span className="mini-spinner" />}
          {statusLabel}
        </span>
        <Icon name="chevron-down" size={15} className="details-chevron" />
      </summary>
      <div className="tool-body">
        {item.locations?.length ? (
          <div className="tool-locations">
            {item.locations.map((location) => (
              <span key={`${location.path}:${location.line ?? ""}`}>
                {location.path}
                {location.line ? `:${location.line}` : ""}
              </span>
            ))}
          </div>
        ) : null}

        {markdownPayload && (
          <section className="tool-markdown-section">
            <div className="tool-section-header">
              <h4>Dokumentinhalt</h4>
              <button
                type="button"
                className="raw-toggle-btn"
                onClick={() => setShowRaw((v) => !v)}
                title={showRaw ? "Formatiertes Markdown anzeigen" : "Raw Markdown anzeigen"}
              >
                <Icon name={showRaw ? "sparkle" : "file-text"} size={13} />
                <span>{showRaw ? "Formatiert" : "Raw"}</span>
              </button>
            </div>
            {!showRaw ? (
              <div className="tool-markdown-container">
                <MarkdownContent onOpenExternal={onOpenExternal ?? ((url) => window.open(url, "_blank"))}>{markdownPayload}</MarkdownContent>
              </div>
            ) : (
              <pre>{markdownPayload}</pre>
            )}
          </section>
        )}

        {item.input !== undefined && !markdownPayload && (
          <section>
            <h4>Eingabe</h4>
            <pre>{formatPayload(item.input)}</pre>
          </section>
        )}
        {item.diff && (
          <section>
            <h4>Änderung</h4>
            <pre className="diff-view">
              {item.diff.split("\n").map((line, index) => (
                <span
                  className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : ""}
                  key={`${index}:${line}`}
                >
                  {line || " "}
                  {"\n"}
                </span>
              ))}
            </pre>
          </section>
        )}
        {item.output !== undefined && !markdownPayload && (
          <section>
            <h4>Ergebnis</h4>
            <pre>{formatPayload(item.output)}</pre>
          </section>
        )}
        {item.error && <p className="tool-error">{item.error}</p>}
      </div>
    </details>
  );
}

/**
 * Bündelt aufeinanderfolgende Tool-Schritte in eine einzige, scrollbare Box,
 * statt für jede gelesene Datei eine eigene Klappbox in den Verlauf zu hängen.
 * Unterbrochen wird die Gruppe von allem, was keine Tool-Ausführung ist —
 * insbesondere von Freigabe-Anfragen. Danach beginnt eine neue Box.
 */
function ToolRunGroup({
  items,
  gitPreviewGroups,
  onOpenGitDiff,
  onOpenExternal,
}: {
  items: ToolItem[];
  gitPreviewGroups: ReadonlyMap<string, GitPreviewGroup>;
  onOpenGitDiff: (selection: DiffSelection) => void;
  onOpenExternal: (url: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [collapsed, setCollapsed] = useState(false);

  const running = items.some((item) => item.status === "running");
  const failedCount = items.filter((item) => item.status === "failed").length;
  const doneCount = items.filter((item) => item.status === "completed").length;
  const state = running ? "running" : failedCount > 0 ? "failed" : "completed";

  const signature = items.map((item) => `${item.id}:${item.status}`).join("|");

  useEffect(() => {
    if (collapsed || !stickToBottom.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [signature, collapsed]);

  const stepLabel = `${items.length} ${items.length === 1 ? "Schritt" : "Schritte"}`;
  const summary = [
    stepLabel,
    doneCount > 0 ? `${doneCount} fertig` : null,
    failedCount > 0 ? `${failedCount} fehlgeschlagen` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className={`tool-run tool-run--${state}`}>
      <header className="tool-run-header">
        <span className="tool-run-icon">
          {running ? (
            <span className="mini-spinner" />
          ) : failedCount > 0 ? (
            <Icon name="warning" size={15} />
          ) : (
            <Icon name="check" size={15} />
          )}
        </span>
        <div>
          <strong>{running ? "Gemini arbeitet …" : "Arbeitsschritte"}</strong>
          <small>{summary}</small>
        </div>
        <button
          type="button"
          className="tool-run-toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? "Anzeigen" : "Ausblenden"}
          <Icon
            name="chevron-down"
            size={13}
            className={collapsed ? "" : "tool-run-chevron--open"}
          />
        </button>
      </header>

      {!collapsed && (
        <div
          className="tool-run-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
        >
          {items.map((item) => {
            const previewGroup = gitPreviewGroups.get(item.toolCallId);
            return (
              <div className="tool-run-step" key={item.id}>
                <ToolCard item={item} onOpenExternal={onOpenExternal} />
                {previewGroup && (
                  <InlineDiffPreviews group={previewGroup} onOpenDiff={onOpenGitDiff} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AssistantMessage({
  item,
  onOpenExternal,
}: {
  item: MessageItem;
  onOpenExternal: (url: string) => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const isPlanOrMarkdown =
    item.text.includes("#") ||
    item.text.includes("```") ||
    item.text.includes("- [ ]") ||
    item.text.includes("- [x]") ||
    item.text.length > 250;

  return (
    <article className="message message--assistant">
      <div className="assistant-mark">
        <Icon name="sparkle" size={15} />
      </div>
      <div className="assistant-content">
        {isPlanOrMarkdown && !item.streaming && (
          <button
            type="button"
            className="message-raw-toggle"
            onClick={() => setShowRaw((v) => !v)}
            title={showRaw ? "Formatiertes Markdown anzeigen" : "Raw Markdown anzeigen"}
          >
            <Icon name={showRaw ? "sparkle" : "file-text"} size={12} />
            <span>{showRaw ? "Formatiert" : "Raw"}</span>
          </button>
        )}
        {!showRaw ? (
          <MarkdownContent onOpenExternal={onOpenExternal}>{item.text}</MarkdownContent>
        ) : (
          <pre className="message-raw-content">{item.text}</pre>
        )}
        {item.streaming && <span className="stream-cursor" aria-label="Gemini schreibt" />}
      </div>
    </article>
  );
}

function PermissionCard({
  item,
  onRespond,
}: {
  item: PermissionItem;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  const settled = !["pending", "error"].includes(item.status);
  const statusText =
    item.status === "allowed"
      ? "Erlaubt"
      : item.status === "rejected"
        ? "Abgelehnt"
        : item.status === "cancelled"
          ? "Abgebrochen"
          : item.status === "submitting"
            ? "Wird gesendet …"
            : item.status === "error"
              ? "Antwort fehlgeschlagen – erneut versuchen"
              : null;

  const choose = (optionId: string, kind?: string | null) => {
    if (kind === "allow_always") {
      onRespond(item.requestId, optionId);
    } else {
      onRespond(item.requestId, optionId);
    }
  };

  const options = item.options.length
    ? item.options
    : [
        { optionId: "allow_once", label: "Einmal erlauben", kind: "allow_once" as const },
        { optionId: "allow_always", label: "Immer erlauben", kind: "allow_always" as const },
        { optionId: "reject_once", label: "Ablehnen", kind: "reject_once" as const },
      ];

  return (
    <section
      className={`permission-card permission-card--${item.status}`}
      aria-label={`Freigabe: ${item.title}`}
    >
      <div className="permission-header">
        <span className="permission-badge">
          <Icon name="shield" size={16} />
        </span>
        <div>
          <small>Freigabe erforderlich</small>
          <h3>{item.title}</h3>
        </div>
      </div>
      {item.description && <p className="permission-description">{item.description}</p>}
      {item.details !== undefined && (
        <pre className="permission-details">{formatPayload(item.details)}</pre>
      )}
      {statusText && settled ? (
        <div className={`permission-result permission-result--${item.status}`}>
          <Icon name={item.status === "allowed" ? "check" : "x"} size={15} />
          {statusText}
        </div>
      ) : (
        <div className="permission-actions">
          {options.map((option) => {
            const isReject = option.kind?.startsWith("reject");
            const isAlways = option.kind?.endsWith("always");
            return (
              <button
                type="button"
                className={`permission-button ${isReject ? "permission-button--reject" : "permission-button--allow"} ${isAlways ? "permission-button--always" : ""}`}
                disabled={item.status === "submitting"}
                onClick={() => choose(option.optionId, option.kind)}
                key={option.optionId}
              >
                {item.status === "submitting" && item.selectedOptionId === option.optionId ? (
                  <span className="mini-spinner" />
                ) : null}
                {option.label}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TimelineEntry({
  item,
  gitPreviewGroup,
  onOpenExternal,
  onOpenGitDiff,
  onRespondToPermission,
}: {
  item: TimelineItem;
  gitPreviewGroup?: GitPreviewGroup;
  onOpenExternal: (url: string) => void;
  onOpenGitDiff: (selection: DiffSelection) => void;
  onRespondToPermission: (requestId: string, optionId: string) => void;
}) {
  if (item.kind === "message" && item.role === "user") {
    return (
      <article className={`message message--user ${item.failed ? "message--failed" : ""}`}>
        {item.attachments.length > 0 && (
          <div className="sent-attachments">
            {item.attachments.map((attachment) => (
              <span className="sent-attachment" key={attachment.id}>
                <Icon name="image" size={14} />
                {attachment.name}
              </span>
            ))}
          </div>
        )}
        {item.contextAttachments.length > 0 && (
          <div className="sent-context-attachments" aria-label="Verwendeter Anhangskontext">
            {item.contextAttachments.map((attachment) => (
              <span className="sent-context-attachment" key={attachment.id}>
                <Icon name={attachment.kind === "link" ? "link" : "file-text"} size={13} />
                {attachment.title}
              </span>
            ))}
          </div>
        )}
        {item.projectFiles && item.projectFiles.length > 0 && (
          <div className="sent-project-files" aria-label="Referenzierte Projektdateien">
            {item.projectFiles.map((file) => (
              <span
                className="sent-project-file"
                key={`${file.rootId}:${file.relativePath}`}
                title={`${file.rootLabel ? `${file.rootLabel}/` : ""}${file.relativePath}`}
              >
                <Icon name="file-text" size={13} />
                <span>{file.displayName ?? file.relativePath.split("/").pop() ?? file.relativePath}</span>
              </span>
            ))}
          </div>
        )}
        {item.externalContexts && item.externalContexts.length > 0 && (
          <div className="sent-context-attachments" aria-label="Verwendeter GitLab-Kontext">
            {item.externalContexts.map((ctx) => (
              <span className="sent-context-attachment sent-context-attachment--gitlab" key={ctx.id}>
                <Icon name="gitlab" size={13} />
                <span>{ctx.title} {ctx.filePath ? `(${ctx.filePath}${ctx.startLine ? `:${ctx.startLine}` : ""})` : ""}</span>
              </span>
            ))}
          </div>
        )}
        {item.text && <p>{item.text}</p>}
        {item.failed && <span className="message-error-label">Nicht gesendet</span>}
      </article>
    );
  }

  if (item.kind === "message") {
    return <AssistantMessage item={item} onOpenExternal={onOpenExternal} />;
  }

  if (item.kind === "thought") {
    return (
      <details className="thought-card" open={item.streaming}>
        <summary>
          <Icon name="brain" size={16} />
          <span>{item.streaming ? "Gemini denkt …" : "Gedankengang"}</span>
          {item.streaming && <span className="thinking-dots"><i /><i /><i /></span>}
          <Icon name="chevron-down" size={14} className="details-chevron" />
        </summary>
        <div className="thought-content">{item.text}</div>
      </details>
    );
  }

  if (item.kind === "tool") {
    return (
      <>
        <ToolCard item={item} onOpenExternal={onOpenExternal} />
        {gitPreviewGroup && (
          <InlineDiffPreviews group={gitPreviewGroup} onOpenDiff={onOpenGitDiff} />
        )}
      </>
    );
  }
  if (item.kind === "permission") {
    return <PermissionCard item={item} onRespond={onRespondToPermission} />;
  }

  return (
    <div className={`timeline-notice timeline-notice--${item.tone}`}>
      <Icon name={item.tone === "error" ? "warning" : "clock"} size={14} />
      <span>{item.text}</span>
    </div>
  );
}

export function Timeline({
  items,
  sessionTitle,
  gitPreviewGroups,
  onOpenExternal,
  onOpenGitDiff,
  onRespondToPermission,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Aufeinanderfolgende Tool-Schritte werden zu einer Gruppe zusammengefasst.
  // Ein einzelner Schritt bleibt eine schlichte Karte — eine Box mit Kopfzeile
  // für genau einen Eintrag wäre mehr Rahmen als Inhalt.
  const rows = useMemo(() => {
    const result: Array<
      { kind: "single"; item: TimelineItem } | { kind: "group"; id: string; items: ToolItem[] }
    > = [];

    for (const item of items) {
      const last = result.at(-1);
      if (item.kind === "tool" && last?.kind === "group") {
        last.items.push(item);
        continue;
      }
      if (item.kind === "tool") {
        result.push({ kind: "group", id: `run:${item.id}`, items: [item] });
        continue;
      }
      result.push({ kind: "single", item });
    }

    return result;
  }, [items]);

  const contentSignature = items
    .map((item) =>
      item.kind === "message" || item.kind === "thought"
        ? item.text.length
        : item.kind === "tool"
          ? `${item.seq ?? 0}${item.status}`
          : item.seq ?? 0,
    )
    .join(":");
  const previewSignature = [...gitPreviewGroups.values()]
    .map((group) => `${group.toolCallId}:${group.loading}:${group.totalFiles}:${group.previews.length}`)
    .join(":");

  useEffect(() => {
    if (stickToBottom.current) {
      anchorRef.current?.scrollIntoView?.({ block: "end" });
    }
  }, [contentSignature, previewSignature]);

  if (items.length === 0) {
    return (
      <div className="timeline-scroll timeline-scroll--empty" ref={scrollRef}>
        <section className="chat-empty">
          <div className="chat-empty-mark"><Icon name="sparkle" size={27} /></div>
          <p className="eyebrow">Neue Session</p>
          <h2>Woran möchtest du arbeiten?</h2>
          <p>
            Gemini kann den Kontext aller freigegebenen Projektordner nutzen. Beschreibe eine Aufgabe
            oder hänge ein Bild an.
          </p>
          <div className="prompt-suggestions" aria-label="Prompt-Vorschläge">
            <span>Projektstruktur erklären</span>
            <span>Fehler analysieren</span>
            <span>Änderung planen</span>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div
      className="timeline-scroll"
      ref={scrollRef}
      aria-label={`Verlauf von ${sessionTitle}`}
      onScroll={(event) => {
        const element = event.currentTarget;
        stickToBottom.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 140;
      }}
    >
      <div className="timeline">
        {rows.map((row) => {
          if (row.kind === "group") {
            if (row.items.length === 1) {
              const only = row.items[0]!;
              return (
                <TimelineEntry
                  key={only.id}
                  item={only}
                  gitPreviewGroup={gitPreviewGroups.get(only.toolCallId)}
                  onOpenExternal={onOpenExternal}
                  onOpenGitDiff={onOpenGitDiff}
                  onRespondToPermission={onRespondToPermission}
                />
              );
            }
            return (
              <ToolRunGroup
                key={row.id}
                items={row.items}
                gitPreviewGroups={gitPreviewGroups}
                onOpenGitDiff={onOpenGitDiff}
                onOpenExternal={onOpenExternal}
              />
            );
          }

          return (
            <TimelineEntry
              key={row.item.id}
              item={row.item}
              onOpenExternal={onOpenExternal}
              onOpenGitDiff={onOpenGitDiff}
              onRespondToPermission={onRespondToPermission}
            />
          );
        })}
        <div ref={anchorRef} className="scroll-anchor" />
      </div>
    </div>
  );
}
