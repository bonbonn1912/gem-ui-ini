import { z } from "zod";

import {
  ClientRequestIdSchema,
  DisplayNameSchema,
  EntityIdSchema,
  FileSystemPathSchema,
  HttpsUrlSchema,
  IsoTimestampSchema,
  Sha256Schema,
  VoidResultSchema,
} from "./common";

export const MAX_CONTEXT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_CONTEXT_ATTACHMENTS_PER_SCOPE = 50;
export const MAX_CONTEXT_ATTACHMENTS_PER_PROMPT = 20;
export const MAX_CONTEXT_CHARS_PER_ATTACHMENT = 60_000;
export const MAX_CONTEXT_CHARS_TOTAL = 240_000;

export const ContextAttachmentScopeSchema = z.enum(["project", "session"]);
export const ContextAttachmentKindSchema = z.enum(["file", "link"]);
export const ContextAttachmentOriginSchema = z.enum(["manual", "chat"]);
export const ExtractionStateSchema = z.enum([
  "pending",
  "running",
  "ready",
  "empty",
  "unsupported",
  "too_large",
  "failed",
]);
export const LinkPreviewStateSchema = z.enum([
  "pending",
  "ready",
  "unauthorized",
  "blocked",
  "failed",
  "disabled",
]);

export const ContextAttachmentFileSchema = z.object({
  displayName: DisplayNameSchema,
  mimeType: z.string().trim().min(3).max(200),
  size: z.int().positive().max(MAX_CONTEXT_FILE_BYTES),
  sha256: Sha256Schema,
  extractionState: ExtractionStateSchema,
  extractedChars: z.int().nonnegative().nullable(),
  pageCount: z.int().nonnegative().nullable(),
  extractionError: z.string().max(500).nullable(),
  renderable: z.boolean(),
}).strict();

export const ContextAttachmentLinkSchema = z.object({
  url: z.url(),
  host: z.string().trim().min(1).max(300),
  previewState: LinkPreviewStateSchema,
  previewTitle: z.string().max(300).nullable(),
  previewDescription: z.string().max(1_000).nullable(),
  previewSiteName: z.string().max(200).nullable(),
  hasPreviewImage: z.boolean(),
  previewError: z.string().max(500).nullable(),
  fetchedAt: IsoTimestampSchema.nullable(),
}).strict();

export const ContextAttachmentSchema = z.object({
  id: EntityIdSchema,
  projectId: EntityIdSchema,
  scope: ContextAttachmentScopeSchema,
  sessionId: EntityIdSchema.nullable(),
  kind: ContextAttachmentKindSchema,
  origin: ContextAttachmentOriginSchema,
  title: DisplayNameSchema,
  note: z.string().max(2_000).nullable(),
  sortOrder: z.int().nonnegative(),
  includedInContext: z.boolean(),
  estimatedTokens: z.int().nonnegative().nullable(),
  file: ContextAttachmentFileSchema.nullable(),
  link: ContextAttachmentLinkSchema.nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict().superRefine((value, context) => {
  if (
    (value.kind === "file") !== (value.file !== null) ||
    (value.kind === "link") !== (value.link !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "kind must match the populated payload",
      path: [value.kind],
    });
  }
  if (
    (value.scope === "project" && value.sessionId !== null) ||
    (value.scope === "session" && value.sessionId === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "scope must match sessionId",
      path: ["sessionId"],
    });
  }
});

export const ContextAttachmentListSchema = z.object({
  projectId: EntityIdSchema,
  sessionId: EntityIdSchema.nullable(),
  projectAttachments: z.array(ContextAttachmentSchema).max(MAX_CONTEXT_ATTACHMENTS_PER_SCOPE),
  sessionAttachments: z.array(ContextAttachmentSchema).max(MAX_CONTEXT_ATTACHMENTS_PER_SCOPE),
  includedCount: z.int().nonnegative(),
  estimatedTotalTokens: z.int().nonnegative(),
  overBudget: z.boolean(),
}).strict();

export const ContextTargetSchema = z.object({
  projectId: EntityIdSchema,
  scope: ContextAttachmentScopeSchema,
  sessionId: EntityIdSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  if (
    (value.scope === "project" && value.sessionId !== null) ||
    (value.scope === "session" && value.sessionId === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "scope must match sessionId",
      path: ["sessionId"],
    });
  }
});

export const ListContextAttachmentsInputSchema = z.object({
  projectId: EntityIdSchema,
  sessionId: EntityIdSchema.nullable().default(null),
}).strict();

export const AddContextFilesInputSchema = ContextTargetSchema.extend({
  clientRequestId: ClientRequestIdSchema,
  paths: z.array(FileSystemPathSchema).max(20).default([]),
  origin: ContextAttachmentOriginSchema.default("manual"),
}).strict();

export const AddContextLinkInputSchema = ContextTargetSchema.extend({
  clientRequestId: ClientRequestIdSchema,
  url: z.url(),
  title: DisplayNameSchema.optional(),
  origin: ContextAttachmentOriginSchema.default("manual"),
}).strict();

export const UpdateContextAttachmentInputSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  attachmentId: EntityIdSchema,
  title: DisplayNameSchema.optional(),
  note: z.string().max(2_000).nullable().optional(),
  scope: ContextAttachmentScopeSchema.optional(),
  sessionId: EntityIdSchema.nullable().optional(),
  sortOrder: z.int().nonnegative().optional(),
}).strict();

export const SetContextInclusionInputSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  sessionId: EntityIdSchema,
  attachmentIds: z.array(EntityIdSchema).max(100),
  included: z.boolean(),
}).strict();

export const RemoveContextAttachmentInputSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  attachmentId: EntityIdSchema,
}).strict();

export const RefreshLinkPreviewInputSchema = RemoveContextAttachmentInputSchema;

export const ContextAttachmentBytesInputSchema = z.object({
  attachmentId: EntityIdSchema,
  variant: z.enum(["original", "thumbnail", "link_image", "text_excerpt"]),
}).strict();

export const ContextAttachmentSubscriptionResultSchema = z.object({
  subscriptionId: EntityIdSchema,
  list: ContextAttachmentListSchema,
}).strict();

export const ContextAttachmentPushSchema = ContextAttachmentSubscriptionResultSchema;

export const UnsubscribeContextAttachmentsInputSchema = z.object({
  subscriptionId: EntityIdSchema,
}).strict();

export const OpenContextAttachmentInputSchema = z.object({
  attachmentId: EntityIdSchema,
}).strict();

export const OpenLinkPreviewInputSchema = z.union([
  z.object({
    attachmentId: EntityIdSchema,
    url: HttpsUrlSchema.optional(),
  }).strict(),
  z.object({
    attachmentId: EntityIdSchema.optional(),
    url: HttpsUrlSchema,
  }).strict(),
]);

export const LinkPreviewViewStateSchema = z.object({
  attachmentId: EntityIdSchema.nullable().optional(),
  url: HttpsUrlSchema.optional(),
  host: z.string().trim().min(1).max(300),
  loading: z.boolean(),
}).strict();

export const SetLinkPreviewBoundsInputSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative().max(10_000),
  height: z.number().finite().nonnegative().max(10_000),
}).strict();

export const ClearLinkPreviewStorageInputSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
}).strict();

export type ContextAttachmentScope = z.infer<typeof ContextAttachmentScopeSchema>;
export type ContextAttachmentKind = z.infer<typeof ContextAttachmentKindSchema>;
export type ContextAttachmentOrigin = z.infer<typeof ContextAttachmentOriginSchema>;
export type ExtractionState = z.infer<typeof ExtractionStateSchema>;
export type LinkPreviewState = z.infer<typeof LinkPreviewStateSchema>;
export type ContextAttachmentFile = z.infer<typeof ContextAttachmentFileSchema>;
export type ContextAttachmentLink = z.infer<typeof ContextAttachmentLinkSchema>;
export type ContextAttachment = z.infer<typeof ContextAttachmentSchema>;
export type ContextAttachmentList = z.infer<typeof ContextAttachmentListSchema>;
export type ContextTarget = z.input<typeof ContextTargetSchema>;
export type ListContextAttachmentsInput = z.input<typeof ListContextAttachmentsInputSchema>;
export type AddContextFilesInput = z.input<typeof AddContextFilesInputSchema>;
export type AddContextLinkInput = z.input<typeof AddContextLinkInputSchema>;
export type UpdateContextAttachmentInput = z.input<typeof UpdateContextAttachmentInputSchema>;
export type SetContextInclusionInput = z.input<typeof SetContextInclusionInputSchema>;
export type RemoveContextAttachmentInput = z.input<typeof RemoveContextAttachmentInputSchema>;
export type RefreshLinkPreviewInput = z.input<typeof RefreshLinkPreviewInputSchema>;
export type ContextAttachmentBytesInput = z.input<typeof ContextAttachmentBytesInputSchema>;
export type OpenContextAttachmentInput = z.input<typeof OpenContextAttachmentInputSchema>;
export type OpenLinkPreviewInput = z.input<typeof OpenLinkPreviewInputSchema>;
export type LinkPreviewViewState = z.infer<typeof LinkPreviewViewStateSchema>;
export type SetLinkPreviewBoundsInput = z.input<typeof SetLinkPreviewBoundsInputSchema>;
export type ClearLinkPreviewStorageInput = z.input<typeof ClearLinkPreviewStorageInputSchema>;

export { VoidResultSchema };
