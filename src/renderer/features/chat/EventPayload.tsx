import { useEffect, useState, type ReactNode } from "react";

type EventBlobReference = { $blob: string; bytes: number };
type EventPayloadProps = { sessionId: string; value: unknown };

function isBlobReference(value: unknown): value is EventBlobReference {
  return typeof value === "object" && value !== null && "$blob" in value
    && typeof (value as EventBlobReference).$blob === "string";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mimeType(value: Record<string, unknown>): string | null {
  const mime = value.mimeType ?? value.mime_type;
  return typeof mime === "string" ? mime : null;
}

function dataUrl(value: Record<string, unknown>, mime: string): string | null {
  const data = value.data ?? value.bytes;
  if (typeof data !== "string") return null;
  return data.startsWith("data:") ? data : `data:${mime};base64,${data}`;
}

function renderValue(value: unknown): ReactNode {
  if (Array.isArray(value)) {
    return <ul className="event-payload__blocks">{value.map((item, index) => <li key={index}>{renderValue(item)}</li>)}</ul>;
  }
  const item = record(value);
  if (item) {
    const mime = mimeType(item);
    if (mime?.startsWith("image/")) {
      const src = dataUrl(item, mime);
      if (src) return <img className="event-payload__image" src={src} alt={String(item.alt ?? "Agent-Medieninhalt")} loading="lazy" />;
    }
    if (mime?.startsWith("audio/")) {
      const src = dataUrl(item, mime);
      if (src) return <audio controls preload="none" src={src} />;
    }
    if (typeof item.text === "string" && (item.type === "resource" || item.type === "text")) {
      return <pre className="event-payload__text">{item.text}</pre>;
    }
    if (typeof item.oldText === "string" || typeof item.newText === "string") {
      return <div className="event-payload__diff">
        {typeof item.path === "string" && <strong>{item.path}</strong>}
        {typeof item.oldText === "string" && <pre><code>{item.oldText}</code></pre>}
        {typeof item.newText === "string" && <pre><code>{item.newText}</code></pre>}
      </div>;
    }
  }
  return <pre className="event-payload__json">{JSON.stringify(value, null, 2) ?? String(value)}</pre>;
}

/** Resolves an external event payload only while its expanded detail view is mounted. */
export function EventPayload({ sessionId, value }: EventPayloadProps) {
  const [resolved, setResolved] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setResolved(undefined);
    setError(null);
    const resolve = async (payload: unknown): Promise<unknown> => {
      if (isBlobReference(payload)) {
        const blob = await window.gemUi.sessions.getEventBlob({ sessionId, blobId: payload.$blob });
        return resolve(blob);
      }
      if (Array.isArray(payload)) return Promise.all(payload.map(resolve));
      const object = record(payload);
      if (object) {
        const entries = await Promise.all(Object.entries(object).map(async ([key, child]) => [key, await resolve(child)] as const));
        return Object.fromEntries(entries);
      }
      return payload;
    };
    void resolve(value).then((result) => {
      if (current) setResolved(result);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "Der Ereignisinhalt konnte nicht geladen werden.");
    });
    return () => { current = false; };
  }, [sessionId, value]);

  if (error) return <p className="event-payload__error">{error}</p>;
  if (resolved === undefined) return <p className="event-payload__loading">Lade Details …</p>;
  return <div className="event-payload">{renderValue(resolved)}</div>;
}
