import { z } from "zod";

import {
  ClientRequestIdSchema,
  DisplayNameSchema,
  EntityIdSchema,
  IsoTimestampSchema,
  RootFingerprintSchema,
  RootRevisionSchema,
} from "./common";
import { MAX_CONTEXT_ATTACHMENTS_PER_PROMPT } from "./context-attachments";
import {
  MAX_PROJECT_FILE_REFERENCES_PER_PROMPT,
  ProjectFileReferenceInputSchema,
} from "./project-files";

export const SessionStatusSchema = z.enum([
  "idle",
  "starting",
  "running",
  "awaiting_permission",
  "cancelling",
  "roots_changed",
  "error",
  "disconnected",
]);

/**
 * One entry of a picker the agent offers for a session — a model or an
 * approval mode. `id` is what travels back over ACP, `name` is what the user
 * reads.
 */
export const SessionOptionSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const AppSessionSchema = z
  .object({
    id: EntityIdSchema,
    provider: z.literal("gemini-cli"),
    providerSessionId: z.string().trim().min(1).max(500).nullable(),
    projectId: EntityIdSchema,
    lastRootRevision: RootRevisionSchema,
    lastRootFingerprint: RootFingerprintSchema,
    title: DisplayNameSchema,
    status: SessionStatusSchema,
    model: z.string().trim().min(1).max(200).nullable(),
    mode: z.string().trim().min(1).max(100).nullable(),
    /**
     * The choices the agent last offered for this session. Cached because an
     * ACP process only starts on demand: without it both pickers would stay
     * empty from app start until the first prompt of every session.
     */
    availableModels: z.array(SessionOptionSchema).max(50).default([]),
    availableModes: z.array(SessionOptionSchema).max(50).default([]),
    pinned: z.boolean(),
    archived: z.boolean(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict();

export const CreateSessionInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    projectId: EntityIdSchema,
    title: DisplayNameSchema.optional(),
  })
  .strict();

export const ListSessionsInputSchema = z
  .object({
    projectId: EntityIdSchema,
    includeArchived: z.boolean().default(false),
  })
  .strict();

export const UpdateSessionInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    sessionId: EntityIdSchema,
    title: DisplayNameSchema.optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    model: z.string().trim().min(1).max(200).nullable().optional(),
    mode: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.title !== undefined ||
      input.pinned !== undefined ||
      input.archived !== undefined ||
      input.model !== undefined ||
      input.mode !== undefined,
    { message: "At least one session field must be updated" },
  );

export const DeleteSessionInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    sessionId: EntityIdSchema,
    deleteProviderHistory: z.boolean().default(false),
  })
  .strict();

export const ExternalPromptContextRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("gitlab_review"),
    id: EntityIdSchema,
  }).strict(),
]);

export const SendPromptInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    sessionId: EntityIdSchema,
    expectedRootRevision: RootRevisionSchema,
    text: z.string().max(200_000),
    attachmentIds: z.array(EntityIdSchema).max(4),
    contextAttachmentIds: z
      .array(EntityIdSchema)
      .max(MAX_CONTEXT_ATTACHMENTS_PER_PROMPT)
      .default([]),
    externalContextRefs: z
      .array(ExternalPromptContextRefSchema)
      .max(5)
      .default([]),
  })
  .strict()
  .refine(
    (input) =>
      input.text.trim().length > 0 ||
      input.attachmentIds.length > 0 ||
      (input.externalContextRefs && input.externalContextRefs.length > 0),
    { message: "A prompt requires text, at least one attachment, or an external context" },
  );

export const CancelTurnInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    sessionId: EntityIdSchema,
    turnId: EntityIdSchema,
  })
  .strict();

export const PermissionResponseSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    sessionId: EntityIdSchema,
    requestId: z.string().trim().min(1).max(500),
    optionId: z.string().trim().min(1).max(500),
  })
  .strict();

export const SetSessionModeInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    sessionId: EntityIdSchema,
    modeId: z.string().trim().min(1).max(100),
  })
  .strict();

export const SetSessionModelInputSchema = z
  .object({
    clientRequestId: ClientRequestIdSchema,
    sessionId: EntityIdSchema,
    modelId: z.string().trim().min(1).max(200),
  })
  .strict();

export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type SessionOption = z.infer<typeof SessionOptionSchema>;
export type AppSession = z.infer<typeof AppSessionSchema>;
export type CreateSessionInput = z.input<typeof CreateSessionInputSchema>;
export type ListSessionsInput = z.input<typeof ListSessionsInputSchema>;
export type UpdateSessionInput = z.input<typeof UpdateSessionInputSchema>;
export type DeleteSessionInput = z.input<typeof DeleteSessionInputSchema>;
export type ExternalPromptContextRef = z.infer<typeof ExternalPromptContextRefSchema>;
export type SendPromptInput = z.input<typeof SendPromptInputSchema>;
export type CancelTurnInput = z.input<typeof CancelTurnInputSchema>;
export type PermissionResponse = z.input<typeof PermissionResponseSchema>;
export type SetSessionModeInput = z.input<typeof SetSessionModeInputSchema>;
export type SetSessionModelInput = z.input<typeof SetSessionModelInputSchema>;
