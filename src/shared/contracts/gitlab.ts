import { z } from "zod";

import {
  ClientRequestIdSchema,
  DisplayNameSchema,
  EntityIdSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
  RootRevisionSchema,
  ShaSchema,
} from "./common";

export const GitLabRepoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((val) => !val.includes("\0") && !val.startsWith("/") && !val.split("/").includes(".."), {
    message: "Invalid repository-relative path",
  });

export const GitLabAccessModeSchema = z.enum([
  "read_only",
  "read_write",
  "unknown",
  "reauthentication_required",
]);

export const GitLabUserSummarySchema = z
  .object({
    id: z.number().int().positive(),
    username: z.string().trim().min(1).max(255),
    name: z.string().trim().min(1).max(255),
    avatarUrl: HttpsUrlSchema.nullable().optional(),
  })
  .strict();

export const GitLabConnectionSummarySchema = z
  .object({
    id: EntityIdSchema,
    instanceUrl: HttpsUrlSchema,
    apiBaseUrl: HttpsUrlSchema,
    user: GitLabUserSummarySchema,
    tokenConfigured: z.literal(true),
    access: GitLabAccessModeSchema,
    scopes: z.array(z.string().trim().min(1).max(100)).max(50),
    expiresAt: IsoTimestampSchema.nullable(),
    lastValidatedAt: IsoTimestampSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export const SaveGitLabConnectionInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    instanceUrl: z.string().trim().min(1).max(2048),
    token: z.string().trim().min(1).max(1000),
  })
  .strict();

export const TestGitLabConnectionInputSchema = z
  .object({
    instanceUrl: z.string().trim().min(1).max(2048),
    token: z.string().trim().min(1).max(1000),
  })
  .strict();

export const ReplaceGitLabTokenInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    connectionId: EntityIdSchema,
    token: z.string().trim().min(1).max(1000),
  })
  .strict();

export const RemoveGitLabConnectionInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    connectionId: EntityIdSchema,
    forceDisableBindings: z.boolean().default(false),
  })
  .strict();

export const GitLabRepositoryBindingSchema = z
  .object({
    id: EntityIdSchema,
    projectId: EntityIdSchema,
    rootId: EntityIdSchema,
    connectionId: EntityIdSchema,
    repositoryKey: ShaSchema,
    remoteName: z.string().trim().min(1).max(255),
    remoteUrl: z.string().trim().min(1).max(2048),
    sourceProjectId: z.number().int().positive(),
    sourceProjectPath: z.string().trim().min(1).max(1024),
    enabled: z.boolean(),
    selectedTargetProjectId: z.number().int().positive().nullable(),
    selectedTargetProjectPath: z.string().trim().min(1).max(1024).nullable(),
    selectedMergeRequestIid: z.number().int().positive().nullable(),
    lastSyncedAt: IsoTimestampSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export const GitLabRepositoryCandidateRemoteSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    url: z.string().trim().min(1).max(2048),
    suggestedInstanceUrl: HttpsUrlSchema.nullable(),
    suggestedProjectPath: z.string().trim().max(1024).nullable(),
  })
  .strict();

export const GitLabRepositoryCandidateSchema = z
  .object({
    candidateId: ShaSchema,
    rootIds: z.array(EntityIdSchema).min(1).max(6),
    displayName: DisplayNameSchema,
    branch: z.string().trim().max(1024).nullable(),
    headSha: ShaSchema.nullable(),
    remotes: z.array(GitLabRepositoryCandidateRemoteSchema).max(20),
    binding: GitLabRepositoryBindingSchema.nullable(),
  })
  .strict();

export const ListGitLabRepositoryCandidatesInputSchema = z
  .object({
    projectId: EntityIdSchema,
  })
  .strict();

export const EnableGitLabBindingInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    rootId: EntityIdSchema,
    repositoryKey: ShaSchema,
    connectionId: EntityIdSchema,
    remoteName: z.string().trim().min(1).max(255),
    remoteUrl: z.string().trim().min(1).max(2048),
    sourceProjectId: z.number().int().positive(),
    sourceProjectPath: z.string().trim().min(1).max(1024),
  })
  .strict();

export const DisableGitLabBindingInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    bindingId: EntityIdSchema,
  })
  .strict();

export const GitLabMergeRequestSummarySchema = z
  .object({
    targetProjectId: z.number().int().positive(),
    targetProjectPath: z.string().trim().min(1).max(1024),
    iid: z.number().int().positive(),
    title: z.string().trim().min(1).max(1000),
    webUrl: HttpsUrlSchema,
    state: z.enum(["opened", "closed", "locked", "merged"]),
    draft: z.boolean(),
    sourceBranch: z.string().trim().max(1024),
    targetBranch: z.string().trim().max(1024),
    sourceProjectId: z.number().int().positive(),
    headSha: ShaSchema,
    baseSha: ShaSchema.nullable(),
    startSha: ShaSchema.nullable(),
    author: GitLabUserSummarySchema,
    unresolvedCount: z.number().int().nonnegative(),
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export const ListGitLabMergeRequestsInputSchema = z
  .object({
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    bindingId: EntityIdSchema,
  })
  .strict();

export const SelectGitLabMergeRequestInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    bindingId: EntityIdSchema,
    targetProjectId: z.number().int().positive(),
    targetProjectPath: z.string().trim().min(1).max(1024),
    mergeRequestIid: z.number().int().positive(),
  })
  .strict();

export const ConnectGitLabMergeRequestUrlInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    bindingId: EntityIdSchema,
    mergeRequestUrl: z.string().trim().min(1).max(2048),
  })
  .strict();

export const GitLabLineRangeSchema = z
  .object({
    start: z.object({
      lineCode: z.string().trim().max(255).nullable().optional(),
      type: z.enum(["new", "old"]).nullable().optional(),
      oldLine: z.number().int().positive().nullable().optional(),
      newLine: z.number().int().positive().nullable().optional(),
    }).strict(),
    end: z.object({
      lineCode: z.string().trim().max(255).nullable().optional(),
      type: z.enum(["new", "old"]).nullable().optional(),
      oldLine: z.number().int().positive().nullable().optional(),
      newLine: z.number().int().positive().nullable().optional(),
    }).strict(),
  })
  .strict();

export const GitLabDiffPositionSchema = z
  .object({
    positionType: z.enum(["text", "image", "file"]),
    baseSha: ShaSchema,
    startSha: ShaSchema,
    headSha: ShaSchema,
    oldPath: GitLabRepoPathSchema.nullable(),
    newPath: GitLabRepoPathSchema.nullable(),
    oldLine: z.number().int().positive().nullable(),
    newLine: z.number().int().positive().nullable(),
    lineRange: GitLabLineRangeSchema.nullable(),
    outdated: z.boolean(),
  })
  .strict();

export const GitLabDiscussionNoteSchema = z
  .object({
    id: z.number().int().positive(),
    type: z.enum(["DiffNote", "DiscussionNote", "Note", "unknown"]),
    body: z.string().max(100_000),
    author: GitLabUserSummarySchema,
    system: z.boolean(),
    resolvable: z.boolean(),
    resolved: z.boolean(),
    resolvedBy: GitLabUserSummarySchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    position: GitLabDiffPositionSchema.nullable(),
  })
  .strict();

export const GitLabDiscussionSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    individualNote: z.boolean(),
    notes: z.array(GitLabDiscussionNoteSchema).min(1).max(500),
    resolvable: z.boolean(),
    resolved: z.boolean(),
  })
  .strict();

export const GitLabReviewStateSchema = z
  .object({
    projectId: EntityIdSchema,
    bindingId: EntityIdSchema,
    repositoryDisplayName: DisplayNameSchema,
    connection: GitLabConnectionSummarySchema,
    binding: GitLabRepositoryBindingSchema,
    mergeRequest: GitLabMergeRequestSummarySchema.nullable(),
    discussions: z.array(GitLabDiscussionSchema).max(2000),
    totalDiscussionsCount: z.number().int().nonnegative(),
    unresolvedDiscussionsCount: z.number().int().nonnegative(),
    lastRefreshedAt: IsoTimestampSchema,
  })
  .strict();

export const GetGitLabReviewStateInputSchema = z
  .object({
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    bindingId: EntityIdSchema,
  })
  .strict();

export const SubscribeGitLabReviewStateInputSchema = z
  .object({
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    bindingId: EntityIdSchema,
  })
  .strict();

export const UnsubscribeGitLabReviewStateInputSchema = z
  .object({
    subscriptionId: EntityIdSchema,
  })
  .strict();

export const GitLabReviewStateSubscriptionResultSchema = z
  .object({
    subscriptionId: EntityIdSchema,
    initial: GitLabReviewStateSchema,
  })
  .strict();

export const GitLabReviewStatePushSchema = z
  .object({
    subscriptionId: EntityIdSchema,
    state: GitLabReviewStateSchema,
  })
  .strict();

export const ResolveGitLabDiscussionInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    bindingId: EntityIdSchema,
    targetProjectId: z.number().int().positive(),
    mergeRequestIid: z.number().int().positive(),
    discussionId: z.string().trim().min(1).max(255),
    resolved: z.boolean(),
  })
  .strict();

export const ReplyToGitLabDiscussionInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    bindingId: EntityIdSchema,
    targetProjectId: z.number().int().positive(),
    mergeRequestIid: z.number().int().positive(),
    discussionId: z.string().trim().min(1).max(255),
    body: z.string().trim().min(1).max(100_000),
  })
  .strict();

export const PrepareGitLabReviewContextInputSchema = z
  .object({
    projectId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    bindingId: EntityIdSchema,
    targetProjectId: z.number().int().positive(),
    mergeRequestIid: z.number().int().positive(),
    discussionId: z.string().trim().min(1).max(255),
    selectedNoteId: z.number().int().positive().nullable().optional(),
    contextMode: z.enum(["affected_lines", "whole_file"]),
  })
  .strict();

export const PreparedExternalContextSchema = z
  .object({
    ref: z.object({
      kind: z.literal("gitlab_review"),
      id: EntityIdSchema,
    }).strict(),
    title: z.string().max(500),
    repositoryLabel: z.string().max(200),
    mergeRequestReference: z.string().max(1200),
    filePath: GitLabRepoPathSchema.nullable(),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
    contextMode: z.enum(["affected_lines", "whole_file", "comment_only"]),
    estimatedChars: z.number().int().nonnegative(),
    expiresAt: IsoTimestampSchema,
    warnings: z.array(z.string().max(500)).max(20),
  })
  .strict();

export const IntegrationKindSchema = z.enum(["gitlab"]);

export const IntegrationDescriptorSchema = z
  .object({
    kind: IntegrationKindSchema,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(500),
    icon: z.literal("gitlab"),
    scope: z.literal("repository"),
    defaultEnabled: z.literal(false),
  })
  .strict();

export const ProjectIntegrationStatusSchema = z
  .object({
    kind: IntegrationKindSchema,
    enabled: z.boolean(),
    activeBindingsCount: z.number().int().nonnegative(),
    totalBindingsCount: z.number().int().nonnegative(),
  })
  .strict();

export const ListProjectIntegrationsInputSchema = z
  .object({
    projectId: EntityIdSchema,
  })
  .strict();

export type GitLabAccessMode = z.infer<typeof GitLabAccessModeSchema>;
export type GitLabUserSummary = z.infer<typeof GitLabUserSummarySchema>;
export type GitLabConnectionSummary = z.infer<typeof GitLabConnectionSummarySchema>;
export type SaveGitLabConnectionInput = z.input<typeof SaveGitLabConnectionInputSchema>;
export type TestGitLabConnectionInput = z.input<typeof TestGitLabConnectionInputSchema>;
export type ReplaceGitLabTokenInput = z.input<typeof ReplaceGitLabTokenInputSchema>;
export type RemoveGitLabConnectionInput = z.input<typeof RemoveGitLabConnectionInputSchema>;
export type GitLabRepositoryBinding = z.infer<typeof GitLabRepositoryBindingSchema>;
export type GitLabRepositoryCandidateRemote = z.infer<typeof GitLabRepositoryCandidateRemoteSchema>;
export type GitLabRepositoryCandidate = z.infer<typeof GitLabRepositoryCandidateSchema>;
export type ListGitLabRepositoryCandidatesInput = z.input<typeof ListGitLabRepositoryCandidatesInputSchema>;
export type EnableGitLabBindingInput = z.input<typeof EnableGitLabBindingInputSchema>;
export type DisableGitLabBindingInput = z.input<typeof DisableGitLabBindingInputSchema>;
export type GitLabMergeRequestSummary = z.infer<typeof GitLabMergeRequestSummarySchema>;
export type ListGitLabMergeRequestsInput = z.input<typeof ListGitLabMergeRequestsInputSchema>;
export type SelectGitLabMergeRequestInput = z.input<typeof SelectGitLabMergeRequestInputSchema>;
export type ConnectGitLabMergeRequestUrlInput = z.input<typeof ConnectGitLabMergeRequestUrlInputSchema>;
export type GitLabLineRange = z.infer<typeof GitLabLineRangeSchema>;
export type GitLabDiffPosition = z.infer<typeof GitLabDiffPositionSchema>;
export type GitLabDiscussionNote = z.infer<typeof GitLabDiscussionNoteSchema>;
export type GitLabDiscussion = z.infer<typeof GitLabDiscussionSchema>;
export type GitLabReviewState = z.infer<typeof GitLabReviewStateSchema>;
export type GetGitLabReviewStateInput = z.input<typeof GetGitLabReviewStateInputSchema>;
export type SubscribeGitLabReviewStateInput = z.input<typeof SubscribeGitLabReviewStateInputSchema>;
export type UnsubscribeGitLabReviewStateInput = z.input<typeof UnsubscribeGitLabReviewStateInputSchema>;
export type GitLabReviewStateSubscriptionResult = z.infer<typeof GitLabReviewStateSubscriptionResultSchema>;
export type GitLabReviewStatePush = z.infer<typeof GitLabReviewStatePushSchema>;
export type ResolveGitLabDiscussionInput = z.input<typeof ResolveGitLabDiscussionInputSchema>;
export type ReplyToGitLabDiscussionInput = z.input<typeof ReplyToGitLabDiscussionInputSchema>;
export type PrepareGitLabReviewContextInput = z.input<typeof PrepareGitLabReviewContextInputSchema>;
export type PreparedExternalContext = z.infer<typeof PreparedExternalContextSchema>;
export type IntegrationKind = z.infer<typeof IntegrationKindSchema>;
export type IntegrationDescriptor = z.infer<typeof IntegrationDescriptorSchema>;
export type ProjectIntegrationStatus = z.infer<typeof ProjectIntegrationStatusSchema>;
export type ListProjectIntegrationsInput = z.input<typeof ListProjectIntegrationsInputSchema>;
