import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import type { AppSession, ExternalPromptContextRef } from "../../types";
import { GitLabDiscussionCard } from "./GitLabDiscussionCard";
import { GitLabMergeRequestPicker } from "./GitLabMergeRequestPicker";
import { GitLabRepositoryPicker } from "./GitLabRepositoryPicker";
import { useGitLabReview } from "./useGitLabReview";

type FilterTab = "unresolved" | "all" | "mine";

type GitLabPanelProps = {
  projectId: string;
  activeSession: AppSession | null;
  onClose: () => void;
  onSendExternalContextPrompt: (ref: ExternalPromptContextRef) => Promise<void>;
  onOpenExternal: (url: string) => void;
  onOpenSettings: () => void;
};

export function GitLabPanel({
  projectId,
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
    refresh,
    selectMergeRequest,
    connectMergeRequestUrl,
    resolveDiscussion,
    replyToDiscussion,
    prepareReviewContext,
  } = useGitLabReview(projectId);

  const [filterTab, setFilterTab] = useState<FilterTab>("unresolved");

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

  const handleSendToGemini = async (
    discussionId: string,
    mode: "affected_lines" | "whole_file",
  ) => {
    if (!reviewState?.mergeRequest) return;
    if (!activeSession) {
      throw new Error("Bitte wählen Sie zuerst eine aktive Chat-Session aus, um den Review-Thread zu senden.");
    }

    const prepared = await prepareReviewContext(
      reviewState.mergeRequest.targetProjectId,
      reviewState.mergeRequest.iid,
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
        <div className="panel-title-group">
          <span className="gitlab-header-icon"><Icon name="gitlab" size={17} /></span>
          <strong>GitLab Review</strong>
          {reviewState && (
            <span className="unresolved-counter-badge">
              {reviewState.unresolvedDiscussionsCount} offen
            </span>
          )}
        </div>

        <div className="panel-header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => void refresh()}
            title="Aktualisieren"
            aria-label="Aktualisieren"
            disabled={loading}
          >
            <Icon name="refresh" size={15} className={loading ? "spinning" : ""} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            title="Panel schließen"
            aria-label="GitLab Panel schließen"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>

      <div className="gitlab-panel-body">
        {/* If no enabled bindings exist for this project */}
        {enabledBindings.length === 0 && !loading && (
          <div className="gitlab-panel-empty">
            <span className="empty-icon"><Icon name="gitlab" size={32} /></span>
            <strong>GitLab nicht aktiviert</strong>
            <p>Für die Repositories dieses Projekts ist noch keine GitLab-Review-Integration aktiviert.</p>
            <button type="button" className="primary-button" onClick={onOpenSettings}>
              In Projekteinstellungen aktivieren
            </button>
          </div>
        )}

        {/* Enabled Repositories Picker & MR Picker */}
        {enabledBindings.length > 0 && (
          <div className="gitlab-controls-bar">
            <GitLabRepositoryPicker
              candidates={candidates}
              selectedBindingId={selectedBindingId}
              onSelectBinding={(id) => setSelectedBindingId(id)}
            />

            {selectedBindingId && (
              <GitLabMergeRequestPicker
                projectId={projectId}
                bindingId={selectedBindingId}
                selectedMr={reviewState?.mergeRequest ?? null}
                onSelectMr={selectMergeRequest}
                onConnectMrUrl={connectMergeRequestUrl}
                onOpenExternal={onOpenExternal}
              />
            )}

            {/* Filter Tabs */}
            {reviewState?.mergeRequest && (
              <div className="gitlab-filter-tabs">
                <button
                  type="button"
                  className={`filter-tab ${filterTab === "unresolved" ? "filter-tab--active" : ""}`}
                  onClick={() => setFilterTab("unresolved")}
                >
                  Offen ({reviewState.unresolvedDiscussionsCount})
                </button>
                <button
                  type="button"
                  className={`filter-tab ${filterTab === "all" ? "filter-tab--active" : ""}`}
                  onClick={() => setFilterTab("all")}
                >
                  Alle ({reviewState.totalDiscussionsCount})
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

        {/* Error message */}
        {error && (
          <div className="gitlab-error-banner">
            <Icon name="warning" size={16} />
            <span>{error}</span>
            <button type="button" onClick={() => void refresh()}>Erneut</button>
          </div>
        )}

        {/* Loading state */}
        {loading && !reviewState && (
          <div className="gitlab-loading">
            <span className="mini-spinner" /> Review-Threads werden geladen …
          </div>
        )}

        {/* Discussion list */}
        {reviewState && reviewState.mergeRequest && (
          <div className="gitlab-discussions-list">
            {filteredDiscussions.length === 0 ? (
              <div className="gitlab-discussions-empty">
                <Icon name="check" size={24} />
                <p>
                  {filterTab === "unresolved"
                    ? "Keine offenen Review-Threads in diesem Merge Request!"
                    : "Keine Review-Threads gefunden."}
                </p>
              </div>
            ) : (
              filteredDiscussions.map((discussion) => (
                <GitLabDiscussionCard
                  key={discussion.id}
                  discussion={discussion}
                  mergeRequest={reviewState.mergeRequest!}
                  isReadOnly={isReadOnly}
                  onSendToGemini={handleSendToGemini}
                  onResolve={(id, resolved) =>
                    resolveDiscussion(
                      reviewState.mergeRequest!.targetProjectId,
                      reviewState.mergeRequest!.iid,
                      id,
                      resolved,
                    ).then(() => undefined)
                  }
                  onReply={(id, body) =>
                    replyToDiscussion(
                      reviewState.mergeRequest!.targetProjectId,
                      reviewState.mergeRequest!.iid,
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

        {reviewState && !reviewState.mergeRequest && !loading && (
          <div className="gitlab-discussions-empty">
            <Icon name="link" size={24} />
            <p>Kein Merge Request ausgewählt. Wählen Sie oben einen MR aus oder verbinden Sie eine MR-URL.</p>
          </div>
        )}
      </div>
    </aside>
  );
}
