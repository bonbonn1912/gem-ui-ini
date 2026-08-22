import type {
  GitLabDiffPosition,
  GitLabDiscussion,
  GitLabDiscussionNote,
} from "../../../shared/contracts";
import type { RawGitLabDiscussionSchema } from "./gitlab-api-schemas";
import { z } from "zod";

type RawDiscussion = z.infer<typeof RawGitLabDiscussionSchema>;

const KNOWN_NOTE_TYPES = ["DiffNote", "DiscussionNote", "Note"] as const;
type KnownNoteType = (typeof KNOWN_NOTE_TYPES)[number];

/**
 * GitLab sends "new" | "old" for changed lines, "expanded" for unchanged context lines
 * of a multi-line comment, and sometimes null/nothing at all. Keep whatever string we
 * get (bounded), everything else becomes null instead of failing contract validation.
 */
function normalizeLineRangeType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 50) : null;
}

function normalizeNoteType(value: unknown, hasPosition: boolean): KnownNoteType | "unknown" {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((KNOWN_NOTE_TYPES as readonly string[]).includes(trimmed)) {
      return trimmed as KnownNoteType;
    }
    if (trimmed.length > 0) return "unknown";
  }
  return hasPosition ? "DiffNote" : "DiscussionNote";
}

/** Contract requires an absolute http(s) URL; relative GitLab avatar paths become null. */
export function normalizeAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) return null;
  return trimmed;
}

export function mapGitLabDiscussions(
  rawDiscussions: RawDiscussion[],
  currentMrHeadSha: string | null,
): GitLabDiscussion[] {
  const result: GitLabDiscussion[] = [];

  for (const raw of rawDiscussions) {
    if (!raw.notes || raw.notes.length === 0) continue;

    /**
     * GitLab liefert Systemnotizen ("hat den Titel geändert", "hat zugewiesen",
     * "hat als bereit markiert") als vollwertige Discussions aus. Sie sind keine
     * Kommentare: Die UI blendet sie aus, und die API lehnt Antworten darauf mit
     * HTTP 400 ab. Rein systemische Threads werden deshalb gar nicht erst
     * durchgereicht — sonst entstehen leere Karten, deren Antwortfeld nur
     * scheitern kann.
     */
    const conversationNotes = raw.notes.filter((note) => !note.system);
    if (conversationNotes.length === 0) continue;

    /**
     * Serverseitig prüft GitLab die *erste* Notiz des Threads. Beginnt er mit
     * einer Systemnotiz, scheitert jede Antwort mit
     * "Replies to system notes are not allowed" — auch wenn danach echte
     * Kommentare folgen.
     */
    const repliable = !raw.notes[0]?.system;

    const mappedNotes: GitLabDiscussionNote[] = [];
    let isDiscussionResolvable = false;
    let areAllResolvableNotesResolved = true;
    let hasResolvableNotes = false;

    for (const note of conversationNotes) {
      const isSystem = Boolean(note.system);
      const isResolvable = Boolean(note.resolvable);
      const isResolved = Boolean(note.resolved);

      if (isResolvable) {
        hasResolvableNotes = true;
        isDiscussionResolvable = true;
        if (!isResolved) areAllResolvableNotesResolved = false;
      }

      let mappedPosition: GitLabDiffPosition | null = null;
      if (note.position) {
        const rawPos = note.position;
        const posType = rawPos.position_type === "image" ? "image" : rawPos.position_type === "file" ? "file" : "text";
        const posHeadSha = rawPos.head_sha || "";
        const isOutdated = Boolean(posHeadSha && currentMrHeadSha && posHeadSha !== currentMrHeadSha);

        mappedPosition = {
          positionType: posType,
          baseSha: rawPos.base_sha || "",
          startSha: rawPos.start_sha || "",
          headSha: posHeadSha,
          oldPath: rawPos.old_path || null,
          newPath: rawPos.new_path || null,
          oldLine: rawPos.old_line ?? null,
          newLine: rawPos.new_line ?? null,
          lineRange: rawPos.line_range ? {
            start: {
              lineCode: rawPos.line_range.start?.line_code ?? null,
              type: normalizeLineRangeType(rawPos.line_range.start?.type),
              oldLine: rawPos.line_range.start?.old_line ?? null,
              newLine: rawPos.line_range.start?.new_line ?? null,
            },
            end: {
              lineCode: rawPos.line_range.end?.line_code ?? null,
              type: normalizeLineRangeType(rawPos.line_range.end?.type),
              oldLine: rawPos.line_range.end?.old_line ?? null,
              newLine: rawPos.line_range.end?.new_line ?? null,
            },
          } : null,
          outdated: isOutdated,
        };
      }

      mappedNotes.push({
        id: note.id,
        type: normalizeNoteType(note.type, Boolean(mappedPosition)),
        body: note.body,
        author: {
          id: note.author.id,
          username: note.author.username,
          name: note.author.name,
          avatarUrl: normalizeAvatarUrl(note.author.avatar_url),
        },
        system: isSystem,
        resolvable: isResolvable,
        resolved: isResolved,
        resolvedBy: note.resolved_by ? {
          id: note.resolved_by.id,
          username: note.resolved_by.username,
          name: note.resolved_by.name,
          avatarUrl: normalizeAvatarUrl(note.resolved_by.avatar_url),
        } : null,
        createdAt: note.created_at,
        updatedAt: note.updated_at,
        position: mappedPosition,
      });
    }

    const resolved = hasResolvableNotes ? areAllResolvableNotesResolved : false;

    result.push({
      id: raw.id,
      individualNote: Boolean(raw.individual_note),
      notes: mappedNotes,
      resolvable: isDiscussionResolvable,
      resolved,
      repliable,
    });
  }

  return result;
}
