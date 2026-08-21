import { z } from "zod";

import {
  EntityIdSchema,
  IsoTimestampSchema,
  RootRevisionSchema,
  Sha256Schema,
} from "./common";

export const MAX_GIT_REPOSITORIES = 6;
export const MAX_GIT_CHANGES = 10_000;
export const MAX_GIT_DIFF_HUNKS = 2_000;
export const MAX_GIT_DIFF_LINES = 50_000;

const GitPathSchema = z.string().min(1).max(32_768).refine(
  (value) => !value.includes("\0"),
  "Git paths must not contain NUL bytes",
);

export const GitAreaSchema = z.enum(["unstaged", "staged"]);
export const GitRepositoryStateSchema = z.enum([
  "ready",
  "not_git",
  "outside_authority",
  "unavailable",
  "error",
]);

export const GitRepositorySummarySchema = z
  .object({
    repositoryId: EntityIdSchema,
    rootIds: z.array(EntityIdSchema).min(1).max(6),
    displayName: z.string().trim().min(1).max(200),
    worktreeLabel: z.string().trim().min(1).max(200),
    branch: z.string().min(1).max(1_024).nullable(),
    headOid: z.string().regex(/^[a-fA-F0-9]{40,64}$/).nullable(),
    upstream: z.string().min(1).max(1_024).nullable(),
    ahead: z.int().nonnegative().max(1_000_000),
    behind: z.int().nonnegative().max(1_000_000),
    state: GitRepositoryStateSchema,
    message: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();

export const GitFileChangeSchema = z
  .object({
    fileId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    path: GitPathSchema,
    previousPath: GitPathSchema.nullable(),
    indexStatus: z.string().length(1),
    worktreeStatus: z.string().length(1),
    conflict: z.boolean(),
    untracked: z.boolean(),
    submodule: z.boolean(),
    renameScore: z.int().min(0).max(100).nullable(),
  })
  .strict();

export const GitProjectStatusSchema = z
  .object({
    projectId: EntityIdSchema,
    rootRevision: RootRevisionSchema,
    refreshedAt: IsoTimestampSchema,
    repositories: z
      .array(GitRepositorySummarySchema)
      .max(MAX_GIT_REPOSITORIES),
    changes: z.array(GitFileChangeSchema).max(MAX_GIT_CHANGES),
  })
  .strict();

export const GitDiffLineSchema = z
  .object({
    kind: z.enum(["context", "addition", "deletion", "no_newline"]),
    content: z.string().max(131_072),
    oldLine: z.int().positive().nullable(),
    newLine: z.int().positive().nullable(),
  })
  .strict();

export const GitDiffHunkSchema = z
  .object({
    hunkId: Sha256Schema,
    header: z.string().max(4_096),
    oldStart: z.int().nonnegative(),
    oldLines: z.int().nonnegative(),
    newStart: z.int().nonnegative(),
    newLines: z.int().nonnegative(),
    lines: z.array(GitDiffLineSchema).max(MAX_GIT_DIFF_LINES),
  })
  .strict();

export const GitFileDiffStateSchema = z.enum([
  "text",
  "binary",
  "submodule",
  "conflict",
  "too_large",
  "unavailable",
  "error",
]);

export const GitFileDiffSchema = z
  .object({
    snapshotId: EntityIdSchema,
    repositoryId: EntityIdSchema,
    fileId: EntityIdSchema,
    area: GitAreaSchema,
    path: GitPathSchema,
    previousPath: GitPathSchema.nullable(),
    state: GitFileDiffStateSchema,
    message: z.string().trim().min(1).max(2_000).nullable(),
    additions: z.int().nonnegative().max(MAX_GIT_DIFF_LINES),
    deletions: z.int().nonnegative().max(MAX_GIT_DIFF_LINES),
    metadata: z.array(z.string().max(4_096)).max(100),
    hunks: z.array(GitDiffHunkSchema).max(MAX_GIT_DIFF_HUNKS),
  })
  .strict()
  .superRefine((diff, context) => {
    const lineCount = diff.hunks.reduce(
      (total, hunk) => total + hunk.lines.length,
      0,
    );
    if (lineCount > MAX_GIT_DIFF_LINES) {
      context.addIssue({
        code: "custom",
        path: ["hunks"],
        message: `A diff may contain at most ${MAX_GIT_DIFF_LINES} lines`,
      });
    }
  });

export const GetGitProjectStatusInputSchema = z
  .object({
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
  })
  .strict();

export const ListGitProjectRepositoriesInputSchema =
  GetGitProjectStatusInputSchema;

export const GitRepositoryListSchema = z
  .object({
    projectId: EntityIdSchema,
    rootRevision: RootRevisionSchema,
    repositories: z
      .array(GitRepositorySummarySchema)
      .max(MAX_GIT_REPOSITORIES),
  })
  .strict();

export const GetGitFileDiffInputSchema = z
  .object({
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    repositoryId: EntityIdSchema,
    fileId: EntityIdSchema,
    area: GitAreaSchema,
  })
  .strict();

export const SubscribeGitProjectStatusInputSchema =
  GetGitProjectStatusInputSchema;

export const UnsubscribeGitProjectStatusInputSchema = z
  .object({ subscriptionId: EntityIdSchema })
  .strict();

export const GitStatusSubscriptionResultSchema = z
  .object({
    subscriptionId: EntityIdSchema,
    status: GitProjectStatusSchema,
  })
  .strict();

export const GitStatusPushSchema = z
  .object({
    subscriptionId: EntityIdSchema,
    status: GitProjectStatusSchema,
  })
  .strict();

export type GitArea = z.infer<typeof GitAreaSchema>;
export type GitRepositoryState = z.infer<typeof GitRepositoryStateSchema>;
export type GitRepositorySummary = z.infer<
  typeof GitRepositorySummarySchema
>;
export type GitFileChange = z.infer<typeof GitFileChangeSchema>;
export type GitProjectStatus = z.infer<typeof GitProjectStatusSchema>;
export type GitDiffLine = z.infer<typeof GitDiffLineSchema>;
export type GitDiffHunk = z.infer<typeof GitDiffHunkSchema>;
export type GitFileDiff = z.infer<typeof GitFileDiffSchema>;
export type GetGitProjectStatusInput = z.input<
  typeof GetGitProjectStatusInputSchema
>;
export type ListGitProjectRepositoriesInput = z.input<
  typeof ListGitProjectRepositoriesInputSchema
>;
export type GetGitFileDiffInput = z.input<typeof GetGitFileDiffInputSchema>;
export type SubscribeGitProjectStatusInput = z.input<
  typeof SubscribeGitProjectStatusInputSchema
>;
export type GitStatusSubscriptionResult = z.infer<
  typeof GitStatusSubscriptionResultSchema
>;
