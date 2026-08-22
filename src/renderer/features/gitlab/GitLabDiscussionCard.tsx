import { useState } from "react";
import { Icon } from "../../components/Icon";
import type { GitLabDiscussion, GitLabMergeRequestSummary } from "../../types";
import type { ReviewDelivery } from "./GitLabPanel";

type GitLabDiscussionCardProps = {
  discussion: GitLabDiscussion;
  mergeRequest: GitLabMergeRequestSummary;
  isReadOnly: boolean;
  currentUsername?: string | null;
  delivery: ReviewDelivery;
  onSendToGemini: (discussionId: string, mode: "affected_lines" | "whole_file") => Promise<void>;
  onResolve: (discussionId: string, resolved: boolean) => Promise<void>;
  onReply: (discussionId: string, body: string) => Promise<void>;
  onOpenExternal: (url: string) => void;
};

/** Stabiler Farbton je Autor — dieselbe Person bekommt immer dieselbe
 *  Avatarfarbe, damit sich Kommentare verschiedener Leute unterscheiden. */
function authorHue(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i += 1) {
    hash = (hash * 31 + username.charCodeAt(i)) % 360;
  }
  return String(hash);
}

/** Für heutige Notizen reicht die Uhrzeit, ältere brauchen das Datum. */
function noteTimestamp(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { day: "2-digit", month: "2-digit" })} · ${time}`;
}

export function GitLabDiscussionCard({
  discussion,
  mergeRequest,
  isReadOnly,
  currentUsername,
  delivery,
  onSendToGemini,
  onResolve,
  onReply,
  onOpenExternal,
}: GitLabDiscussionCardProps) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [submittingReply, setSubmittingReply] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [sendingPromptMode, setSendingPromptMode] = useState<"affected_lines" | "whole_file" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mainNote = discussion.notes[0];
  if (!mainNote) return null;

  const drafting = delivery === "draft";
  const busyLabel = drafting ? "Übernehmen …" : "Senden …";
  const targetLabel = drafting ? "in den Entwurf" : "an Gemini";

  const position = mainNote.position;
  const filePath = position?.newPath ?? position?.oldPath;
  const lineNum = position?.newLine ?? position?.oldLine;
  const lineRange = position?.lineRange;
  const lineDisplay = lineRange
    ? `Zeilen ${lineRange.start.newLine ?? lineRange.start.oldLine ?? "?"}–${lineRange.end.newLine ?? lineRange.end.oldLine ?? "?"}`
    : lineNum
      ? `Zeile ${lineNum}`
      : null;

  const handleResolveToggle = async () => {
    setResolving(true);
    setError(null);
    try {
      await onResolve(discussion.id, !discussion.resolved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResolving(false);
    }
  };

  const handleSendReply = async (e?: React.FormEvent | React.KeyboardEvent) => {
    if (e) e.preventDefault();
    if (!replyText.trim() || submittingReply) return;
    setSubmittingReply(true);
    setError(null);
    try {
      await onReply(discussion.id, replyText.trim());
      setReplyText("");
      setReplyOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmittingReply(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void handleSendReply(e);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setReplyOpen(false);
      setReplyText("");
    }
  };

  const handlePromptSend = async (mode: "affected_lines" | "whole_file") => {
    setSendingPromptMode(mode);
    setError(null);
    try {
      await onSendToGemini(discussion.id, mode);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSendingPromptMode(null);
    }
  };

  const visibleNotes = discussion.notes.filter((note) => !note.system);
  const cardClasses = [
    "gitlab-discussion-card",
    discussion.resolved ? "gitlab-discussion-card--resolved" : "",
    position?.outdated ? "gitlab-discussion-card--outdated" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={cardClasses}>
      {/* Header Info */}
      <header className="discussion-card-header">
        <div className="discussion-meta-left">
          {filePath && (
            <span className="discussion-file-badge" title={filePath}>
              <Icon name="file-text" size={13} />
              <strong>{filePath}</strong>
              {lineDisplay && <span className="line-num">· {lineDisplay}</span>}
            </span>
          )}
          {position?.outdated && (
            <span className="badge badge--warning" title="Kommentar bezieht sich auf älteren MR-Stand">
              veraltet
            </span>
          )}
          {discussion.resolved && (
            <span className="badge badge--success">
              <Icon name="check" size={12} /> gelöst
            </span>
          )}
        </div>
        {visibleNotes.length > 1 && (
          <span
            className="discussion-note-count"
            title={`${visibleNotes.length} Kommentare in diesem Thread`}
          >
            {visibleNotes.length} Kommentare
          </span>
        )}
      </header>

      {/* Notes / Comments */}
      <div className="discussion-notes">
        {visibleNotes.map((note, index) => {
          const isOwn = currentUsername
            ? note.author.username.toLowerCase() === currentUsername.toLowerCase()
            : false;
          const noteClasses = [
            "discussion-note",
            index === 0 ? "discussion-note--root" : "discussion-note--reply",
            isOwn ? "discussion-note--own" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <div key={note.id} className={noteClasses}>
              <div className="note-author-row">
                <span
                  className="note-avatar-initials"
                  style={{ "--author-hue": authorHue(note.author.username) } as React.CSSProperties}
                >
                  {note.author.name.slice(0, 2).toUpperCase()}
                </span>
                <strong className="note-author-name">@{note.author.username}</strong>
                {isOwn && <span className="note-you-tag">du</span>}
                <span className="note-time" title={new Date(note.createdAt).toLocaleString()}>
                  {noteTimestamp(note.createdAt)}
                </span>
              </div>
              <div className="note-body-content">{note.body}</div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="gitlab-card-error">
          <Icon name="warning" size={14} />
          <span>{error}</span>
        </div>
      )}

      {/* Action Toolbar */}
      <footer className="discussion-card-footer">
        <div className="prompt-actions-group">
          <button
            type="button"
            className="secondary-button prompt-btn"
            onClick={() => handlePromptSend("affected_lines")}
            disabled={sendingPromptMode !== null}
            title={drafting
              ? "Betroffene Zeilen dieses Threads in das Eingabefeld übernehmen"
              : "Betroffene Zeilen dieses Threads sofort als Prompt an Gemini senden"}
          >
            {sendingPromptMode === "affected_lines" ? (
              <><span className="mini-spinner" /> {busyLabel}</>
            ) : (
              <><Icon name={drafting ? "pencil" : "sparkle"} size={13} /> Betroffene Zeilen {targetLabel}</>
            )}
          </button>

          {filePath && (
            <button
              type="button"
              className="secondary-button prompt-btn"
              onClick={() => handlePromptSend("whole_file")}
              disabled={sendingPromptMode !== null}
              title={drafting
                ? "Vollständige Datei am Review-Stand in das Eingabefeld übernehmen"
                : "Vollständige Datei am Review-Stand sofort als Prompt an Gemini senden"}
            >
              {sendingPromptMode === "whole_file" ? (
                <><span className="mini-spinner" /> {busyLabel}</>
              ) : (
                <><Icon name="file-text" size={13} /> Ganze Datei {targetLabel}</>
              )}
            </button>
          )}
        </div>

        <div className="discussion-tools-group">
          {!isReadOnly && discussion.resolvable && (
            <button
              type="button"
              className={`tool-btn ${discussion.resolved ? "tool-btn--reopen" : "tool-btn--resolve"}`}
              onClick={handleResolveToggle}
              disabled={resolving}
            >
              <Icon name="check" size={13} />
              {discussion.resolved ? "Wieder öffnen" : "Auflösen"}
            </button>
          )}

          {!isReadOnly && !replyOpen && discussion.repliable && (
            <button
              type="button"
              className="tool-btn"
              onClick={() => setReplyOpen(true)}
            >
              Antworten
            </button>
          )}

          <button
            type="button"
            className="tool-btn"
            onClick={() => onOpenExternal(mergeRequest.webUrl)}
            title="In GitLab öffnen"
          >
            <Icon name="external" size={13} />
          </button>
        </div>
      </footer>

      {/* Reply Form */}
      {replyOpen && discussion.repliable && (
        <form onSubmit={handleSendReply} className="discussion-reply-form">
          <textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Auf Thread antworten … (Strg+Enter zum Senden)"
            rows={2}
            autoFocus
          />
          <div className="reply-form-actions">
            <span className="char-count">{replyText.length} Zeichen</span>
            <div className="reply-btns">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setReplyOpen(false);
                  setReplyText("");
                }}
              >
                Abbrechen
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={submittingReply || !replyText.trim()}
              >
                {submittingReply ? <span className="mini-spinner" /> : "Antworten"}
              </button>
            </div>
          </div>
        </form>
      )}
    </article>
  );
}
