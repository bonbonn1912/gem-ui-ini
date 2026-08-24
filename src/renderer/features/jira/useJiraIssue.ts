import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildJiraIssueUrl,
  matchJiraIssueKey,
  type JiraIssueAttachment,
} from "../../../shared/contracts";
import type { AppProject, JiraProjectIntegration } from "../../types";
import { createClientRequestId } from "../../utils/client-request-id";

export type JiraSessionIssue = {
  issueKey: string;
  prefix: string;
  url: string;
  configName: string;
  summary?: string | null;
  storyMarkdown?: string | null;
  storyAttachmentId?: string | null;
  attachments?: JiraIssueAttachment[];
  hasAccessToken?: boolean;
};

type UseJiraIssueInput = {
  project: AppProject | null;
  sessionId: string | null;
  sessionTitle: string | null;
  /** Bumped when the settings dialog closes, so an activation is picked up. */
  reloadToken?: unknown;
};

type UseJiraIssueResult = {
  integration: JiraProjectIntegration | null;
  /** Set only when Jira is active for the project and the title names an issue. */
  issue: JiraSessionIssue | null;
  attachError: string | null;
};

/**
 * Ties a session to the Jira issue its name mentions.
 *
 * Matching happens here rather than in the main process because it has to
 * follow the title as it is typed and renamed, and the active configuration —
 * the only thing needed for it — is already loaded once per project. The main
 * process still owns the URL when the issue is attached, so a renderer that
 * got the key wrong cannot invent a link.
 *
 * When an access token is configured, `attachIssue` also fetches the story
 * details from the Jira REST API, attaches `story.md` to the session, and
 * populates `storyMarkdown` and `summary`.
 */
export function useJiraIssue({
  project,
  sessionId,
  sessionTitle,
  reloadToken,
}: UseJiraIssueInput): UseJiraIssueResult {
  const [integration, setIntegration] = useState<JiraProjectIntegration | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [issueDetails, setIssueDetails] = useState<{
    key: string;
    summary?: string | null;
    storyMarkdown?: string | null;
    storyAttachmentId?: string | null;
    attachments?: JiraIssueAttachment[];
  } | null>(null);
  const attachedRef = useRef<Set<string>>(new Set());

  const projectId = project?.id ?? null;

  useEffect(() => {
    setIntegration(null);
    const api = window.gemUi?.jira;
    if (!projectId || !api) return;
    let current = true;
    api
      .getProjectIntegration({ projectId })
      .then((next) => {
        if (current) setIntegration(next);
      })
      .catch(() => {
        if (current) setIntegration(null);
      });
    return () => {
      current = false;
    };
  }, [projectId, reloadToken]);

  const baseIssue = useMemo<JiraSessionIssue | null>(() => {
    const config = integration?.activeConfig ?? null;
    if (!config || !sessionTitle) return null;
    const match = matchJiraIssueKey(sessionTitle, config.issuePrefixes);
    if (!match) return null;
    return {
      issueKey: match.issueKey,
      prefix: match.prefix,
      url: buildJiraIssueUrl(config.baseUrl, match.issueKey),
      configName: config.name,
      hasAccessToken: config.hasAccessToken,
    };
  }, [integration, sessionTitle]);

  // 1. Attach link & story.md to active session
  useEffect(() => {
    const api = window.gemUi?.jira;
    if (!projectId || !sessionId || !baseIssue || !api) return;
    const marker = `${sessionId}:${baseIssue.issueKey}`;
    if (attachedRef.current.has(marker)) return;
    attachedRef.current.add(marker);

    let current = true;
    api
      .attachIssue({
        clientRequestId: createClientRequestId(),
        projectId,
        sessionId,
        issueKey: baseIssue.issueKey,
      })
      .then((result) => {
        if (current) {
          setAttachError(null);
          if (result.storyMarkdown || result.summary) {
            setIssueDetails((prev) => ({
              key: baseIssue.issueKey,
              summary: result.summary ?? prev?.summary,
              storyMarkdown: result.storyMarkdown ?? prev?.storyMarkdown,
              storyAttachmentId: result.storyAttachmentId ?? prev?.storyAttachmentId,
              attachments: prev?.key === baseIssue.issueKey ? prev.attachments : [],
            }));
          }
        }
      })
      .catch((error: unknown) => {
        attachedRef.current.delete(marker);
        if (current) {
          setAttachError(
            error instanceof Error
              ? error.message
              : "Das Jira-Issue konnte nicht an die Session angehängt werden.",
          );
        }
      });

    return () => {
      current = false;
    };
  }, [baseIssue?.issueKey, projectId, sessionId]);

  // 2. Fetch full issue details (summary, story markdown, attachments list) whenever access token is present
  useEffect(() => {
    const api = window.gemUi?.jira;
    if (!projectId || !baseIssue?.issueKey || !baseIssue.hasAccessToken || !api) return;

    let current = true;
    api
      .fetchIssueDetails({ projectId, issueKey: baseIssue.issueKey })
      .then((details) => {
        if (current) {
          setIssueDetails((prev) => ({
            key: baseIssue.issueKey,
            summary: details.summary ?? prev?.summary,
            storyMarkdown: details.storyMarkdown ?? prev?.storyMarkdown,
            storyAttachmentId: prev?.key === baseIssue.issueKey ? prev.storyAttachmentId : undefined,
            attachments: details.attachments || [],
          }));
        }
      })
      .catch((err) => {
        console.warn("[useJiraIssue] Fehler beim Laden der Jira-Details:", err);
      });

    return () => {
      current = false;
    };
  }, [baseIssue?.issueKey, baseIssue?.hasAccessToken, projectId, reloadToken]);

  const issue = useMemo<JiraSessionIssue | null>(() => {
    if (!baseIssue) return null;
    const details = issueDetails?.key === baseIssue.issueKey ? issueDetails : null;
    return {
      ...baseIssue,
      summary: details?.summary ?? null,
      storyMarkdown: details?.storyMarkdown ?? null,
      storyAttachmentId: details?.storyAttachmentId ?? null,
      attachments: details?.attachments ?? [],
    };
  }, [baseIssue, issueDetails]);

  return { integration, issue, attachError };
}
