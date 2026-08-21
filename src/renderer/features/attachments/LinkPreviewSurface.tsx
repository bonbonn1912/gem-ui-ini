import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { Icon } from "../../components/Icon";

type LinkPreviewSurfaceProps = {
  attachmentId: string;
  host: string;
  url: string;
  onOpenExternal: (url: string) => void;
  onClose: () => void;
};

export function LinkPreviewSurface({
  attachmentId,
  host,
  url,
  onOpenExternal,
  onClose,
}: LinkPreviewSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      await window.gemUi.linkPreview.open({ attachmentId });
      scheduleBounds();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Die Live-Ansicht konnte nicht geladen werden.");
    } finally {
      setLoading(false);
    }
  }, [attachmentId, scheduleBounds]);

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
    <section className="link-live-preview">
      <header>
        <span><Icon name="globe" size={14} />{host}</span>
        {loading && <span className="mini-spinner" aria-label="Seite wird geladen" />}
        <button type="button" onClick={() => void open()} aria-label="Live-Ansicht neu laden" title="Neu laden"><Icon name="refresh" size={14} /></button>
        <button type="button" onClick={() => onOpenExternal(url)} aria-label="Im Browser öffnen" title="Im Browser öffnen"><Icon name="external" size={14} /></button>
        <button type="button" onClick={onClose} aria-label="Live-Ansicht schließen" title="Schließen"><Icon name="x" size={14} /></button>
      </header>
      {error && <p className="link-live-error"><Icon name="warning" size={14} />{error}</p>}
      <div ref={surfaceRef} className="link-preview-surface" aria-label={`Live-Ansicht von ${host}`}>
        <span>Die sichere Live-Ansicht von {host} wird hier eingebettet.</span>
      </div>
    </section>
  );
}
