import { useEffect, useRef, useState } from "react";
import type { GemUiDesktopApi } from "../../../shared/contracts";
import { validateElicitationContent, type ElicitationRequest, type RespondToElicitationInput } from "../../../shared/contracts/elicitation";
import "./elicitation.css";

type Content = NonNullable<RespondToElicitationInput["content"]>;

export function ElicitationDialog({ sessionId, api }: { sessionId: string; api: GemUiDesktopApi }) {
  const formRef = useRef<HTMLFormElement>(null);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const [request, setRequest] = useState<ElicitationRequest | null>(null);
  const [content, setContent] = useState<Content>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setRequest(null); setError(null); setBusy(false);
    const poll = async () => {
      try {
        if (document.hidden) return;
        const requests = await api.sessions.listElicitations({ sessionId });
        if (!disposed) setRequest((current) => current?.requestId === requests[0]?.requestId ? current : requests[0] ?? null);
      } catch { /* A session may close while a poll is pending. */ }
      finally { if (!disposed) timer = setTimeout(poll, 1_000); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sessionId, api]);
  useEffect(() => {
    const defaults: Content = Object.create(null) as Content;
    for (const [key, field] of Object.entries(request?.schema?.properties ?? {})) {
      if (field.default != null) defaults[key] = field.default;
      else if (field.type === "boolean") defaults[key] = false;
      else if (field.type === "array") defaults[key] = [];
    }
    setContent(defaults); setError(null);
  }, [request?.requestId]);
  useEffect(() => {
    if (!request) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    formRef.current?.querySelector<HTMLElement>("input, select, button")?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [request?.requestId]);
  if (!request || request.sessionId !== sessionId) return null;
  const respond = async (action: RespondToElicitationInput["action"]) => {
    const current = request;
    setBusy(true); setError(null);
    try {
      if (action === "accept") {
        validateElicitationContent(current, content);
        if (current.mode === "url" && current.url) await api.openExternalHttpsUrl(current.url);
      }
      await api.sessions.respondToElicitation({ sessionId, requestId: current.requestId, action,
        ...(action === "accept" && current.mode === "form" ? { content } : {}) });
      if (currentSession.current !== sessionId) return;
      setRequest((value) => value?.requestId === current.requestId ? null : value);
    } catch (failure) { if (currentSession.current === sessionId) setError(failure instanceof Error ? failure.message : "Antwort konnte nicht gesendet werden."); }
    finally { if (currentSession.current === sessionId) setBusy(false); }
  };
  return <div className="elicitation-overlay">
    <form ref={formRef} className="elicitation-dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) { event.preventDefault(); void respond("cancel"); }
        if (event.key !== "Tab") return;
        const elements = Array.from(formRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled)") ?? []);
        const first = elements[0]; const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }} role="dialog" aria-modal="true" aria-labelledby="elicitation-title"
      onSubmit={(event) => { event.preventDefault(); void respond("accept"); }}>
      <h2 id="elicitation-title">{request.schema?.title || "Gemini hat eine Rückfrage"}</h2>
      <p>{request.message}</p>
      {request.schema?.description && <p>{request.schema.description}</p>}
      {request.mode === "url" ? <p>Im Browser öffnen: <strong>{request.url ? new URL(request.url).hostname : ""}</strong></p> :
        Object.entries(request.schema?.properties ?? {}).map(([key, field]) => {
          const options = field.enum?.map((value) => ({ const: value, title: value })) ?? field.oneOf;
          const required = request.schema?.required?.includes(key);
          const id = `elicitation-${request.requestId}-${key}`;
          const change = (value: Content[string]) => setContent((previous) => ({ ...previous, [key]: value }));
          return <div className="elicitation-field" key={key}>
            <label htmlFor={id}>{field.title ?? key}{required ? " *" : ""}</label>
            {field.description && <small>{field.description}</small>}
            {field.type === "boolean" ? <input id={id} type="checkbox" checked={content[key] === true} onChange={(event) => change(event.target.checked)} /> :
              field.type === "array" ? <select id={id} multiple required={required} value={Array.isArray(content[key]) ? content[key] as string[] : []}
                onChange={(event) => change(Array.from(event.target.selectedOptions, (option) => option.value))}>
                {(field.items?.anyOf ?? field.items?.enum?.map((value) => ({ const: value, title: value })) ?? []).map((option) => <option key={option.const} value={option.const}>{option.title}</option>)}
              </select> : options ? <select id={id} required={required} value={String(content[key] ?? "")} onChange={(event) => change(event.target.value)}>
                <option value="">Bitte auswählen</option>{options.map((option) => <option key={option.const} value={option.const}>{option.title}</option>)}
              </select> : <input id={id} required={required} autoComplete="off"
                type={field.type === "number" || field.type === "integer" ? "number" : field.format === "email" ? "email" : field.format === "date" ? "date" : field.format === "uri" ? "url" : "text"}
                step={field.type === "integer" ? 1 : "any"} min={field.minimum ?? undefined} max={field.maximum ?? undefined}
                minLength={field.minLength ?? undefined} maxLength={Math.min(field.maxLength ?? 16_384, 16_384)}
                value={String(content[key] ?? "")} onChange={(event) => {
                  if (!event.target.value && (field.type === "integer" || field.type === "number")) {
                    setContent((previous) => { const next = { ...previous }; delete next[key]; return next; });
                  } else change(field.type === "integer" || field.type === "number" ? Number(event.target.value) : event.target.value);
                }} />}
          </div>;
        })}
      {error && <p role="alert">{error}</p>}
      <div className="elicitation-actions">
        <button type="button" disabled={busy} onClick={() => void respond("cancel")}>Abbrechen</button>
        <button type="button" disabled={busy} onClick={() => void respond("decline")}>Ablehnen</button>
        <button type="submit" disabled={busy}>{request.mode === "url" ? "Browser öffnen" : "Antwort senden"}</button>
      </div>
    </form>
  </div>;
}
