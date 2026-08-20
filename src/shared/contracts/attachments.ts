import { z } from "zod";

import {
  ClientRequestIdSchema,
  DisplayNameSchema,
  EntityIdSchema,
  FileSystemPathSchema,
  IsoTimestampSchema,
  Sha256Schema,
} from "./common";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENTS = 4;

export const ImageMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export const AttachmentStatusSchema = z.enum(["staged", "sent"]);

export const AttachmentSchema = z
  .object({
    id: EntityIdSchema,
    sessionId: EntityIdSchema.nullable(),
    turnId: EntityIdSchema.nullable().default(null),
    displayName: DisplayNameSchema,
    mimeType: ImageMimeTypeSchema,
    size: z.int().positive().max(MAX_IMAGE_BYTES),
    sha256: Sha256Schema,
    status: AttachmentStatusSchema.default("staged"),
    createdAt: IsoTimestampSchema,
  })
  .strict();

export const PickImagesInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    sessionId: EntityIdSchema.nullable().default(null),
  })
  .strict();

export const StageDroppedPathInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    sessionId: EntityIdSchema.nullable().default(null),
    paths: z.array(FileSystemPathSchema).min(1).max(MAX_PROMPT_ATTACHMENTS),
  })
  .strict();

export const ClipboardImageInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    sessionId: EntityIdSchema.nullable().default(null),
    displayName: DisplayNameSchema,
    mimeType: ImageMimeTypeSchema,
    bytes: z.instanceof(Uint8Array).refine(
      (bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_IMAGE_BYTES,
      `Clipboard image must contain between 1 and ${MAX_IMAGE_BYTES} bytes`,
    ),
  })
  .strict();

export const AttachmentPreviewInputSchema = z
  .object({
    attachmentId: EntityIdSchema,
  })
  .strict();

export const RemoveAttachmentInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    attachmentId: EntityIdSchema,
  })
  .strict();

export type ImageMimeType = z.infer<typeof ImageMimeTypeSchema>;
export type AttachmentStatus = z.infer<typeof AttachmentStatusSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type PickImagesInput = z.input<typeof PickImagesInputSchema>;
export type StageDroppedPathInput = z.input<typeof StageDroppedPathInputSchema>;
export type ClipboardImageInput = z.input<typeof ClipboardImageInputSchema>;
export type AttachmentPreviewInput = z.input<typeof AttachmentPreviewInputSchema>;
export type RemoveAttachmentInput = z.input<typeof RemoveAttachmentInputSchema>;
