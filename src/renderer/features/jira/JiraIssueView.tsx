import { useEffect, useState } from "react";

import { Icon } from "../../components/Icon";
import { LinkPreviewSurface } from "../attachments/LinkPreviewSurface";
import { createClientRequestId } from "../../utils/client-request-id";
import type { JiraSessionIssue } from "./useJiraIssue";

type JiraIssueViewProps = {
  issue: JiraSessionIssue;
  projectId?: string | null;
  sessionId?: string | null;
  attachError: string | null;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
  onInsertIntoChat?: (text: string) => void;
};

/**
 * The Jira issue view.
 *
 * Renders the integrated Jira Web view with 1-click insertion into the chat
 * composer and 1-click synchronization of story attachments directly into
 * the active session context.
 */
export function JiraIssueView({
  issue,
  projectId,
  sessionId,
  attachError,
  onClose,
  onOpenExternal,
  onInsertIntoChat,
}: JiraIssueViewProps) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  let host = issue.url;
  try {
    host = new URL(issue.url).hostname;
  } catch {
    // Fallback to raw URL
  }

  const handleSendToChat = () => {
    if (!onInsertIntoChat) return;
    const textToSend = issue.storyMarkdown || `# [${issue.issueKey}] ${issue.url}`;
    onInsertIntoChat(textToSend);
  };

  const handleSyncAttachments = async () => {
    if (!projectId || !sessionId || !issue.issueKey || syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await window.gemUi.jira.syncAttachments({
        clientRequestId: createClientRequestId(),
        projectId,
        sessionId,
        issueKey: issue.issueKey,
      });
      setSyncResult(
        result.syncedCount === 1
          ? "1 Anhang synchronisiert"
          : `${result.syncedCount} Anhänge synchronisiert`,
      );
    } catch (err) {
      setSyncResult(
        err instanceof Error ? `Fehler: ${err.message}` : "Synchronisierung fehlgeschlagen",
      );
    } finally {
      setSyncing(false);
    }
  };

  const attachmentsCount = issue.attachments?.length || 0;

  return (
    <section className="jira-issue-view" aria-label={`Jira-Issue ${issue.issueKey}`}>
      <header className="jira-issue-header">
        <div className="jira-issue-header-left">
          <span className="jira-issue-badge">
            <Icon name="jira" size={15} />
            {issue.issueKey}
          </span>
          {issue.summary && (
            <span className="jira-issue-summary" title={issue.summary}>
              {issue.summary}
            </span>
          )}
          <span className="jira-issue-host" title={issue.url}>
            {host}
          </span>
        </div>

        {attachError && (
          <span className="jira-issue-attach-error" role="status" title={attachError}>
            <Icon name="warning" size={13} /> Anhang fehlgeschlagen
          </span>
        )}

        <div className="jira-issue-header-actions">
          {attachmentsCount > 0 && projectId && sessionId && (
            <button
              type="button"
              className="secondary-button jira-sync-attachments-btn"
              onClick={() => void handleSyncAttachments()}
              disabled={syncing}
              title={`${attachmentsCount} Anhang/Anhänge aus Jira in diese Session laden`}
            >
              {syncing ? (
                <span className="mini-spinner" />
              ) : (
                <Icon name="download" size={13} />
              )}
              <span>
                {syncing
                  ? "Synchronisiere …"
                  : syncResult
                    ? syncResult
                    : `${attachmentsCount} ${attachmentsCount === 1 ? "Anhang" : "Anhänge"} syncen`}
              </span>
            </button>
          )}

          {onInsertIntoChat && (
            <button
              type="button"
              className="primary-button jira-chat-insert-button"
              onClick={handleSendToChat}
              title="Story in Chat-Eingabe übernehmen"
            >
              <Icon name="chat" size={13} />
              <span>In Chat einfügen</span>
            </button>
          )}

          <button
            type="button"
            className="secondary-button"
            onClick={() => onOpenExternal(issue.url)}
            title="In externem Webbrowser öffnen"
          >
            <Icon name="external" size={13} />
            <span>Im Browser öffnen</span>
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Jira-Ansicht schließen"
            title="Schließen (Esc)"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>

      <div className="jira-issue-body">
        <LinkPreviewSurface
          key={issue.url}
          url={issue.url}
          host={host}
          showHeader={false}
          isExpanded
          onOpenExternal={onOpenExternal}
          onClose={onClose}
        />
      </div>
    </section>
  );
}
