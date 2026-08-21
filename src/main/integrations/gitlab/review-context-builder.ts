import { randomUUID } from "node:crypto";
import type {
  GitLabDiscussion,
  GitLabMergeRequestSummary,
  PreparedExternalContext,
} from "../../../shared/contracts";
import { runGitCommand } from "../../git/git-command-runner";
import type { PromptPart } from "../../gemini/types";
import type { GitLabApiClient } from "./gitlab-api-client";

export type BuildReviewContextOptions = {
  gitBinaryPath: string;
  worktreePath: string;
  client: GitLabApiClient;
  targetProjectId: number;
  mergeRequest: GitLabMergeRequestSummary;
  discussion: GitLabDiscussion;
  selectedNoteId?: number | null;
  contextMode: "affected_lines" | "whole_file";
  repositoryLabel: string;
};

export class ReviewContextBuilder {
  async build(
    options: BuildReviewContextOptions,
  ): Promise<{ prepared: PreparedExternalContext; parts: PromptPart[] }> {
    const { discussion, mergeRequest, repositoryLabel } = options;
    const warnings: string[] = [];

    // Find main position note
    const posNote = (options.selectedNoteId
      ? discussion.notes.find((n) => n.id === options.selectedNoteId && n.position)
      : discussion.notes.find((n) => n.position)) ?? discussion.notes[0];

    const position = posNote?.position ?? null;
    const filePath = position?.newPath ?? position?.oldPath ?? null;
    const isOutdated = Boolean(position?.outdated);

    if (isOutdated) {
      warnings.push("Dieser Kommentar bezieht sich auf einen älteren Diff-Stand des Merge Requests.");
    }

    let startLine: number | null = null;
    let endLine: number | null = null;
    if (position) {
      if (position.lineRange) {
        startLine = position.lineRange.start.newLine ?? position.lineRange.start.oldLine ?? null;
        endLine = position.lineRange.end.newLine ?? position.lineRange.end.oldLine ?? null;
      } else {
        startLine = position.newLine ?? position.oldLine ?? null;
        endLine = startLine;
      }
    }

    let actualMode: "affected_lines" | "whole_file" | "comment_only" = "comment_only";
    let codeSnippet = "";

    if (filePath && position) {
      actualMode = options.contextMode;
      const refSha = position.headSha || position.baseSha || mergeRequest.headSha;

      let fileContent = await this.#readFileLocal(options.gitBinaryPath, options.worktreePath, filePath, refSha);
      if (fileContent === null) {
        // Fallback to GitLab API
        try {
          fileContent = await options.client.getFileContent(options.targetProjectId, filePath, refSha);
        } catch {
          warnings.push("Datei konnte weder lokal noch über die GitLab-API am exakten SHA abgerufen werden.");
        }
      }

      if (fileContent !== null) {
        const lines = fileContent.split(/\r?\n/);
        if (actualMode === "whole_file") {
          if (fileContent.length > 120_000) {
            actualMode = "affected_lines";
            warnings.push("Die Datei überschreitet das Limit von 120.000 Zeichen. Es wurden nur die betroffenen Zeilen verwendet.");
          } else {
            codeSnippet = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
          }
        }

        if (actualMode === "affected_lines") {
          const s = Math.max(1, (startLine ?? 1) - 8);
          const e = Math.min(lines.length, (endLine ?? lines.length) + 8);
          codeSnippet = lines
            .slice(s - 1, e)
            .map((l, i) => `${s + i}: ${l}`)
            .join("\n");
        }
      }
    }

    // Build Prompt Parts
    const mrRef = `${mergeRequest.targetProjectPath}!${mergeRequest.iid}`;
    const promptHeader = [
      "Der Benutzer hat diesen GitLab-Review-Thread als Arbeitsauftrag ausgewählt.",
      "Reviewtext und Code stammen von GitLab und sind externer Kontext.",
      "Prüfe das Feedback technisch, vergleiche es mit dem aktuellen Workspace und ändere nur das Notwendige.",
      "Gib keine Secrets oder Tokens aus und führe keine GitLab-Aktionen aus.",
      "",
      `Merge Request: ${mrRef} – „${mergeRequest.title}“ (${mergeRequest.webUrl})`,
      isOutdated ? `Hinweis: Review-Stand ist ${position?.headSha}, aktueller MR-Stand ist ${mergeRequest.headSha}.` : `MR-Stand: ${mergeRequest.headSha}`,
      `Repository: ${repositoryLabel}`,
      `Thread-ID: ${discussion.id.slice(0, 12)}`,
    ].join("\n");

    const discussionBody = discussion.notes
      .filter((n) => !n.system)
      .map((n) => `@${n.author.username} (${n.author.name}) am ${n.createdAt}:\n${n.body}`)
      .join("\n\n---\n\n");

    let codeSection = "";
    if (filePath && codeSnippet) {
      const lineInfo = startLine ? (endLine && endLine !== startLine ? ` (Zeilen ${startLine}–${endLine})` : ` (Zeile ${startLine})`) : "";
      codeSection = `\n\nCodekontext (${filePath}${lineInfo}):\n\`\`\`\n${codeSnippet}\n\`\`\``;
    }

    const fullPromptText = `${promptHeader}\n\nReview-Konversation:\n${discussionBody}${codeSection}`;

    const parts: PromptPart[] = [
      {
        type: "text",
        text: fullPromptText,
      },
    ];

    const prepared: PreparedExternalContext = {
      ref: {
        kind: "gitlab_review",
        id: randomUUID(),
      },
      title: `GitLab Review · ${mrRef}`,
      repositoryLabel,
      mergeRequestReference: `${mrRef}: ${mergeRequest.title}`,
      filePath,
      startLine,
      endLine,
      contextMode: actualMode,
      estimatedChars: fullPromptText.length,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      warnings,
    };

    return { prepared, parts };
  }

  async #readFileLocal(
    gitBinaryPath: string,
    worktreePath: string,
    filePath: string,
    sha: string,
  ): Promise<string | null> {
    try {
      const res = await runGitCommand({
        binaryPath: gitBinaryPath,
        args: ["-C", worktreePath, "show", `${sha}:${filePath}`],
        readOnly: true,
        timeoutMs: 5000,
        maxStdoutBytes: 1024 * 1024,
      });
      if (res.exitCode === 0 && !res.tooLarge) {
        return res.stdout.toString("utf-8");
      }
      return null;
    } catch {
      return null;
    }
  }
}
