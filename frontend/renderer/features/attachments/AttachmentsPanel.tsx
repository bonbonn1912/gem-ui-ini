import { createEffect, createMemo, createSignal,  } from "solid-js";

import { Icon } from "../../components/Icon";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
import type { AppProject, ContextAttachment, ContextAttachmentList } from "../../types";
import { createClientRequestId } from "../../utils/client-request-id";
import { nativeFileDrop } from "../../native-file-drop";
import { AddLinkDialog } from "./AddLinkDialog";
import { AttachmentDetail } from "./AttachmentDetail";
import { AttachmentRow } from "./AttachmentRow";
import { LinkPreviewHeightHandle } from "./LinkPreviewSurface";

type AttachmentScope = "project" | "session";
type OriginFilter = "all" | "chat" | "manual";

const ORIGIN_FILTERS: Array<{ id: OriginFilter; label: string }> = [
  { id: "all", label: "Alle" },
  { id: "chat", label: "Aus dem Chat" },
  { id: "manual", label: "Manuell" },
];

const DEFAULT_DETAIL_HEIGHT = 520;

type AttachmentsPanelProps = {
  open: boolean;
  project: AppProject;
  sessionId: string | null;
  list: ContextAttachmentList | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onApply: (list: ContextAttachmentList) => void;
  onError: (error: unknown) => void;
  onOpenExternal: (url: string) => void;
};

function target(projectId: string, sessionId: string | null, scope: AttachmentScope) {
  return {
    projectId,
    scope,
    sessionId: scope === "session" ? sessionId : null,
  } as const;
}

function GroupCheck({
  label,
  attachments,
  disabled,
  onChange,
}: {
  label: string;
  attachments: ContextAttachment[];
  disabled: boolean;
  onChange: (included: boolean) => void;
}) {
  const selectable = attachments.filter((attachment) => attachment.file?.extractionState !== "failed");
  const included = selectable.filter((attachment) => attachment.includedInContext).length;
  const checked: boolean | "mixed" = included === 0 ? false : included === selectable.length ? true : "mixed";
  return (
    <button
      class="attachment-group-check"
      type="button"
      role="checkbox"
      aria-label={`${label}: alle im Kontext`}
      aria-checked={checked}
      disabled={disabled || selectable.length === 0}
      title={disabled ? "Die Kontextauswahl gilt pro Session." : `${label}: alle im Kontext`}
      onClick={() => onChange(checked !== true)}
    >
      <span>{checked === true ? <Icon name="check" size={12} /> : checked === "mixed" ? "−" : ""}</span>
      Alle im Kontext
    </button>
  );
}

export function AttachmentsPanel(props: AttachmentsPanelProps) {
  const menuRef = useDismissOnOutsideClick<HTMLDetailsElement>();
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [linkScope, setLinkScope] = createSignal<AttachmentScope | null>(null);
  const [dragScope, setDragScope] = createSignal<AttachmentScope | null>(null);
  const [isLive, setIsLive] = createSignal(false);
  const [previewHeight, setPreviewHeight] = createSignal<number>(480);
  const [detailHeight, setDetailHeight] = createSignal<number>(DEFAULT_DETAIL_HEIGHT);
  const [originFilter, setOriginFilter] = createSignal<OriginFilter>("all");

  const all = createMemo(() => props.list ? [...props.list.projectAttachments, ...props.list.sessionAttachments] : []);
  const selected = createMemo(() => all().find((attachment) => attachment.id === selectedId()) ?? null);

  createEffect(() => {
    if (!props.open) {
      setSelectedId(null);
      setLinkScope(null);
      setIsLive(false);
      void window.gemUi.linkPreview.close();
    }
  });

  createEffect(() => {
    setIsLive(false);
  });

  createEffect(() => {
    if (selectedId() && !all().some((attachment) => attachment.id === selectedId())) setSelectedId(null);
  });

  const run = async (operation: () => Promise<ContextAttachmentList>) => {
    try {
      const next = await operation();
      if (next.sessionId === props.sessionId) props.onApply(next);
      else await props.onRefresh();
      return next;
    } catch (reason) {
      props.onError(reason);
      throw reason;
    }
  };

  const addFiles = (scope: AttachmentScope) => run(() => window.gemUi.contextAttachments.addFiles({
    ...target(props.project.id, props.sessionId, scope),
    paths: [],
    clientRequestId: createClientRequestId(),
  }));

  const addDroppedFiles = (files: File[], scope: AttachmentScope) => {
    if (!files.length) return Promise.resolve();
    return run(() => window.gemUi.contextAttachments.addDroppedFiles(files, target(props.project.id, props.sessionId, scope)));
  };

  const addLink = (scope: AttachmentScope, url: string, title?: string) => run(() => window.gemUi.contextAttachments.addLink({
    ...target(props.project.id, props.sessionId, scope),
    url,
    ...(title ? { title } : {}),
    clientRequestId: createClientRequestId(),
  }));

  const update = (attachment: ContextAttachment, patch: {
    title?: string;
    note?: string | null;
    scope?: AttachmentScope;
    sessionId?: string | null;
  }) => run(() =>
    window.gemUi.contextAttachments.update({
      ...patch,
      attachmentId: attachment.id,
      clientRequestId: createClientRequestId(),
    }),
  );

  const setInclusion = (attachmentIds: string[], included: boolean) => {
    if (!props.sessionId) return Promise.resolve();
    return run(() => window.gemUi.contextAttachments.setInclusion({
      sessionId: props.sessionId,
      attachmentIds,
      included,
      clientRequestId: createClientRequestId(),
    }));
  };

  const onDrop = (event: DragEvent, scope: AttachmentScope) => {
    event.preventDefault();
    event.stopPropagation();
    setDragScope(null);
    void addDroppedFiles(Array.from(event.dataTransfer.files), scope);
  };

  const onPaste = (event: ClipboardEvent) => {
    if (!props.open) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    const scope: AttachmentScope = dragScope() ?? (props.sessionId ? "session" : "project");
    const text = event.clipboardData.getData("text/plain").trim();
    if (/^https:\/\//i.test(text)) {
      event.preventDefault();
      void addLink(scope, text);
      return;
    }
    const files = Array.from(event.clipboardData.files) as File[];
    if (files.length) {
      event.preventDefault();
      void addDroppedFiles(files, scope);
    }
  };

  const renderGroup = (scope: AttachmentScope, title: string, all: ContextAttachment[]) => {
    // Session-Anhänge lassen sich nach Herkunft filtern: automatisch aus dem
    // Chat übernommen oder von Hand im Panel hinzugefügt.
    const filtered =
      scope === "session" && originFilter() !== "all"
        ? all.filter((attachment) => attachment.origin === originFilter())
        : all;
    const chatCount = all.filter((attachment) => attachment.origin === "chat").length;
    const counts: Record<OriginFilter, number> = {
      all: all.length,
      chat: chatCount,
      manual: all.length - chatCount,
    };

    return (
    <section
      class={`attachment-group ${dragScope() === scope ? "attachment-group--drag" : ""}`}
      use:nativeFileDrop={{
        disabled: !props.open,
        onActiveChange: (active) => setDragScope(active ? scope : null),
        onDrop: (files) => void addDroppedFiles(files, scope),
      }}
      onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); setDragScope(scope); }}
      onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(event) => {
        event.stopPropagation();
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragScope(null);
      }}
      onDrop={(event) => onDrop(event, scope)}

    >
      <header>
        <div><strong>{title}</strong><span>{all.length}</span></div>
        <GroupCheck
          label={title}
          attachments={filtered}
          disabled={!props.sessionId}
          onChange={(included) => void setInclusion(filtered.map(({ id }) => id), included)}
        />
      </header>
      {scope === "session" && (
        <div class="attachment-origin-tabs" role="tablist" aria-label="Anhänge nach Herkunft filtern">
          {ORIGIN_FILTERS.map((filter) => (
            <button

              type="button"
              role="tab"
              aria-selected={originFilter() === filter.id}
              class={`attachment-origin-tab ${originFilter() === filter.id ? "attachment-origin-tab--active" : ""}`}
              onClick={() => setOriginFilter(filter.id)}
            >
              {filter.label}
              <i>{counts[filter.id]}</i>
            </button>
          ))}
        </div>
      )}
      {filtered.length ? (
        <div class="context-attachment-list">
          {filtered.map((attachment) => (
            <AttachmentRow

              attachment={attachment}
              sessionId={props.sessionId}
              selected={selectedId() === attachment.id}
              onSelect={() => setSelectedId(attachment.id)}
              onToggle={(item, included) => setInclusion([item.id], included).then(() => undefined)}
              onUpdate={(item, patch) => update(item, patch).then(() => undefined)}
              onRemove={(item) => run(() => window.gemUi.contextAttachments.remove({ attachmentId: item.id, clientRequestId: createClientRequestId() })).then(() => undefined)}
              onRefresh={(item) => run(() => window.gemUi.contextAttachments.refreshLinkPreview({ attachmentId: item.id, clientRequestId: createClientRequestId() })).then(() => undefined)}
              onOpenExternal={props.onOpenExternal}
              onOpenFile={(attachmentId) => window.gemUi.contextAttachments.openFile({ attachmentId }).then(() => undefined)}
            />
          ))}
        </div>
      ) : (
        <p class="attachment-group-empty">
          {scope === "session" && originFilter() === "chat"
              ? "Noch nichts aus dem Chat angehängt"
            : scope === "session" && originFilter() === "manual"
              ? "Noch nichts manuell hinzugefügt"
              : "Dateien hier ablegen"}
        </p>
      )}
    </section>
    );
  };

  return (
    <aside
      class={`attachments-panel ${props.open ? "attachments-panel--open" : ""}`}
      use:nativeFileDrop={{
        disabled: !props.open,
        onActiveChange: (active) => setDragScope(active ? (props.sessionId ? "session" : "project") : null),
        onDrop: (files) => void addDroppedFiles(files, dragScope() ?? (props.sessionId ? "session" : "project")),
      }}
      aria-label="Anhänge"
      aria-hidden={!props.open}
      onPaste={onPaste}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dragScope()) setDragScope(props.sessionId ? "session" : "project");
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragScope(null);
      }}
      onDrop={(event) => onDrop(event, dragScope() ?? (props.sessionId ? "session" : "project"))}
      tabIndex={props.open ? 0 : -1}
    >
      <header class="attachments-panel-header" data-tauri-drag-region>
        <div>
          <span class="attachments-panel-icon"><Icon name="paperclip" size={17} /></span>
          <div>
            <strong>Anhänge</strong>
            <span>{all().length} Anhänge · {props.list?.includedCount ?? 0} im Kontext · ~{(props.list?.estimatedTotalTokens ?? 0).toLocaleString("de-DE")} Token</span>
          </div>
        </div>
        <details ref={menuRef} class="attachments-add-menu">
          <summary aria-label="Anhang hinzufügen"><Icon name="plus" size={17} /></summary>
          <div>
            <strong>Zum Projekt</strong>
            <button type="button" onClick={() => void addFiles("project")}><Icon name="file-text" size={14} />Dateien wählen</button>
            <button type="button" onClick={() => setLinkScope("project")}><Icon name="link" size={14} />Link hinzufügen</button>
            {props.sessionId && <><strong>Zu dieser Session</strong><button type="button" onClick={() => void addFiles("session")}><Icon name="file-text" size={14} />Dateien wählen</button><button type="button" onClick={() => setLinkScope("session")}><Icon name="link" size={14} />Link hinzufügen</button></>}
            <button class="preview-storage-clear" type="button" onClick={() => void window.gemUi.linkPreview.clearStorage({ clientRequestId: createClientRequestId() }).catch(props.onError)}>Angemeldete Sitzungen löschen</button>
          </div>
        </details>
        <button class="icon-button" type="button" disabled={props.refreshing} onClick={() => void props.onRefresh()} aria-label="Anhänge aktualisieren">{props.refreshing ? <span class="mini-spinner" /> : <Icon name="refresh" size={16} />}</button>
        <button class="icon-button" type="button" onClick={props.onClose} aria-pressed={true} aria-label={`Anhänge schließen, ${all().length} Anhänge, ${props.list?.includedCount ?? 0} im Kontext`}><Icon name="x" size={17} /></button>
      </header>

      <div
        class={`attachments-panel-body ${selected() ? "attachments-panel-body--detail" : ""} ${isLive() ? "attachments-panel-body--live" : ""}`}
        style={
          selected() && !isLive()
            ? { "grid-template-rows": `minmax(120px, 1fr) auto minmax(0, ${detailHeight()}px)` }
            : undefined
        }
      >
        {isLive() && selected()?.link ? (
          <div
            class="attachments-live-dropdown-bar"
            onClick={() => {
              setIsLive(false);
              void window.gemUi.linkPreview.close();
            }}
            role="button"
            tabIndex={0}
            aria-label="Live-Ansicht einklappen und alle Anhänge anzeigen"
            title="Klicken, um die Live-Ansicht zu schließen und alle Anhänge wieder anzuzeigen"
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setIsLive(false);
                void window.gemUi.linkPreview.close();
              }
            }}
          >
            <div class="dropdown-bar-main">
              <span class="dropdown-bar-chevron"><Icon name="chevron-down" size={16} /></span>
              <span class="dropdown-bar-icon"><Icon name="globe" size={15} /></span>
              <div class="dropdown-bar-titles">
                <strong>Live-Ansicht: {selected()!.link!.host}</strong>
                <span>Klicken, um alle Anhänge wieder anzuzeigen</span>
              </div>
            </div>
            <div class="dropdown-bar-actions" onClick={(event) => event.stopPropagation()}>
              <button
                class="dropdown-bar-action"
                type="button"
                onClick={() => props.onOpenExternal(selected()!.link!.url)}
                title="Im Browser öffnen"
                aria-label="Im Browser öffnen"
              >
                <Icon name="external" size={14} />
              </button>
              <button
                class="dropdown-bar-close"
                type="button"
                onClick={() => {
                  setIsLive(false);
                  void window.gemUi.linkPreview.close();
                }}
                title="Live-Ansicht schließen und alle Anhänge anzeigen"
                aria-label="Live-Ansicht schließen"
              >
                <Icon name="x" size={15} />
              </button>
            </div>
          </div>
        ) : (
          <div class="attachments-list-pane">
            {props.loading && !props.list ? <div class="attachments-loading"><span class="mini-spinner" />Anhänge werden geladen …</div> : null}
            {props.error && <div class="attachments-error"><Icon name="warning" size={17} /><p><strong>Anhänge konnten nicht geladen werden</strong><span>{props.error}</span></p><button type="button" onClick={() => void props.onRefresh()}>Erneut</button></div>}
            {!props.loading && !props.error && props.list && all().length === 0 && (
              <div class="attachments-empty">
                <span><Icon name="paperclip" size={23} /></span>
                <strong>Noch keine Anhänge</strong>
                <p>Lege Dateien hier ab oder füge einen Link hinzu.</p>
                <div><button type="button" onClick={() => void addFiles("project")}><Icon name="file-text" size={14} />Dateien wählen</button><button type="button" onClick={() => setLinkScope("project")}><Icon name="link" size={14} />Link hinzufügen</button></div>
              </div>
            )}
            {props.list && all().length > 0 && (
              <>
                {renderGroup("project", "Projekt", props.list.projectAttachments)}
                {props.sessionId && renderGroup("session", "Diese Session", props.list.sessionAttachments)}
                {!props.sessionId && <p class="attachment-session-hint"><Icon name="clock" size={14} />Die Kontextauswahl wird verfügbar, sobald eine Session aktiv ist.</p>}
              </>
            )}
          </div>
        )}

        {isLive() && (
          <LinkPreviewHeightHandle
            height={previewHeight()}
            onChange={(nextHeight) => setPreviewHeight(nextHeight)}
            onReset={() => setPreviewHeight(480)}
          />
        )}

        {/* Detailbereich (inkl. Link-Vorschau) frei in der Höhe ziehbar */}
        {selected() && !isLive() && (
          <LinkPreviewHeightHandle
            height={detailHeight()}
            label="Höhe der Anhangsvorschau ändern"
            onChange={(nextHeight) => setDetailHeight(nextHeight)}
            onReset={() => setDetailHeight(DEFAULT_DETAIL_HEIGHT)}
          />
        )}

        <div class="attachments-detail-pane">
          {selected() && (
            <AttachmentDetail
              attachment={selected()!}
              onBack={() => {
                setIsLive(false);
                setSelectedId(null);
              }}
              onOpenExternal={props.onOpenExternal}
              onOpenFile={(attachmentId) => window.gemUi.contextAttachments.openFile({ attachmentId }).then(() => undefined)}
              live={isLive()}
              onLiveToggle={(live) => setIsLive(live)}
            />
          )}
        </div>
      </div>

      <AddLinkDialog
        open={linkScope() !== null}
        scopeLabel={linkScope() === "session" ? "Diese Session" : "Projekt"}
        onClose={() => setLinkScope(null)}
        onSubmit={(url, title) => addLink(linkScope() ?? "project", url, title).then(() => undefined)}
      />
    </aside>
  );
}
