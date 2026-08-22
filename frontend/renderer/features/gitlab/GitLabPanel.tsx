import { createMemo, createSignal } from "solid-js";
import { Icon } from "../../components/Icon";
import type { AppSession, PreparedExternalContext } from "../../types";
import { GitLabDiscussionCard } from "./GitLabDiscussionCard";
import { GitLabMergeRequestList } from "./GitLabMergeRequestList";
import { GitLabMergeRequestPicker } from "./GitLabMergeRequestPicker";
import { GitLabRepositoryPicker } from "./GitLabRepositoryPicker";
import { useGitLabReview } from "./useGitLabReview";

type FilterTab = "unresolved" | "all" | "mine";

/**
 * Whether a review thread goes straight to Gemini or lands in the composer
 * first. It is a panel-wide choice rather than a per-button one so every send
 * action keeps a single, predictable meaning.
 */
export type ReviewDelivery = "send" | "draft";

const DELIVERY_STORAGE_KEY = "geminui.gitlab.review-delivery";

function initialDelivery(): ReviewDelivery {
  try {
    return window.localStorage.getItem(DELIVERY_STORAGE_KEY) === "draft" ? "draft" : "send";
  } catch {
    return "send";
  }
}

type GitLabPanelProps = {
  projectId: string;
  rootRevision: number;
  activeSession: AppSession | null;
  onClose: () => void;
  onSendExternalContextPrompt: (
    prepared: PreparedExternalContext,
    delivery: ReviewDelivery,
  ) => Promise<void>;
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

  const [filterTab, setFilterTab] = createSignal<FilterTab>("unresolved");
  const [delivery, setDelivery] = createSignal<ReviewDelivery>(initialDelivery());

  const chooseDelivery = (next: ReviewDelivery) => {
    setDelivery(next);
    try {
      window.localStorage.setItem(DELIVERY_STORAGE_KEY, next);
    } catch {
      // The choice still applies to this session without a preference store.
    }
  };

  const selectedCandidate = createMemo(
    () => (candidates as any)().find((c: any) => c.binding?.id === (selectedBindingId as any)()) ?? null,
  );

  const filteredDiscussions = createMemo(() => {
    if (!(reviewState as any)()) return [];
    return (reviewState as any)()!.discussions.filter((d: any) => {
      if ((filterTab as any)() === "unresolved") {
        return d.resolvable ? !d.resolved : true;
      }
      if ((filterTab as any)() === "mine") {
        const myUsername = (reviewState as any)()!.connection.user.username.toLowerCase();
        return d.notes.some((n) => n.author.username.toLowerCase() === myUsername);
      }
      return true;
    });
  });

  const isReadOnly = (reviewState as any)()?.connection.access === "read_only";
  const mergeRequest = (reviewState as any)()?.mergeRequest ?? null;

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
      await onSendExternalContextPrompt(prepared, delivery());
    }
  };

  return (
    <aside class="gitlab-panel" aria-label="GitLab Review Panel">
      <header class="gitlab-panel-header" data-tauri-drag-region>
        <div>
          <span class="gitlab-panel-icon">
            <Icon name="gitlab" size={17} />
          </span>
          <div>
            <strong>GitLab Review</strong>
            <span>
              {mergeRequest
                ? `!${mergeRequest.iid} · ${mergeRequest.sourceBranch}`
                : selectedCandidate()?.displayName || "Kein Merge Request gewählt"}
            </span>
          </div>
          {reviewState && reviewState.unresolvedDiscussionsCount > 0 && (
            <span class="gitlab-open-badge">
              {reviewState.unresolvedDiscussionsCount} offen
            </span>
          )}
        </div>

        <button
          type="button"
          class="icon-button"
          onClick={() => void refresh()}
          title="Aktualisieren"
          aria-label="Aktualisieren"
          disabled={loading}
        >
          {loading ? <span class="mini-spinner" /> : <Icon name="refresh" size={16} />}
        </button>
        <button
          type="button"
          class="icon-button"
          onClick={onClose}
          title="Panel schließen"
          aria-label="GitLab Panel schließen"
        >
          <Icon name="x" size={17} />
        </button>
      </header>

      <div class="gitlab-panel-body">
          {(enabledBindings as any)().length > 0 && (mergeRequest || (enabledBindings as any)().length > 1) && (
          <div class="gitlab-controls-bar">
            <GitLabRepositoryPicker
              candidates={(candidates as any)()}
              selectedBindingId={(selectedBindingId as any)()}
              onSelectBinding={(id) => setSelectedBindingId(id)}
            />

            {(selectedBindingId as any)() && mergeRequest && (
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
              <div class="gitlab-delivery-switch" role="group" aria-label="Ziel für Review-Feedback">
                <span>An Gemini:</span>
                <button
                  type="button"
                  class={`filter-tab ${(delivery as any)() === "send" ? "filter-tab--active" : ""}`}
                  aria-pressed={(delivery as any)() === "send"}
                  title="Der Thread wird sofort als Prompt gesendet"
                  onClick={() => chooseDelivery("send")}
                >
                  Direkt senden
                </button>
                <button
                  type="button"
                  class={`filter-tab ${(delivery as any)() === "draft" ? "filter-tab--active" : ""}`}
                  aria-pressed={(delivery as any)() === "draft"}
                  title="Der Thread landet im Eingabefeld, damit du eigenen Kontext ergänzen kannst"
                  onClick={() => chooseDelivery("draft")}
                >
                  Bearbeiten
                </button>
              </div>
            )}

            {mergeRequest && (
              <div class="gitlab-filter-tabs">
                <button
                  type="button"
                  class={`filter-tab ${(filterTab as any)() === "unresolved" ? "filter-tab--active" : ""}`}
                  onClick={() => setFilterTab("unresolved")}
                >
                  Offen <i>{reviewState?.unresolvedDiscussionsCount ?? 0}</i>
                </button>
                <button
                  type="button"
                  class={`filter-tab ${(filterTab as any)() === "all" ? "filter-tab--active" : ""}`}
                  onClick={() => setFilterTab("all")}
                >
                  Alle <i>{reviewState?.totalDiscussionsCount ?? 0}</i>
                </button>
                <button
                  type="button"
                  class={`filter-tab ${(filterTab as any)() === "mine" ? "filter-tab--active" : ""}`}
                  onClick={() => setFilterTab("mine")}
                >
                  Von mir
                </button>
              </div>
            )}
          </div>
        )}

        <div class="gitlab-panel-scroll">
          {(enabledBindings as any)().length === 0 && !(loading as any)() && (
            <div class="gitlab-panel-state">
              <span class="gitlab-state-icon">
                <Icon name="gitlab" size={22} />
              </span>
              <strong>GitLab nicht aktiviert</strong>
              <p>
                Für die Repositories dieses Projekts ist noch keine
                GitLab-Review-Integration aktiviert.
              </p>
              <button type="button" class="primary-button" onClick={onOpenSettings}>
                <Icon name="settings" size={14} /> In Projekteinstellungen aktivieren
              </button>
            </div>
          )}

          {(error as any)() && (
            <div class="gitlab-panel-error" role="alert">
              <Icon name="warning" size={17} />
              <p>
                <strong>GitLab konnte nicht geladen werden</strong>
                <span>{(error as any)()}</span>
              </p>
              <button type="button" onClick={() => void refresh()}>
                Erneut
              </button>
            </div>
          )}

          {(loading as any)() && !(reviewState as any)() && (enabledBindings as any)().length > 0 && (
            <div class="gitlab-loading">
              <span class="mini-spinner" /> Review-Threads werden geladen …
            </div>
          )}

          {/* Kein MR gewählt: offene Merge Requests direkt zur Auswahl anbieten */}
          {(enabledBindings as any)().length > 0 && !mergeRequest && !(loading as any)() && (
            <GitLabMergeRequestList
              mergeRequests={mergeRequests}
              loading={mergeRequestsLoading}
              currentBranch={selectedCandidate()?.branch ?? null}
              onSelectMr={selectMergeRequest}
              onReload={() => void loadMergeRequests()}
            />
          )}

          {(reviewState as any)() && mergeRequest && (
            <div class="gitlab-discussions-list">
              {filteredDiscussions().length === 0 ? (
                <div class="gitlab-panel-state gitlab-panel-state--calm">
                  <span class="gitlab-state-icon gitlab-state-icon--ok">
                    <Icon name="check" size={22} />
                  </span>
                  <strong>
                    {(filterTab as any)() === "unresolved" ? "Alles abgearbeitet" : "Keine Threads"}
                  </strong>
                  <p>
                    {(filterTab as any)() === "unresolved"
                      ? "In diesem Merge Request ist kein Review-Thread mehr offen."
                      : "Für diesen Filter wurden keine Review-Threads gefunden."}
                  </p>
                </div>
              ) : (
                filteredDiscussions().map((discussion) => (
                  <GitLabDiscussionCard

                    discussion={discussion}
                    mergeRequest={mergeRequest}
                    isReadOnly={isReadOnly}
                    onSendToGemini={handleSendToGemini}
                    delivery={delivery()}
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
