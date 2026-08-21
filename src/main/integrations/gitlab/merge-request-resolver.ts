import type { GitLabMergeRequestSummary } from "../../../shared/contracts";
import { normalizeAvatarUrl } from "./discussion-mapper";
import type { GitLabApiClient } from "./gitlab-api-client";
import type { RawGitLabMergeRequestSchema } from "./gitlab-api-schemas";
import { z } from "zod";

type RawMR = z.infer<typeof RawGitLabMergeRequestSchema>;

const KNOWN_MR_STATES = ["opened", "closed", "locked", "merged"] as const;

/**
 * GitLab kann künftig weitere States liefern. Ein unbekannter Wert darf nicht
 * die ganze MR-Liste unbrauchbar machen, deshalb wird er durchgereicht statt
 * blind auf die bekannten vier gecastet.
 */
export function normalizeMergeRequestState(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if ((KNOWN_MR_STATES as readonly string[]).includes(trimmed)) return trimmed;
  return trimmed || "opened";
}

export function mapRawMergeRequest(
  raw: RawMR,
  targetProjectPath: string,
): GitLabMergeRequestSummary {
  const isDraft = Boolean(raw.draft || raw.work_in_progress || raw.title.startsWith("Draft:") || raw.title.startsWith("WIP:"));
  return {
    targetProjectId: raw.target_project_id ?? raw.project_id,
    targetProjectPath,
    iid: raw.iid,
    title: raw.title,
    webUrl: raw.web_url,
    state: normalizeMergeRequestState(raw.state),
    draft: isDraft,
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    sourceProjectId: raw.source_project_id ?? raw.project_id,
    headSha: raw.diff_refs?.head_sha ?? raw.sha,
    baseSha: raw.diff_refs?.base_sha ?? null,
    startSha: raw.diff_refs?.start_sha ?? null,
    author: {
      id: raw.author.id,
      username: raw.author.username,
      name: raw.author.name,
      avatarUrl: normalizeAvatarUrl(raw.author.avatar_url),
    },
    unresolvedCount: raw.user_notes_count ?? 0,
    updatedAt: raw.updated_at,
  };
}

/**
 * Sortiert offene Merge Requests so, wie sie im Review-Panel angeboten werden:
 * MRs des aktuell ausgecheckten Branches zuerst, danach die zuletzt
 * aktualisierten. Entwürfe rutschen innerhalb ihrer Gruppe nach unten.
 */
export function sortMergeRequests(
  list: GitLabMergeRequestSummary[],
  currentBranch?: string | null,
): GitLabMergeRequestSummary[] {
  const branch = currentBranch?.trim().toLowerCase() || null;
  const rank = (mr: GitLabMergeRequestSummary) => {
    const onBranch = branch !== null && mr.sourceBranch.toLowerCase() === branch;
    if (onBranch) return mr.draft ? 1 : 0;
    return mr.draft ? 3 : 2;
  };

  return [...list].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byDate =
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (!Number.isNaN(byDate) && byDate !== 0) return byDate;
    return b.iid - a.iid;
  });
}

export class MergeRequestResolver {
  async findMergeRequestsForBranch(
    client: GitLabApiClient,
    sourceProjectId: number,
    sourceProjectPath: string,
    branch: string,
  ): Promise<GitLabMergeRequestSummary[]> {
    const rawList = await client.listMergeRequests(sourceProjectId, {
      sourceBranch: branch,
      state: "opened",
    });

    return rawList.map((raw) => mapRawMergeRequest(raw, sourceProjectPath));
  }

  parseMergeRequestUrl(
    expectedInstanceUrl: string,
    urlStr: string,
  ): { projectPath: string; mergeRequestIid: number } | null {
    try {
      const url = new URL(urlStr.trim());
      const expectedUrl = new URL(expectedInstanceUrl.trim());

      if (url.origin.toLowerCase() !== expectedUrl.origin.toLowerCase()) {
        return null;
      }

      // Format: /group/subgroup/project/-/merge_requests/42 or /group/project/merge_requests/42
      const match = url.pathname.match(/^\/(.+?)(?:\/-)?\/merge_requests\/(\d+)/);
      if (!match) return null;

      const projectPath = match[1]!.replace(/\/+$/, "");
      const mergeRequestIid = parseInt(match[2]!, 10);
      if (isNaN(mergeRequestIid) || mergeRequestIid <= 0) return null;

      return { projectPath, mergeRequestIid };
    } catch {
      return null;
    }
  }

  async resolveMergeRequestByUrl(
    client: GitLabApiClient,
    targetProjectPath: string,
    mergeRequestIid: number,
  ): Promise<GitLabMergeRequestSummary> {
    const project = await client.getProject(targetProjectPath);
    const raw = await client.getMergeRequest(project.id, mergeRequestIid);
    return mapRawMergeRequest(raw, project.path_with_namespace || targetProjectPath);
  }
}
