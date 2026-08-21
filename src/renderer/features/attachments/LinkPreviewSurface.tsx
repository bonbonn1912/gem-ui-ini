import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { Icon } from "../../components/Icon";

type LinkPreviewSurfaceProps = {
  attachmentId?: string;
  host?: string;
  url: string;
  onOpenExternal: (url: string) => void;
  onClose: () => void;
  height?: number;
  isExpanded?: boolean;
  showHeader?: boolean;
};

type LinkPreviewHeightHandleProps = {
  height: number;
  onChange: (nextHeight: number) => void;
  onReset: () => void;
  label?: string;
};

export function LinkPreviewHeightHandle({
  height,
  onChange,
  onReset,
  label = "Höhe der Live-Vorschau ändern",
}: LinkPreviewHeightHandleProps) {
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);

  return (
    <div
      className="live-preview-height-handle"
      role="separator"
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuenow={height}
      tabIndex={0}
      title={`${label} · Ziehen oder Pfeiltasten, Doppelklick setzt zurück`}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onChange(Math.max(200, height + 30));
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onChange(Math.max(200, height - 30));
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragRef.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight: height,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.classList.add("live-preview-height-handle--dragging");
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const active = dragRef.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const delta = active.startY - event.clientY;
        const next = Math.max(200, Math.min(1200, active.startHeight + delta));
        onChange(next);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.classList.remove("live-preview-height-handle--dragging");
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={(event) => {
        dragRef.current = null;
        event.currentTarget.classList.remove("live-preview-height-handle--dragging");
      }}
      onLostPointerCapture={(event) => {
        dragRef.current = null;
        event.currentTarget.classList.remove("live-preview-height-handle--dragging");
      }}
    />
  );
}

export function LinkPreviewSurface({
  attachmentId,
  host,
  url,
  onOpenExternal,
  onClose,
  height,
  isExpanded = false,
  showHeader = true,
}: LinkPreviewSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const displayHost = host || (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();

  const publishBounds = useCallback(() => {
    frameRef.current = null;
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const visible = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    void window.gemUi.linkPreview.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(Math.max(0, rect.width)),
      height: visible ? Math.round(Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0))) : 0,
    });
  }, []);

  const scheduleBounds = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(publishBounds);
  }, [publishBounds]);

  const open = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (attachmentId) {
        await window.gemUi.linkPreview.open({ attachmentId, url });
      } else {
        await window.gemUi.linkPreview.open({ url });
      }
      scheduleBounds();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Die Live-Ansicht konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, [attachmentId, url, scheduleBounds]);

  useLayoutEffect(() => {
    void open();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleBounds);
    if (surfaceRef.current) observer?.observe(surfaceRef.current);
    window.addEventListener("resize", scheduleBounds);
    window.addEventListener("scroll", scheduleBounds, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleBounds);
      window.removeEventListener("scroll", scheduleBounds, true);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      void window.gemUi.linkPreview.close();
    };
  }, [open, scheduleBounds]);

  return (
    <section className={`link-live-preview ${isExpanded ? "link-live-preview--expanded" : ""}`}>
      {showHeader && (
        <header>
          <span><Icon name="globe" size={14} />{displayHost}</span>
          {loading && <span className="mini-spinner" aria-label="Seite wird geladen" />}
          <button type="button" onClick={() => void open()} aria-label="Live-Ansicht neu laden" title="Neu laden"><Icon name="refresh" size={14} /></button>
          <button type="button" onClick={() => onOpenExternal(url)} aria-label="Im Browser öffnen" title="Im Browser öffnen"><Icon name="external" size={14} /></button>
          <button type="button" onClick={onClose} aria-label="Live-Ansicht schließen" title="Schließen"><Icon name="x" size={14} /></button>
        </header>
      )}
      {error && <p className="link-live-error"><Icon name="warning" size={14} />{error}</p>}
      <div
        ref={surfaceRef}
        className="link-preview-surface"
        aria-label={`Live-Ansicht von ${displayHost}`}
        style={height ? { height: `${height}px` } : undefined}
      >
        <span>Die sichere Live-Ansicht von {displayHost} wird hier eingebettet.</span>
      </div>
    </section>
  );
}
