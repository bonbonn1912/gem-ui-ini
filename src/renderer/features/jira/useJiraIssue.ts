import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildJiraIssueUrl,
  matchJiraIssueKey,
} from "../../../shared/contracts";
import type { AppProject, JiraProjectIntegration } from "../../types";
import { createClientRequestId } from "../../utils/client-request-id";

export type JiraSessionIssue = {
  issueKey: string;
  prefix: string;
  url: string;
  configName: string;
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
 * The attachment is created as soon as a match appears. It is a session-scoped
 * link attachment, which the context-attachment service deduplicates on the
 * URL, so a rename back and forth does not pile up copies; the ref below only
 * saves the redundant round-trips.
 */
export function useJiraIssue({
  project,
  sessionId,
  sessionTitle,
  reloadToken,
}: UseJiraIssueInput): UseJiraIssueResult {
  const [integration, setIntegration] = useState<JiraProjectIntegration | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const attachedRef = useRef<Set<string>>(new Set());

  const projectId = project?.id ?? null;

  useEffect(() => {
    // Cleared before the request so a stale activation never leaks into the
    // next project for the moment the new one is in flight.
    setIntegration(null);
    // A bridge without the Jira surface — an older preload, or a test double
    // that predates the integration — simply means Jira is off, not a crash.
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

  const issue = useMemo<JiraSessionIssue | null>(() => {
    const config = integration?.activeConfig ?? null;
    if (!config || !sessionTitle) return null;
    const match = matchJiraIssueKey(sessionTitle, config.issuePrefixes);
    if (!match) return null;
    return {
      issueKey: match.issueKey,
      prefix: match.prefix,
      url: buildJiraIssueUrl(config.baseUrl, match.issueKey),
      configName: config.name,
    };
  }, [integration, sessionTitle]);

  useEffect(() => {
    const api = window.gemUi?.jira;
    if (!projectId || !sessionId || !issue || !api) return;
    const marker = `${sessionId}:${issue.issueKey}`;
    if (attachedRef.current.has(marker)) return;
    attachedRef.current.add(marker);

    let current = true;
    api
      .attachIssue({
        clientRequestId: createClientRequestId(),
        projectId,
        sessionId,
        issueKey: issue.issueKey,
      })
      .then(() => {
        if (current) setAttachError(null);
      })
      .catch((error: unknown) => {
        // A failed attach must not stop the issue from being viewable, so it
        // is reported rather than thrown — and the marker is dropped so the
        // next render may try again.
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
  }, [issue?.issueKey, projectId, sessionId]);

  return { integration, issue, attachError };
}
