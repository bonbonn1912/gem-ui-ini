import { useEffect, useMemo, useState, type ClipboardEvent, type DragEvent } from "react";

import type { JiraIssueAttachment } from "../../../shared/contracts";
import { Icon } from "../../components/Icon";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";
import type { AppProject, ContextAttachment, ContextAttachmentList } from "../../types";
import { createClientRequestId } from "../../utils/client-request-id";
import type { JiraSessionIssue } from "../jira/useJiraIssue";
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
  jiraIssue?: JiraSessionIssue | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onApply: (list: ContextAttachmentList) => void;
  onError: (error: unknown) => void;
  onOpenExternal: (url: string) => void;
};

function readableSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

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
      className="attachment-group-check"
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

export function AttachmentsPanel({
  open,
  project,
  sessionId,
  list,
  loading,
  refreshing,
  error,
  jiraIssue,
  onClose,
  onRefresh,
  onApply,
  onError,
  onOpenExternal,
}: AttachmentsPanelProps) {
  const menuRef = useDismissOnOutsideClick<HTMLDetailsElement>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [linkScope, setLinkScope] = useState<AttachmentScope | null>(null);
  const [dragScope, setDragScope] = useState<AttachmentScope | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [previewHeight, setPreviewHeight] = useState<number>(480);
  const [detailHeight, setDetailHeight] = useState<number>(DEFAULT_DETAIL_HEIGHT);
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
  const [syncingJiraId, setSyncingJiraId] = useState<string | null>(null);
  const [syncingAllJira, setSyncingAllJira] = useState(false);

  const all = useMemo(() => list ? [...list.projectAttachments, ...list.sessionAttachments] : [], [list]);
  const selected = all.find((attachment) => attachment.id === selectedId) ?? null;

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setLinkScope(null);
      setIsLive(false);
      void window.gemUi.linkPreview.close();
    }
  }, [open]);

  useEffect(() => {
    setIsLive(false);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId && !all.some((attachment) => attachment.id === selectedId)) setSelectedId(null);
  }, [all, selectedId]);

  const run = async (operation: () => Promise<ContextAttachmentList>) => {
    try {
      const next = await operation();
      if (next.sessionId === sessionId) onApply(next);
      else await onRefresh();
      return next;
    } catch (reason) {
      onError(reason);
      throw reason;
    }
  };

  const addFiles = (scope: AttachmentScope) => run(() => window.gemUi.contextAttachments.addFiles({
    ...target(project.id, sessionId, scope),
    paths: [],
    clientRequestId: createClientRequestId(),
  }));

  const addDroppedFiles = (files: File[], scope: AttachmentScope) => {
    if (!files.length) return Promise.resolve();
    return run(() => window.gemUi.contextAttachments.addDroppedFiles(files, target(project.id, sessionId, scope)));
  };

  const addLink = (scope: AttachmentScope, url: string, title?: string) => run(() => window.gemUi.contextAttachments.addLink({
    ...target(project.id, sessionId, scope),
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
    if (!sessionId) return Promise.resolve();
    return run(() => window.gemUi.contextAttachments.setInclusion({
      sessionId,
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

  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    if (!open) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
      return;
    }
    const scope: AttachmentScope = dragScope ?? (sessionId ? "session" : "project");
    const text = event.clipboardData.getData("text/plain").trim();
    if (/^https:\/\//i.test(text)) {
      event.preventDefault();
      void addLink(scope, text);
      return;
    }
    const files = Array.from(event.clipboardData.files);
    if (files.length) {
      event.preventDefault();
      void addDroppedFiles(files, scope);
    }
  };

  const syncJira = async (attachmentId?: string) => {
    if (!sessionId || !jiraIssue?.issueKey) return;
    if (attachmentId) setSyncingJiraId(attachmentId);
    else setSyncingAllJira(true);

    try {
      await window.gemUi.jira.syncAttachments({
        clientRequestId: createClientRequestId(),
        projectId: project.id,
        sessionId,
        issueKey: jiraIssue.issueKey,
        attachmentIds: attachmentId ? [attachmentId] : undefined,
      });
      await onRefresh();
    } catch (reason) {
      onError(reason);
    } finally {
      setSyncingJiraId(null);
      setSyncingAllJira(false);
    }
  };

  const renderJiraGroup = () => {
    if (!jiraIssue) return null;
    const jiraAttachments = jiraIssue.attachments || [];
    const sessionFiles = list?.sessionAttachments || [];

    const isSynced = (att: JiraIssueAttachment) =>
      sessionFiles.some(
        (sa) =>
          sa.file?.displayName === att.filename ||
          sa.title === `${jiraIssue.issueKey}: ${att.filename}` ||
          (sa.file?.size === att.size && sa.file?.displayName === att.filename),
      );

    const unsyncedCount = jiraAttachments.filter((att) => !isSynced(att)).length;

    return (
      <section className="attachment-group attachment-group--jira" key="jira">
        <header>
          <div>
            <span className="jira-icon-color"><Icon name="jira" size={14} /></span>
            <strong>Jira ({jiraIssue.issueKey})</strong>
            <span>{jiraAttachments.length}</span>
          </div>
          {jiraAttachments.length > 0 && sessionId && unsyncedCount > 0 && (
            <button
              type="button"
              className="jira-group-sync-all-btn"
              disabled={syncingAllJira || syncingJiraId !== null}
              onClick={() => void syncJira()}
              title="Alle noch nicht synchronisierten Anhänge in diese Session laden"
            >
              {syncingAllJira ? <span className="mini-spinner" /> : <Icon name="download" size={12} />}
              <span>{syncingAllJira ? "Synchronisiere …" : `Alle syncen (${unsyncedCount})`}</span>
            </button>
          )}
        </header>

        {jiraAttachments.length > 0 ? (
          <div className="context-attachment-list">
            {jiraAttachments.map((att) => {
              const synced = isSynced(att);
              const isSyncing = syncingJiraId === att.id || syncingAllJira;
              const isImage =
                /\.(png|jpe?g|gif|webp|svg)$/i.test(att.filename) ||
                att.mimeType?.startsWith("image/");
              const iconName = isImage ? "image" : "file-text";

              return (
                <div key={att.id} className="jira-attachment-row">
                  <span className="jira-attachment-icon">
                    <Icon name={iconName} size={15} />
                  </span>
                  <div className="jira-attachment-info">
                    <strong title={att.filename}>{att.filename}</strong>
                    <span className="jira-attachment-meta">
                      {readableSize(att.size)}
                      {att.created ? ` · ${formatDate(att.created)}` : ""}
                    </span>
                  </div>
                  <div className="jira-attachment-actions">
                    {synced ? (
                      <span
                        className="status-pill status-pill--active"
                        title="Bereits in den Session-Anhängen vorhanden"
                      >
                        <Icon name="check" size={11} /> In Session
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button jira-item-sync-btn"
                        disabled={isSyncing || !sessionId}
                        onClick={() => void syncJira(att.id)}
                        title="Diesen Anhang in die Session laden"
                      >
                        {syncingJiraId === att.id ? (
                          <span className="mini-spinner" />
                        ) : (
                          <Icon name="download" size={12} />
                        )}
                        <span>Syncen</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="attachment-group-empty">
            Keine Dateianhänge an {jiraIssue.issueKey} vorhanden
          </p>
        )}
      </section>
    );
  };

  const renderGroup = (scope: AttachmentScope, title: string, all: ContextAttachment[]) => {
    const filtered =
      scope === "session" && originFilter !== "all"
        ? all.filter((attachment) => attachment.origin === originFilter)
        : all;
    const chatCount = all.filter((attachment) => attachment.origin === "chat").length;
    const counts: Record<OriginFilter, number> = {
      all: all.length,
      chat: chatCount,
      manual: all.length - chatCount,
    };

    return (
      <section
        className={`attachment-group ${dragScope === scope ? "attachment-group--drag" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); setDragScope(scope); }}
        onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(event) => {
          event.stopPropagation();
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragScope(null);
        }}
        onDrop={(event) => onDrop(event, scope)}
        key={scope}
      >
        <header>
          <div><strong>{title}</strong><span>{all.length}</span></div>
          <GroupCheck
            label={title}
            attachments={filtered}
            disabled={!sessionId}
            onChange={(included) => void setInclusion(filtered.map(({ id }) => id), included)}
          />
        </header>
        {scope === "session" && (
          <div className="attachment-origin-tabs" role="tablist" aria-label="Anhänge nach Herkunft filtern">
            {ORIGIN_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                role="tab"
                aria-selected={originFilter === filter.id}
                className={`attachment-origin-tab ${originFilter === filter.id ? "attachment-origin-tab--active" : ""}`}
                onClick={() => setOriginFilter(filter.id)}
              >
                {filter.label}
                <i>{counts[filter.id]}</i>
              </button>
            ))}
          </div>
        )}
        {filtered.length ? (
          <div className="context-attachment-list">
            {filtered.map((attachment) => (
              <AttachmentRow
                key={attachment.id}
                attachment={attachment}
                sessionId={sessionId}
                selected={selectedId === attachment.id}
                onSelect={() => setSelectedId(attachment.id)}
                onToggle={(item, included) => setInclusion([item.id], included).then(() => undefined)}
                onUpdate={(item, patch) => update(item, patch).then(() => undefined)}
                onRemove={(item) => run(() => window.gemUi.contextAttachments.remove({ attachmentId: item.id, clientRequestId: createClientRequestId() })).then(() => undefined)}
                onRefresh={(item) => run(() => window.gemUi.contextAttachments.refreshLinkPreview({ attachmentId: item.id, clientRequestId: createClientRequestId() })).then(() => undefined)}
                onOpenExternal={onOpenExternal}
                onOpenFile={(attachmentId) => window.gemUi.contextAttachments.openFile({ attachmentId }).then(() => undefined)}
              />
            ))}
          </div>
        ) : (
          <p className="attachment-group-empty">
            {scope === "session" && originFilter === "chat"
              ? "Noch nichts aus dem Chat angehängt"
              : scope === "session" && originFilter === "manual"
                ? "Noch nichts manuell hinzugefügt"
                : "Dateien hier ablegen"}
          </p>
        )}
      </section>
    );
  };

  const hasAnyAttachments =
    (list && all.length > 0) || (jiraIssue && (jiraIssue.attachments?.length || 0) > 0);

  return (
    <aside
      className={`attachments-panel ${open ? "attachments-panel--open" : ""}`}
      aria-label="Anhänge"
      aria-hidden={!open}
      onPaste={onPaste}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dragScope) setDragScope(sessionId ? "session" : "project");
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragScope(null);
      }}
      onDrop={(event) => onDrop(event, dragScope ?? (sessionId ? "session" : "project"))}
      tabIndex={open ? 0 : -1}
    >
      <header className="attachments-panel-header">
        <div>
          <span className="attachments-panel-icon"><Icon name="paperclip" size={17} /></span>
          <div>
            <strong>Anhänge</strong>
            <span>{all.length} Anhänge · {list?.includedCount ?? 0} im Kontext · ~{(list?.estimatedTotalTokens ?? 0).toLocaleString("de-DE")} Token</span>
          </div>
        </div>
        <details ref={menuRef} className="attachments-add-menu">
          <summary aria-label="Anhang hinzufügen"><Icon name="plus" size={17} /></summary>
          <div>
            <strong>Zum Projekt</strong>
            <button type="button" onClick={() => void addFiles("project")}><Icon name="file-text" size={14} />Dateien wählen</button>
            <button type="button" onClick={() => setLinkScope("project")}><Icon name="link" size={14} />Link hinzufügen</button>
            {sessionId && <><strong>Zu dieser Session</strong><button type="button" onClick={() => void addFiles("session")}><Icon name="file-text" size={14} />Dateien wählen</button><button type="button" onClick={() => setLinkScope("session")}><Icon name="link" size={14} />Link hinzufügen</button></>}
            <button className="preview-storage-clear" type="button" onClick={() => void window.gemUi.linkPreview.clearStorage({ clientRequestId: createClientRequestId() }).catch(onError)}>Angemeldete Sitzungen löschen</button>
          </div>
        </details>
        <button className="icon-button" type="button" disabled={refreshing} onClick={() => void onRefresh()} aria-label="Anhänge aktualisieren">{refreshing ? <span className="mini-spinner" /> : <Icon name="refresh" size={16} />}</button>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Anhänge schließen"><Icon name="x" size={17} /></button>
      </header>

      <div
        className={`attachments-panel-body ${selected ? "attachments-panel-body--detail" : ""} ${isLive ? "attachments-panel-body--live" : ""}`}
        style={
          selected && !isLive
            ? { gridTemplateRows: `minmax(120px, 1fr) auto minmax(0, ${detailHeight}px)` }
            : undefined
        }
      >
        {isLive && selected?.link ? (
          <div
            className="attachments-live-dropdown-bar"
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
            <div className="dropdown-bar-main">
              <span className="dropdown-bar-chevron"><Icon name="chevron-down" size={16} /></span>
              <span className="dropdown-bar-icon"><Icon name="globe" size={15} /></span>
              <div className="dropdown-bar-titles">
                <strong>Live-Ansicht: {selected.link.host}</strong>
                <span>Klicken, um alle Anhänge wieder anzuzeigen</span>
              </div>
            </div>
            <div className="dropdown-bar-actions" onClick={(event) => event.stopPropagation()}>
              <button
                className="dropdown-bar-action"
                type="button"
                onClick={() => onOpenExternal(selected.link!.url)}
                title="Im Browser öffnen"
                aria-label="Im Browser öffnen"
              >
                <Icon name="external" size={14} />
              </button>
              <button
                className="dropdown-bar-close"
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
          <div className="attachments-list-pane">
            {loading && !list ? <div className="attachments-loading"><span className="mini-spinner" />Anhänge werden geladen …</div> : null}
            {error && <div className="attachments-error"><Icon name="warning" size={17} /><p><strong>Anhänge konnten nicht geladen werden</strong><span>{error}</span></p><button type="button" onClick={() => void onRefresh()}>Erneut</button></div>}
            {!loading && !error && list && !hasAnyAttachments && (
              <div className="attachments-empty">
                <span><Icon name="paperclip" size={23} /></span>
                <strong>Noch keine Anhänge</strong>
                <p>Lege Dateien hier ab oder füge einen Link hinzu.</p>
                <div><button type="button" onClick={() => void addFiles("project")}><Icon name="file-text" size={14} />Dateien wählen</button><button type="button" onClick={() => setLinkScope("project")}><Icon name="link" size={14} />Link hinzufügen</button></div>
              </div>
            )}
            {hasAnyAttachments && list && (
              <>
                {renderGroup("project", "Projekt", list.projectAttachments)}
                {sessionId && renderGroup("session", "Diese Session", list.sessionAttachments)}
                {jiraIssue && renderJiraGroup()}
                {!sessionId && !jiraIssue && <p className="attachment-session-hint"><Icon name="clock" size={14} />Die Kontextauswahl wird verfügbar, sobald eine Session aktiv ist.</p>}
              </>
            )}
          </div>
        )}

        {isLive && (
          <LinkPreviewHeightHandle
            height={previewHeight}
            onChange={(nextHeight) => setPreviewHeight(nextHeight)}
            onReset={() => setPreviewHeight(480)}
          />
        )}

        {/* Detailbereich (inkl. Link-Vorschau) frei in der Höhe ziehbar */}
        {selected && !isLive && (
          <LinkPreviewHeightHandle
            height={detailHeight}
            label="Höhe der Anhangsvorschau ändern"
            onChange={(nextHeight) => setDetailHeight(nextHeight)}
            onReset={() => setDetailHeight(DEFAULT_DETAIL_HEIGHT)}
          />
        )}

        <div className="attachments-detail-pane">
          {selected && (
            <AttachmentDetail
              attachment={selected}
              onBack={() => {
                setIsLive(false);
                setSelectedId(null);
              }}
              onOpenExternal={onOpenExternal}
              onOpenFile={(attachmentId) => window.gemUi.contextAttachments.openFile({ attachmentId }).then(() => undefined)}
              live={isLive}
              onLiveToggle={(live) => setIsLive(live)}
            />
          )}
        </div>
      </div>

      <AddLinkDialog
        open={linkScope !== null}
        scopeLabel={linkScope === "session" ? "Diese Session" : "Projekt"}
        onClose={() => setLinkScope(null)}
        onSubmit={(url, title) => addLink(linkScope ?? "project", url, title).then(() => undefined)}
      />
    </aside>
  );
}
