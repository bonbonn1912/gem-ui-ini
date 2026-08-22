import { useEffect } from "react";

import { Icon } from "../../components/Icon";
import { LinkPreviewSurface } from "../attachments/LinkPreviewSurface";
import type { JiraSessionIssue } from "./useJiraIssue";

type JiraIssueViewProps = {
  issue: JiraSessionIssue;
  attachError: string | null;
  onClose: () => void;
  onOpenExternal: (url: string) => void;
};

/**
 * The Jira issue, full width.
 *
 * This takes the place of the chat view inside the workspace grid rather than
 * sitting beside it as a panel: an issue is read, not glanced at, so it gets
 * everything between the session sidebar and the panel rail. The only chrome
 * is a single slim bar — without it there would be no way to reload the page
 * or hand it to a real browser.
 *
 * The page itself is the sandboxed WebContentsView the link preview already
 * uses, so the user's existing Jira login in that view is what grants access;
 * the app never sees a credential.
 */
export function JiraIssueView({
  issue,
  attachError,
  onClose,
  onOpenExternal,
}: JiraIssueViewProps) {
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
    // The raw URL is a fine fallback for the label.
  }

  return (
    <section className="jira-issue-view" aria-label={`Jira-Issue ${issue.issueKey}`}>
      <header className="jira-issue-header">
        <span className="jira-issue-badge">
          <Icon name="jira" size={15} />
          {issue.issueKey}
        </span>
        <span className="jira-issue-host" title={issue.url}>
          {host}
        </span>
        {attachError && (
          <span className="jira-issue-attach-error" role="status" title={attachError}>
            <Icon name="warning" size={13} /> Anhang fehlgeschlagen
          </span>
        )}
        <div className="jira-issue-header-actions">
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
