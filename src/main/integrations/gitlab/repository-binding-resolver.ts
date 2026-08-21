import crypto from "node:crypto";
import path from "node:path";
import type {
  GitLabRepositoryBinding,
  GitLabRepositoryCandidate,
} from "../../../shared/contracts";
import { runGitCommand } from "../../git/git-command-runner";
import type { GitLabRepository } from "../../storage";
import { parseGitLabRemoteUrl } from "./remote-url-parser";

type ProjectRootInfo = {
  id: string;
  label: string;
  realPath: string;
};

export type RepositoryDiscoveryOptions = {
  gitBinaryPath: string;
  projectId: string;
  roots: ProjectRootInfo[];
};

export function computeRepositoryKey(toplevel: string, gitDir: string): string {
  const normalizedToplevel = path.resolve(toplevel);
  const normalizedGitDir = path.resolve(gitDir);
  return crypto
    .createHash("sha256")
    .update(`worktree:${normalizedToplevel}\ngitdir:${normalizedGitDir}`)
    .digest("hex");
}

export class RepositoryBindingResolver {
  readonly #gitlabRepository: GitLabRepository;

  constructor(gitlabRepository: GitLabRepository) {
    this.#gitlabRepository = gitlabRepository;
  }

  async discoverCandidates(
    options: RepositoryDiscoveryOptions,
  ): Promise<GitLabRepositoryCandidate[]> {
    const existingBindings = this.#gitlabRepository.listBindingsByProject(options.projectId);
    const existingBindingByKey = new Map<string, GitLabRepositoryBinding>();
    for (const b of existingBindings) {
      existingBindingByKey.set(b.repositoryKey, b);
    }

    const candidateMap = new Map<
      string,
      {
        repositoryKey: string;
        rootIds: string[];
        labels: string[];
        toplevel: string;
        branch: string | null;
        headSha: string | null;
        remotes: Array<{
          name: string;
          url: string;
          suggestedInstanceUrl: string | null;
          suggestedProjectPath: string | null;
        }>;
      }
    >();

    for (const root of options.roots) {
      const gitInfo = await this.#inspectRoot(options.gitBinaryPath, root.realPath);
      if (!gitInfo) continue;

      // Verify toplevel does not escape authorized root
      const rel = path.relative(root.realPath, gitInfo.toplevel);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        // Toplevel is above root, ignore for safety
        continue;
      }

      const repositoryKey = computeRepositoryKey(gitInfo.toplevel, gitInfo.gitDir);
      const existing = candidateMap.get(repositoryKey);

      if (existing) {
        if (!existing.rootIds.includes(root.id)) {
          existing.rootIds.push(root.id);
          existing.labels.push(root.label);
        }
      } else {
        candidateMap.set(repositoryKey, {
          repositoryKey,
          rootIds: [root.id],
          labels: [root.label],
          toplevel: gitInfo.toplevel,
          branch: gitInfo.branch,
          headSha: gitInfo.headSha,
          remotes: gitInfo.remotes,
        });
      }
    }

    const candidates: GitLabRepositoryCandidate[] = [];
    for (const [key, item] of candidateMap.entries()) {
      const binding = existingBindingByKey.get(key) ?? null;
      const displayName = item.labels.join(" / ") || path.basename(item.toplevel);

      candidates.push({
        candidateId: key,
        rootIds: item.rootIds,
        displayName,
        branch: item.branch,
        headSha: item.headSha,
        remotes: item.remotes,
        binding,
      });
    }

    return candidates;
  }

  async #inspectRoot(
    gitBinaryPath: string,
    rootPath: string,
  ): Promise<{
    toplevel: string;
    gitDir: string;
    branch: string | null;
    headSha: string | null;
    remotes: Array<{
      name: string;
      url: string;
      suggestedInstanceUrl: string | null;
      suggestedProjectPath: string | null;
    }>;
  } | null> {
    try {
      const isInside = await runGitCommand({
        binaryPath: gitBinaryPath,
        args: ["-C", rootPath, "rev-parse", "--is-inside-work-tree"],
        readOnly: true,
        timeoutMs: 3000,
      });
      if (isInside.exitCode !== 0 || isInside.stdout.toString().trim() !== "true") {
        return null;
      }

      const toplevelRes = await runGitCommand({
        binaryPath: gitBinaryPath,
        args: ["-C", rootPath, "rev-parse", "--show-toplevel"],
        readOnly: true,
        timeoutMs: 3000,
      });
      if (toplevelRes.exitCode !== 0) return null;
      const toplevel = toplevelRes.stdout.toString().trim();

      const gitDirRes = await runGitCommand({
        binaryPath: gitBinaryPath,
        args: ["-C", rootPath, "rev-parse", "--absolute-git-dir"],
        readOnly: true,
        timeoutMs: 3000,
      });
      const gitDir = gitDirRes.exitCode === 0 ? gitDirRes.stdout.toString().trim() : path.join(toplevel, ".git");

      // Current branch
      const branchRes = await runGitCommand({
        binaryPath: gitBinaryPath,
        args: ["-C", rootPath, "symbolic-ref", "--quiet", "--short", "HEAD"],
        readOnly: true,
        timeoutMs: 3000,
      });
      const branch = branchRes.exitCode === 0 ? branchRes.stdout.toString().trim() || null : null;

      // HEAD SHA
      const shaRes = await runGitCommand({
        binaryPath: gitBinaryPath,
        args: ["-C", rootPath, "rev-parse", "HEAD"],
        readOnly: true,
        timeoutMs: 3000,
      });
      const headSha = shaRes.exitCode === 0 ? shaRes.stdout.toString().trim() || null : null;

      // Remotes
      const remotesRes = await runGitCommand({
        binaryPath: gitBinaryPath,
        args: ["-C", rootPath, "config", "--local", "--get-regexp", "^remote\\..*\\.url$"],
        readOnly: true,
        timeoutMs: 3000,
      });

      const remotes: Array<{
        name: string;
        url: string;
        suggestedInstanceUrl: string | null;
        suggestedProjectPath: string | null;
      }> = [];

      if (remotesRes.exitCode === 0) {
        const lines = remotesRes.stdout.toString().split("\n");
        for (const line of lines) {
          const match = line.trim().match(/^remote\.([^.]+)\.url\s+(.+)$/);
          if (!match) continue;
          const remoteName = match[1]!;
          const rawUrl = match[2]!;
          const parsed = parseGitLabRemoteUrl(rawUrl);

          remotes.push({
            name: remoteName,
            url: parsed?.sanitizedUrl ?? rawUrl,
            suggestedInstanceUrl: parsed?.instanceUrl ?? null,
            suggestedProjectPath: parsed?.projectPath ?? null,
          });
        }
      }

      return {
        toplevel,
        gitDir,
        branch,
        headSha,
        remotes,
      };
    } catch {
      return null;
    }
  }
}
