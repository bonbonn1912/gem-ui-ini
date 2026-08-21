import type {
  GitLabDiffPosition,
  GitLabDiscussion,
  GitLabDiscussionNote,
} from "../../../shared/contracts";
import type { RawGitLabDiscussionSchema } from "./gitlab-api-schemas";
import { z } from "zod";

type RawDiscussion = z.infer<typeof RawGitLabDiscussionSchema>;

export function mapGitLabDiscussions(
  rawDiscussions: RawDiscussion[],
  currentMrHeadSha: string | null,
): GitLabDiscussion[] {
  const result: GitLabDiscussion[] = [];

  for (const raw of rawDiscussions) {
    if (!raw.notes || raw.notes.length === 0) continue;

    const mappedNotes: GitLabDiscussionNote[] = [];
    let isDiscussionResolvable = false;
    let areAllResolvableNotesResolved = true;
    let hasResolvableNotes = false;

    for (const note of raw.notes) {
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
              type: (rawPos.line_range.start?.type as "new" | "old") ?? null,
              oldLine: rawPos.line_range.start?.old_line ?? null,
              newLine: rawPos.line_range.start?.new_line ?? null,
            },
            end: {
              lineCode: rawPos.line_range.end?.line_code ?? null,
              type: (rawPos.line_range.end?.type as "new" | "old") ?? null,
              oldLine: rawPos.line_range.end?.old_line ?? null,
              newLine: rawPos.line_range.end?.new_line ?? null,
            },
          } : null,
          outdated: isOutdated,
        };
      }

      mappedNotes.push({
        id: note.id,
        type: (note.type as "DiffNote" | "DiscussionNote" | "Note") || (mappedPosition ? "DiffNote" : "DiscussionNote"),
        body: note.body,
        author: {
          id: note.author.id,
          username: note.author.username,
          name: note.author.name,
          avatarUrl: note.author.avatar_url ?? null,
        },
        system: isSystem,
        resolvable: isResolvable,
        resolved: isResolved,
        resolvedBy: note.resolved_by ? {
          id: note.resolved_by.id,
          username: note.resolved_by.username,
          name: note.resolved_by.name,
          avatarUrl: note.resolved_by.avatar_url ?? null,
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
    });
  }

  return result;
}
