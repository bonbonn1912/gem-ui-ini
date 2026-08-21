import type { GitLabMergeRequestSummary } from "../../../shared/contracts";
import type { GitLabApiClient } from "./gitlab-api-client";
import type { RawGitLabMergeRequestSchema } from "./gitlab-api-schemas";
import { z } from "zod";

type RawMR = z.infer<typeof RawGitLabMergeRequestSchema>;

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
    state: raw.state as "opened" | "closed" | "locked" | "merged",
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
      avatarUrl: raw.author.avatar_url ?? null,
    },
    unresolvedCount: raw.user_notes_count ?? 0,
    updatedAt: raw.updated_at,
  };
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
