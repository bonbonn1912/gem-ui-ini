import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

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
  project: Accessor<AppProject | null>;
  sessionId: Accessor<string | null>;
  sessionTitle: Accessor<string | null>;
  /** Bumped when the settings dialog closes, so an activation is picked up. */
  reloadToken?: Accessor<unknown>;
};

type UseJiraIssueResult = {
  integration: Accessor<JiraProjectIntegration | null>;
  /** Set only when Jira is active for the project and the title names an issue. */
  issue: Accessor<JiraSessionIssue | null>;
  attachError: Accessor<string | null>;
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
  const [integration, setIntegration] = createSignal<JiraProjectIntegration | null>(null);
  const [attachError, setAttachError] = createSignal<string | null>(null);
  let attachedRef: Set<string> = new Set();

  createEffect(() => {
    reloadToken?.();
    // Cleared before the request so a stale activation never leaks into the
    // next project for the moment the new one is in flight.
    setIntegration(null);
    // A bridge without the Jira surface — an older preload, or a test double
    // that predates the integration — simply means Jira is off, not a crash.
    const currentProject = project();
    const api = window.gemUi?.jira;
    const projectId = currentProject?.id ?? null;
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
    onCleanup(() => {
      current = false;
    });
  });

  const issue = createMemo<JiraSessionIssue | null>(() => {
    const config = integration()?.activeConfig ?? null;
    const title = sessionTitle();
    if (!config || !title) return null;
    const match = matchJiraIssueKey(title, config.issuePrefixes);
    if (!match) return null;
    return {
      issueKey: match.issueKey,
      prefix: match.prefix,
      url: buildJiraIssueUrl(config.baseUrl, match.issueKey),
      configName: config.name,
    };
  });

  createEffect(() => {
    const api = window.gemUi?.jira;
    const currentProject = project();
    const currentSessionId = sessionId();
    const currentIssue = issue();
    if (!currentProject || !currentSessionId || !currentIssue || !api) return;
    const marker = `${currentSessionId}:${currentIssue.issueKey}`;
    if (attachedRef.has(marker)) return;
    attachedRef.add(marker);

    let current = true;
    api
      .attachIssue({
        clientRequestId: createClientRequestId(),
        projectId: currentProject.id,
        sessionId: currentSessionId,
        issueKey: currentIssue.issueKey,
      })
      .then(() => {
        if (current) setAttachError(null);
      })
      .catch((error: unknown) => {
        // A failed attach must not stop the issue from being viewable, so it
        // is reported rather than thrown — and the marker is dropped so the
        // next render may try again.
        attachedRef.delete(marker);
        if (current) {
          setAttachError(
            error instanceof Error
              ? error.message
              : "Das Jira-Issue konnte nicht an die Session angehängt werden.",
          );
        }
      });
    onCleanup(() => {
      current = false;
    });
  });

  return { integration, issue, attachError };
}
