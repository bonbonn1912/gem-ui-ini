import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { isInternalControlMessage, stripSessionContext, type MessageItem, type PermissionItem, type TimelineItem, type ToolItem } from "./reducer";
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

function ToolCard(props: { item: ToolItem; onOpenExternal?: (url: string) => void }) {
  const [showRaw, setShowRaw] = createSignal(false);
  const markdownPayload = createMemo(() => extractMarkdownPayload(props.item.input, props.item.output, props.item.locations));

  const statusLabel =
    props.item.status === "running"
      ? "Läuft"
      : props.item.status === "completed"
        ? "Abgeschlossen"
        : "Fehlgeschlagen";

  return (
    <details class={`tool-card tool-card--${props.item.status}`} open={props.item.status === "failed"}>
      <summary>
        <span class="tool-icon">
          {props.item.status === "completed" ? (
            <Icon name="check" size={16} />
          ) : props.item.status === "failed" ? (
            <Icon name="warning" size={16} />
          ) : (
            <Icon name="tool" size={16} />
          )}
        </span>
        <span class="tool-title">{props.item.title}</span>
        <span class={`tool-status tool-status--${props.item.status}`}>
          {props.item.status === "running" && <span class="mini-spinner" />}
          {statusLabel}
        </span>
        <Icon name="chevron-down" size={15} class="details-chevron" />
      </summary>
      <div class="tool-body">
        {props.item.locations?.length ? (
          <div class="tool-locations">
            {props.item.locations.map((location) => (
              <span >
                {location.path}
                {location.line ? `:${location.line}` : ""}
              </span>
            ))}
          </div>
        ) : null}

        {markdownPayload() && (
          <section class="tool-markdown-section">
            <div class="tool-section-header">
              <h4>Dokumentinhalt</h4>
              <button
                type="button"
                class="raw-toggle-btn"
                onClick={() => setShowRaw((v) => !v)}
                title={showRaw() ? "Formatiertes Markdown anzeigen" : "Raw Markdown anzeigen"}
              >
                <Icon name={showRaw() ? "sparkle" : "file-text"} size={13} />
                <span>{showRaw() ? "Formatiert" : "Raw"}</span>
              </button>
            </div>
            {!showRaw() ? (
              <div class="tool-markdown-container">
                <MarkdownContent onOpenExternal={props.onOpenExternal ?? ((url) => window.open(url, "_blank"))}>{markdownPayload()}</MarkdownContent>
              </div>
            ) : (
              <pre>{markdownPayload()}</pre>
            )}
          </section>
        )}

        {props.item.input !== undefined && !markdownPayload() && (
          <section>
            <h4>Eingabe</h4>
          <pre>{formatPayload(props.item.input)}</pre>
          </section>
        )}
        {props.item.diff && (
          <section>
            <h4>Änderung</h4>
            <pre class="diff-view">
              {props.item.diff.split("\n").map((line) => (
                <span
                  class={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : ""}

                >
                  {line || " "}
                  {"\n"}
                </span>
              ))}
            </pre>
          </section>
        )}
        {props.item.output !== undefined && !markdownPayload() && (
          <section>
            <h4>Ergebnis</h4>
          <pre>{formatPayload(props.item.output)}</pre>
          </section>
        )}
        {props.item.error && <p class="tool-error">{props.item.error}</p>}
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
function ToolRunGroup(props: {
  items: ToolItem[];
  gitPreviewGroups: ReadonlyMap<string, GitPreviewGroup>;
  onOpenGitDiff: (selection: DiffSelection) => void;
  onOpenExternal: (url: string) => void;
}) {
  let scrollRef!: HTMLDivElement;
  let stickToBottom = true;
  const [collapsed, setCollapsed] = createSignal(false);

  const running = props.items.some((item) => item.status === "running");
  const failedCount = props.items.filter((item) => item.status === "failed").length;
  const doneCount = props.items.filter((item) => item.status === "completed").length;
  const state = running ? "running" : failedCount > 0 ? "failed" : "completed";


  createEffect(() => {
    if (collapsed() || !stickToBottom) return;
    const element = scrollRef;
    if (element) element.scrollTop = element.scrollHeight;
  });

  const stepLabel = `${props.items.length} ${props.items.length === 1 ? "Schritt" : "Schritte"}`;
  const summary = [
    stepLabel,
    doneCount > 0 ? `${doneCount} fertig` : null,
    failedCount > 0 ? `${failedCount} fehlgeschlagen` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section class={`tool-run tool-run--${state}`}>
      <header class="tool-run-header">
        <span class="tool-run-icon">
          {running ? (
            <span class="mini-spinner" />
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
          class="tool-run-toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed()}
        >
          {collapsed() ? "Anzeigen" : "Ausblenden"}
          <Icon
            name="chevron-down"
            size={13}
            class={collapsed() ? "" : "tool-run-chevron--open"}
          />
        </button>
      </header>

      {!collapsed() && (
        <div
          class="tool-run-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          }}
        >
          {props.items.map((item) => {
            const previewGroup = props.gitPreviewGroups.get(item.toolCallId);
            return (
              <div class="tool-run-step" >
                <ToolCard item={item} onOpenExternal={props.onOpenExternal} />
                {previewGroup && (
                  <InlineDiffPreviews group={previewGroup} onOpenDiff={props.onOpenGitDiff} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AssistantMessage(props: {
  item: MessageItem;
  onOpenExternal: (url: string) => void;
}) {
  const [showRaw, setShowRaw] = createSignal(false);
  const isPlanOrMarkdown =
    props.item.text.includes("#") ||
    props.item.text.includes("```") ||
    props.item.text.includes("- [ ]") ||
    props.item.text.includes("- [x]") ||
    props.item.text.length > 250;

  return (
    <article class="message message--assistant">
      <div class="assistant-mark">
        <Icon name="sparkle" size={15} />
      </div>
      <div class="assistant-content">
        {isPlanOrMarkdown && !props.item.streaming && (
          <button
            type="button"
            class="message-raw-toggle"
            onClick={() => setShowRaw((v) => !v)}
            title={showRaw() ? "Formatiertes Markdown anzeigen" : "Raw Markdown anzeigen"}
          >
            <Icon name={showRaw() ? "sparkle" : "file-text"} size={12} />
            <span>{showRaw() ? "Formatiert" : "Raw"}</span>
          </button>
        )}
        {!showRaw() ? (
          <MarkdownContent onOpenExternal={props.onOpenExternal}>{stripSessionContext(props.item.text)}</MarkdownContent>
        ) : (
          <pre class="message-raw-content">{stripSessionContext(props.item.text)}</pre>
        )}
        {props.item.streaming && <span class="stream-cursor" aria-label="Gemini schreibt" />}
      </div>
    </article>
  );
}

function PermissionCard(props: {
  item: PermissionItem;
  onRespond: (requestId: string, optionId: string) => void;
}) {
  const settled = !["pending", "error"].includes(props.item.status);
  const statusText =
    props.item.status === "allowed"
      ? "Erlaubt"
      : props.item.status === "rejected"
        ? "Abgelehnt"
        : props.item.status === "cancelled"
          ? "Abgebrochen"
          : props.item.status === "submitting"
            ? "Wird gesendet …"
            : props.item.status === "error"
              ? "Antwort fehlgeschlagen – erneut versuchen"
              : null;

  const choose = (optionId: string, kind?: string | null) => {
    if (kind === "allow_always") {
      props.onRespond(props.item.requestId, optionId);
    } else {
      props.onRespond(props.item.requestId, optionId);
    }
  };

  const options = props.item.options.length
    ? props.item.options
    : [
        { optionId: "allow_once", label: "Einmal erlauben", kind: "allow_once" as const },
        { optionId: "allow_always", label: "Immer erlauben", kind: "allow_always" as const },
        { optionId: "reject_once", label: "Ablehnen", kind: "reject_once" as const },
      ];

  return (
    <section
      class={`permission-card permission-card--${props.item.status}`}
      aria-label={`Freigabe: ${props.item.title}`}
    >
      <div class="permission-header">
        <span class="permission-badge">
          <Icon name="shield" size={16} />
        </span>
        <div>
          <small>Freigabe erforderlich</small>
          <h3>{props.item.title}</h3>
        </div>
      </div>
      {props.item.description && <p class="permission-description">{props.item.description}</p>}
      {props.item.details !== undefined && (
        <pre class="permission-details">{formatPayload(props.item.details)}</pre>
      )}
      {statusText && settled ? (
        <div class={`permission-result permission-result--${props.item.status}`}>
          <Icon name={props.item.status === "allowed" ? "check" : "x"} size={15} />
          {statusText}
        </div>
      ) : (
        <div class="permission-actions">
          {options.map((option) => {
            const isReject = option.kind?.startsWith("reject");
            const isAlways = option.kind?.endsWith("always");
            return (
              <button
                type="button"
                class={`permission-button ${isReject ? "permission-button--reject" : "permission-button--allow"} ${isAlways ? "permission-button--always" : ""}`}
                disabled={props.item.status === "submitting"}
                onClick={() => choose(option.optionId, option.kind)}

              >
                {props.item.status === "submitting" && props.item.selectedOptionId === option.optionId ? (
                  <span class="mini-spinner" />
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

function TimelineEntry(props: {
  item: TimelineItem;
  gitPreviewGroup?: GitPreviewGroup;
  onOpenExternal: (url: string) => void;
  onOpenGitDiff: (selection: DiffSelection) => void;
  onRespondToPermission: (requestId: string, optionId: string) => void;
}) {
  if (props.item.kind === "message" && props.item.role === "user") {
    return (
      <article class={`message message--user ${props.item.failed ? "message--failed" : ""}`}>
        {props.item.attachments.length > 0 && (
          <div class="sent-attachments">
            {props.item.attachments.map((attachment) => (
              <span class="sent-attachment" >
                <Icon name="image" size={14} />
                {attachment.name}
              </span>
            ))}
          </div>
        )}
        {props.item.contextAttachments.length > 0 && (
          <div class="sent-context-attachments" aria-label="Verwendeter Anhangskontext">
            {props.item.contextAttachments.map((attachment) => (
              <span class="sent-context-attachment" >
                <Icon name={attachment.kind === "link" ? "link" : "file-text"} size={13} />
                {attachment.title}
              </span>
            ))}
          </div>
        )}
        {props.item.projectFiles && props.item.projectFiles.length > 0 && (
          <div class="sent-project-files" aria-label="Referenzierte Projektdateien">
            {props.item.projectFiles.map((file) => (
              <span
                class="sent-project-file"

                title={`${file.rootLabel ? `${file.rootLabel}/` : ""}${file.relativePath}`}
              >
                <Icon name="file-text" size={13} />
                <span>{file.displayName ?? file.relativePath.split("/").pop() ?? file.relativePath}</span>
              </span>
            ))}
          </div>
        )}
        {props.item.externalContexts && props.item.externalContexts.length > 0 && (
          <div class="sent-context-attachments" aria-label="Verwendeter GitLab-Kontext">
            {props.item.externalContexts.map((ctx) => (
              <span class="sent-context-attachment sent-context-attachment--gitlab" >
                <Icon name="gitlab" size={13} />
                <span>{ctx.title} {ctx.filePath ? `(${ctx.filePath}${ctx.startLine ? `:${ctx.startLine}` : ""})` : ""}</span>
              </span>
            ))}
          </div>
        )}
        {stripSessionContext(props.item.text) && <p>{stripSessionContext(props.item.text)}</p>}
        {props.item.failed && <span class="message-error-label">Nicht gesendet</span>}
      </article>
    );
  }

  if (props.item.kind === "message") {
    return <AssistantMessage item={props.item} onOpenExternal={props.onOpenExternal} />;
  }

  if (props.item.kind === "thought") {
    return (
      <details class="thought-card" open={props.item.streaming}>
        <summary>
          <Icon name="brain" size={16} />
          <span>{props.item.streaming ? "Gemini denkt …" : "Gedankengang"}</span>
          {props.item.streaming && <span class="thinking-dots"><i /><i /><i /></span>}
          <Icon name="chevron-down" size={14} class="details-chevron" />
        </summary>
        <div class="thought-content">{props.item.text}</div>
      </details>
    );
  }

  if (props.item.kind === "tool") {
    return (
      <>
        <ToolCard item={props.item} onOpenExternal={props.onOpenExternal} />
        {props.gitPreviewGroup && (
          <InlineDiffPreviews group={props.gitPreviewGroup} onOpenDiff={props.onOpenGitDiff} />
        )}
      </>
    );
  }
  if (props.item.kind === "permission") {
    return <PermissionCard item={props.item} onRespond={props.onRespondToPermission} />;
  }

  return (
    <div class={`timeline-notice timeline-notice--${props.item.tone}`}>
      <Icon name={props.item.tone === "error" ? "warning" : "clock"} size={14} />
      <span>{props.item.text}</span>
    </div>
  );
}

export function Timeline(props: TimelineProps) {
  let scrollRef!: HTMLDivElement;
  let anchorRef!: HTMLDivElement;
  const [stickToBottom, setStickToBottom] = createSignal(true);

  // Aufeinanderfolgende Tool-Schritte werden zu einer Gruppe zusammengefasst.
  // Ein einzelner Schritt bleibt eine schlichte Karte — eine Box mit Kopfzeile
  // für genau einen Eintrag wäre mehr Rahmen als Inhalt.
  const rows = createMemo(() => {
    const result: Array<
      { kind: "single"; item: TimelineItem } | { kind: "group"; id: string; items: ToolItem[] }
    > = [];

    for (const item of props.items) {
      if (item.kind === "message" && isInternalControlMessage(item.text)) {
        continue;
      }
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
  });

  const contentSignature = createMemo(() =>
    props.items
      .map((item) =>
        item.kind === "message" || item.kind === "thought"
          ? `${item.id}:${item.text.length}:${item.streaming ? 1 : 0}`
          : item.kind === "tool"
            ? `${item.id}:${item.seq ?? 0}:${item.status}`
            : `${item.id}:${item.seq ?? 0}`,
      )
      .join(";"),
  );

  createEffect(() => {
    contentSignature();
    if (stickToBottom() && scrollRef) {
      requestAnimationFrame(() => {
        if (scrollRef && stickToBottom()) {
          scrollRef.scrollTop = scrollRef.scrollHeight;
        }
      });
    }
  });

  return (
    <Show when={props.items.length > 0} fallback={
      <div class="timeline-scroll timeline-scroll--empty" ref={scrollRef}>
        <section class="chat-empty">
          <div class="chat-empty-mark"><Icon name="sparkle" size={27} /></div>
          <p class="eyebrow">Neue Session</p>
          <h2>Woran möchtest du arbeiten?</h2>
          <p>
            Gemini kann den Kontext aller freigegebenen Projektordner nutzen. Beschreibe eine Aufgabe
            oder hänge ein Bild an.
          </p>
          <div class="prompt-suggestions" aria-label="Prompt-Vorschläge">
            <span>Projektstruktur erklären</span>
            <span>Fehler analysieren</span>
            <span>Änderung planen</span>
          </div>
        </section>
      </div>
    }>
      <div
        class="timeline-scroll"
        ref={scrollRef}
        aria-label={`Verlauf von ${props.sessionTitle}`}
        onScroll={(event) => {
          const element = event.currentTarget;
          setStickToBottom(
            element.scrollHeight - element.scrollTop - element.clientHeight < 120,
          );
        }}
      >
        <div class="timeline">
          {rows().map((row) => {
          if (row.kind === "group") {
            if (row.items.length === 1) {
              const only = row.items[0]!;
              return (
                <TimelineEntry

                  item={only}
                  gitPreviewGroup={props.gitPreviewGroups.get(only.toolCallId)}
                  onOpenExternal={props.onOpenExternal}
                  onOpenGitDiff={props.onOpenGitDiff}
                  onRespondToPermission={props.onRespondToPermission}
                />
              );
            }
            return (
              <ToolRunGroup

                items={row.items}
                gitPreviewGroups={props.gitPreviewGroups}
                onOpenGitDiff={props.onOpenGitDiff}
                onOpenExternal={props.onOpenExternal}
              />
            );
          }

          return (
            <TimelineEntry

              item={row.item}
              onOpenExternal={props.onOpenExternal}
              onOpenGitDiff={props.onOpenGitDiff}
              onRespondToPermission={props.onRespondToPermission}
            />
          );
          })}
          <div ref={anchorRef} class="scroll-anchor" />
        </div>
      </div>
    </Show>
  );
}
