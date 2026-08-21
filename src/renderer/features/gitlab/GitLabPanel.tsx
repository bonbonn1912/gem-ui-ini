import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import type { AppSession, ExternalPromptContextRef } from "../../types";
import { GitLabDiscussionCard } from "./GitLabDiscussionCard";
import { GitLabMergeRequestList } from "./GitLabMergeRequestList";
import { GitLabMergeRequestPicker } from "./GitLabMergeRequestPicker";
import { GitLabRepositoryPicker } from "./GitLabRepositoryPicker";
import { useGitLabReview } from "./useGitLabReview";

type FilterTab = "unresolved" | "all" | "mine";

type GitLabPanelProps = {
  projectId: string;
  rootRevision: number;
  activeSession: AppSession | null;
  onClose: () => void;
  onSendExternalContextPrompt: (ref: ExternalPromptContextRef) => Promise<void>;
  onOpenExternal: (url: string) => void;
  onOpenSettings: () => void;
};

export function GitLabPanel({
  projectId,
  rootRevision,
  activeSession,
  onClose,
  onSendExternalContextPrompt,
  onOpenExternal,
  onOpenSettings,
}: GitLabPanelProps) {
  const {
    candidates,
    enabledBindings,
    selectedBindingId,
    setSelectedBindingId,
    reviewState,
    loading,
    error,
    mergeRequests,
    mergeRequestsLoading,
    loadMergeRequests,
    refresh,
    selectMergeRequest,
    resolveDiscussion,
    replyToDiscussion,
    prepareReviewContext,
  } = useGitLabReview(projectId, rootRevision);

  const [filterTab, setFilterTab] = useState<FilterTab>("unresolved");

  const selectedCandidate = useMemo(
    () => candidates.find((c) => c.binding?.id === selectedBindingId) ?? null,
    [candidates, selectedBindingId],
  );

  const filteredDiscussions = useMemo(() => {
    if (!reviewState) return [];
    return reviewState.discussions.filter((d) => {
      if (filterTab === "unresolved") {
        return d.resolvable ? !d.resolved : true;
      }
      if (filterTab === "mine") {
        const myUsername = reviewState.connection.user.username.toLowerCase();
        return d.notes.some((n) => n.author.username.toLowerCase() === myUsername);
      }
      return true;
    });
  }, [reviewState, filterTab]);

  const isReadOnly = reviewState?.connection.access === "read_only";
  const mergeRequest = reviewState?.mergeRequest ?? null;

  const handleSendToGemini = async (
    discussionId: string,
    mode: "affected_lines" | "whole_file",
  ) => {
    if (!mergeRequest) return;
    if (!activeSession) {
      throw new Error(
        "Bitte wählen Sie zuerst eine aktive Chat-Session aus, um den Review-Thread zu senden.",
      );
    }

    const prepared = await prepareReviewContext(
      mergeRequest.targetProjectId,
      mergeRequest.iid,
      discussionId,
      mode,
    );

    if (prepared) {
      await onSendExternalContextPrompt(prepared.ref);
    }
  };

  return (
    <aside className="gitlab-panel" aria-label="GitLab Review Panel">
      <header className="gitlab-panel-header">
        <div>
          <span className="gitlab-panel-icon">
            <Icon name="gitlab" size={17} />
          </span>
          <div>
            <strong>GitLab Review</strong>
            <span>
              {mergeRequest
                ? `!${mergeRequest.iid} · ${mergeRequest.sourceBranch}`
                : selectedCandidate?.displayName || "Kein Merge Request gewählt"}
            </span>
          </div>
          {reviewState && reviewState.unresolvedDiscussionsCount > 0 && (
            <span className="gitlab-open-badge">
              {reviewState.unresolvedDiscussionsCount} offen
            </span>
          )}
        </div>

        <button
          type="button"
          className="icon-button"
          onClick={() => void refresh()}
          title="Aktualisieren"
          aria-label="Aktualisieren"
          disabled={loading}
        >
          {loading ? <span className="mini-spinner" /> : <Icon name="refresh" size={16} />}
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          title="Panel schließen"
          aria-label="GitLab Panel schließen"
        >
          <Icon name="x" size={17} />
        </button>
      </header>

      <div className="gitlab-panel-body">
        {enabledBindings.length > 0 && (mergeRequest || enabledBindings.length > 1) && (
          <div className="gitlab-controls-bar">
            <GitLabRepositoryPicker
              candidates={candidates}
              selectedBindingId={selectedBindingId}
              onSelectBinding={(id) => setSelectedBindingId(id)}
            />

            {selectedBindingId && mergeRequest && (
              <GitLabMergeRequestPicker
                mergeRequests={mergeRequests}
                loading={mergeRequestsLoading}
                selectedMr={mergeRequest}
                onSelectMr={selectMergeRequest}
                onReload={() => void loadMergeRequests()}
                onOpenExternal={onOpenExternal}
              />
            )}

            {mergeRequest && (
              <div className="gitlab-filter-tabs">
                <button
                  type="button"
                  className={`filter-tab ${filterTab === "unresolved" ? "filter-tab--active" : ""}`}
                  onClick={() => setFilterTab("unresolved")}
                >
                  Offen <i>{reviewState?.unresolvedDiscussionsCount ?? 0}</i>
                </button>
                <button
                  type="button"
                  className={`filter-tab ${filterTab === "all" ? "filter-tab--active" : ""}`}
                  onClick={() => setFilterTab("all")}
                >
                  Alle <i>{reviewState?.totalDiscussionsCount ?? 0}</i>
                </button>
                <button
                  type="button"
                  className={`filter-tab ${filterTab === "mine" ? "filter-tab--active" : ""}`}
                  onClick={() => setFilterTab("mine")}
                >
                  Von mir
                </button>
              </div>
            )}
          </div>
        )}

        <div className="gitlab-panel-scroll">
          {enabledBindings.length === 0 && !loading && (
            <div className="gitlab-panel-state">
              <span className="gitlab-state-icon">
                <Icon name="gitlab" size={22} />
              </span>
              <strong>GitLab nicht aktiviert</strong>
              <p>
                Für die Repositories dieses Projekts ist noch keine
                GitLab-Review-Integration aktiviert.
              </p>
              <button type="button" className="primary-button" onClick={onOpenSettings}>
                <Icon name="settings" size={14} /> In Projekteinstellungen aktivieren
              </button>
            </div>
          )}

          {error && (
            <div className="gitlab-panel-error" role="alert">
              <Icon name="warning" size={17} />
              <p>
                <strong>GitLab konnte nicht geladen werden</strong>
                <span>{error}</span>
              </p>
              <button type="button" onClick={() => void refresh()}>
                Erneut
              </button>
            </div>
          )}

          {loading && !reviewState && enabledBindings.length > 0 && (
            <div className="gitlab-loading">
              <span className="mini-spinner" /> Review-Threads werden geladen …
            </div>
          )}

          {/* Kein MR gewählt: offene Merge Requests direkt zur Auswahl anbieten */}
          {enabledBindings.length > 0 && !mergeRequest && !loading && (
            <GitLabMergeRequestList
              mergeRequests={mergeRequests}
              loading={mergeRequestsLoading}
              currentBranch={selectedCandidate?.branch ?? null}
              onSelectMr={selectMergeRequest}
              onReload={() => void loadMergeRequests()}
            />
          )}

          {reviewState && mergeRequest && (
            <div className="gitlab-discussions-list">
              {filteredDiscussions.length === 0 ? (
                <div className="gitlab-panel-state gitlab-panel-state--calm">
                  <span className="gitlab-state-icon gitlab-state-icon--ok">
                    <Icon name="check" size={22} />
                  </span>
                  <strong>
                    {filterTab === "unresolved" ? "Alles abgearbeitet" : "Keine Threads"}
                  </strong>
                  <p>
                    {filterTab === "unresolved"
                      ? "In diesem Merge Request ist kein Review-Thread mehr offen."
                      : "Für diesen Filter wurden keine Review-Threads gefunden."}
                  </p>
                </div>
              ) : (
                filteredDiscussions.map((discussion) => (
                  <GitLabDiscussionCard
                    key={discussion.id}
                    discussion={discussion}
                    mergeRequest={mergeRequest}
                    isReadOnly={isReadOnly}
                    onSendToGemini={handleSendToGemini}
                    onResolve={(id, resolved) =>
                      resolveDiscussion(
                        mergeRequest.targetProjectId,
                        mergeRequest.iid,
                        id,
                        resolved,
                      ).then(() => undefined)
                    }
                    onReply={(id, body) =>
                      replyToDiscussion(
                        mergeRequest.targetProjectId,
                        mergeRequest.iid,
                        id,
                        body,
                      ).then(() => undefined)
                    }
                    onOpenExternal={onOpenExternal}
                  />
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
