import { useEffect, useRef } from "react";
import type { PermissionItem, TimelineItem, ToolItem } from "./reducer";
import { MarkdownContent } from "../../components/MarkdownContent";
import { Icon } from "../../components/Icon";

type TimelineProps = {
  items: TimelineItem[];
  sessionTitle: string;
  onOpenExternal: (url: string) => void;
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

function ToolCard({ item }: { item: ToolItem }) {
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
        {item.input !== undefined && (
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
        {item.output !== undefined && (
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
      const confirmed = window.confirm(
        "Gemini diese Aktion dauerhaft erlauben? Diese Entscheidung gilt auch für spätere Aufrufe dieser Regel.",
      );
      if (!confirmed) return;
    }
    onRespond(item.requestId, optionId);
  };

  const options = [...item.options].sort((a, b) => {
    const order: Record<string, number> = { allow_once: 0, reject_once: 1, allow_always: 2, reject_always: 3 };
    return (order[a.kind ?? "allow_once"] ?? 4) - (order[b.kind ?? "allow_once"] ?? 4);
  });

  return (
    <section className={`permission-card permission-card--${item.status}`} aria-live="polite">
      <div className="permission-heading">
        <span className="permission-icon"><Icon name="shield" size={19} /></span>
        <div>
          <p className="eyebrow">Freigabe erforderlich</p>
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
  onOpenExternal,
  onRespondToPermission,
}: {
  item: TimelineItem;
  onOpenExternal: (url: string) => void;
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
        {item.text && <p>{item.text}</p>}
        {item.failed && <span className="message-error-label">Nicht gesendet</span>}
      </article>
    );
  }

  if (item.kind === "message") {
    return (
      <article className="message message--assistant">
        <div className="assistant-mark">
          <Icon name="sparkle" size={15} />
        </div>
        <div className="assistant-content">
          <MarkdownContent onOpenExternal={onOpenExternal}>{item.text}</MarkdownContent>
          {item.streaming && <span className="stream-cursor" aria-label="Gemini schreibt" />}
        </div>
      </article>
    );
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

  if (item.kind === "tool") return <ToolCard item={item} />;
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
  onOpenExternal,
  onRespondToPermission,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const contentSignature = items
    .map((item) => (item.kind === "message" || item.kind === "thought" ? item.text.length : item.seq ?? 0))
    .join(":");

  useEffect(() => {
    if (stickToBottom.current) {
      anchorRef.current?.scrollIntoView?.({ block: "end" });
    }
  }, [contentSignature]);

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
        {items.map((item) => (
          <TimelineEntry
            key={item.id}
            item={item}
            onOpenExternal={onOpenExternal}
            onRespondToPermission={onRespondToPermission}
          />
        ))}
        <div ref={anchorRef} className="scroll-anchor" />
      </div>
    </div>
  );
}
