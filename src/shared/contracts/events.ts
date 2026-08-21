import { z } from "zod";

import {
  AppErrorSchema,
  EntityIdSchema,
  IsoTimestampSchema,
  JsonValueSchema,
} from "./common";
import {
  ContextAttachmentKindSchema,
  MAX_CONTEXT_ATTACHMENTS_PER_PROMPT,
} from "./context-attachments";
import { DisplayNameSchema } from "./common";
import {
  MAX_PROJECT_FILE_REFERENCES_PER_PROMPT,
  ProjectFilePromptSnapshotSchema,
} from "./project-files";

const SessionStartedEventSchema = z
  .object({
    type: z.literal("session.started"),
    providerSessionId: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

const SessionReadyEventSchema = z
  .object({
    type: z.literal("session.ready"),
    modes: z.array(z.string().trim().min(1).max(100)),
    models: z.array(z.string().trim().min(1).max(200)),
  })
  .strict();

export const ExternalPromptContextSnapshotSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("gitlab_review"),
    id: EntityIdSchema,
    title: z.string().max(500),
    repositoryLabel: z.string().max(200),
    mergeRequestReference: z.string().max(1200),
    filePath: z.string().max(1024).nullable(),
    startLine: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
    contextMode: z.enum(["affected_lines", "whole_file", "comment_only"]),
  }).strict(),
]);

const UserMessageEventSchema = z
  .object({
    type: z.literal("message.user"),
    messageId: EntityIdSchema,
    text: z.string().max(200_000),
    attachmentIds: z.array(EntityIdSchema).max(4),
    contextAttachments: z.array(z.object({
      id: EntityIdSchema,
      kind: ContextAttachmentKindSchema,
      title: DisplayNameSchema,
    }).strict()).max(MAX_CONTEXT_ATTACHMENTS_PER_PROMPT).optional().default([]),
    externalContexts: z
      .array(ExternalPromptContextSnapshotSchema)
      .max(5)
      .optional()
      .default([]),
  })
  .strict();

const AssistantDeltaEventSchema = z
  .object({
    type: z.literal("message.assistant.delta"),
    messageId: EntityIdSchema,
    delta: z.string().min(1).max(1_000_000),
  })
  .strict();

const ThoughtDeltaEventSchema = z
  .object({
    type: z.literal("message.thought.delta"),
    messageId: EntityIdSchema,
    delta: z.string().min(1).max(1_000_000),
  })
  .strict();

const ToolStartedEventSchema = z
  .object({
    type: z.literal("tool.started"),
    toolCallId: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(500),
    kind: z.string().trim().min(1).max(100).nullable(),
    arguments: JsonValueSchema.nullable(),
  })
  .strict();

const ToolUpdatedEventSchema = z
  .object({
    type: z.literal("tool.updated"),
    toolCallId: z.string().trim().min(1).max(500),
    status: z.string().trim().min(1).max(100),
    update: JsonValueSchema.nullable(),
  })
  .strict();

const ToolCompletedEventSchema = z
  .object({
    type: z.literal("tool.completed"),
    toolCallId: z.string().trim().min(1).max(500),
    result: JsonValueSchema.nullable(),
  })
  .strict();

const ToolFailedEventSchema = z
  .object({
    type: z.literal("tool.failed"),
    toolCallId: z.string().trim().min(1).max(500),
    error: AppErrorSchema,
  })
  .strict();

export const PermissionOptionSchema = z
  .object({
    optionId: z.string().trim().min(1).max(500),
    label: z.string().trim().min(1).max(500),
    kind: z.string().trim().min(1).max(100).nullable(),
  })
  .strict();

const PermissionRequestedEventSchema = z
  .object({
    type: z.literal("permission.requested"),
    requestId: z.string().trim().min(1).max(500),
    toolCallId: z.string().trim().min(1).max(500).nullable(),
    title: z.string().trim().min(1).max(1_000),
    options: z.array(PermissionOptionSchema).min(1).max(20),
  })
  .strict();

const PermissionResolvedEventSchema = z
  .object({
    type: z.literal("permission.resolved"),
    requestId: z.string().trim().min(1).max(500),
    optionId: z.string().trim().min(1).max(500),
  })
  .strict();

const TokenCountSchema = z.int().nonnegative().nullable();

/**
 * Token counters. `totalKind` states whether the provider reported the total or
 * whether GeminUI derived it from input + output, so the UI never presents a
 * derived value as an authoritative one.
 */
export const TokenCountersSchema = z
  .object({
    input: TokenCountSchema,
    output: TokenCountSchema,
    total: TokenCountSchema,
    thought: TokenCountSchema,
    cachedRead: TokenCountSchema,
    cachedWrite: TokenCountSchema,
    tool: TokenCountSchema,
    totalKind: z.enum(["provider", "derived_input_plus_output"]).nullable(),
  })
  .strict();

export const ModelTokenUsageSchema = z
  .object({
    model: z.string().trim().min(1).max(200),
    input: z.int().nonnegative(),
    output: z.int().nonnegative(),
  })
  .strict();

/**
 * One complete usage snapshot instead of an ambiguous flat patch.
 *
 * Consumption (`lastTurn`, `session`) and context-window occupancy (`context`)
 * are kept strictly apart: a context update must never overwrite the session
 * token counters, and `context.used` is never a consumption value.
 */
export const UsageSnapshotSchema = z
  .object({
    revision: z.int().nonnegative(),
    lastTurn: z
      .object({
        turnId: z.string().trim().min(1).max(200),
        tokens: TokenCountersSchema,
        byModel: z.array(ModelTokenUsageSchema).max(50),
        source: z.enum(["acp_prompt_usage", "gemini_meta_quota", "legacy_event"]),
      })
      .strict()
      .nullable(),
    session: z
      .object({
        tokens: TokenCountersSchema,
        coverage: z.enum(["complete", "partial", "provider_reported"]),
        source: z.enum(["geminui_aggregate", "acp_prompt_usage", "legacy_event"]),
      })
      .strict()
      .nullable(),
    context: z
      .object({
        used: z.int().nonnegative(),
        size: z.int().positive(),
        source: z.enum(["acp_usage_update", "legacy_event"]),
      })
      .strict()
      .nullable(),
    cost: z
      .object({
        amount: z.number().finite().nonnegative(),
        currency: z.string().trim().regex(/^[A-Z]{3}$/),
        source: z.enum(["acp_usage_update", "legacy_event"]),
      })
      .strict()
      .nullable(),
    updatedAt: IsoTimestampSchema,
  })
  .strict();

const UsageUpdatedEventSchema = z
  .object({
    type: z.literal("usage.updated"),
    snapshot: UsageSnapshotSchema,
  })
  .strict();

const EMPTY_COUNTERS: TokenCounters = {
  input: null,
  output: null,
  total: null,
  thought: null,
  cachedRead: null,
  cachedWrite: null,
  tool: null,
  totalKind: null,
};

/**
 * Reads a `usage.updated` row written before the snapshot contract existed.
 *
 * The legacy event mixed two meanings in one object. It is therefore split
 * conservatively: `used`/`size` become context only, the token counters become
 * a session value explicitly marked `legacy_event`/`partial`. Old rows also
 * copied `used` into `totalTokens`, so that value is never treated as
 * consumption when a context pair is present.
 */
export function migrateLegacyUsageEvent(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const legacy = value as Record<string, unknown>;
  if (legacy.type !== "usage.updated" || "snapshot" in legacy) return value;

  const count = (candidate: unknown): number | null =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : null;

  const used = count(legacy.used);
  const size = count(legacy.size);
  const hasContext = used !== null && size !== null && size > 0;
  const input = count(legacy.inputTokens);
  const output = count(legacy.outputTokens);
  const total = hasContext ? null : count(legacy.totalTokens);
  const hasTokens = input !== null || output !== null || total !== null;

  return {
    type: "usage.updated",
    snapshot: {
      revision: 0,
      lastTurn: null,
      session: hasTokens
        ? {
            tokens: {
              ...EMPTY_COUNTERS,
              input,
              output,
              total: total ?? (input !== null && output !== null ? input + output : null),
              totalKind:
                total !== null
                  ? "provider"
                  : input !== null && output !== null
                    ? "derived_input_plus_output"
                    : null,
            },
            coverage: "partial",
            source: "legacy_event",
          }
        : null,
      context: hasContext ? { used, size, source: "legacy_event" } : null,
      cost: null,
      updatedAt: new Date(0).toISOString(),
    },
  };
}

export const AvailableCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(2_000).nullable(),
  })
  .strict();

const CommandsUpdatedEventSchema = z
  .object({
    type: z.literal("commands.updated"),
    commands: z.array(AvailableCommandSchema).max(500),
  })
  .strict();

const TurnCompletedEventSchema = z
  .object({
    type: z.literal("turn.completed"),
    stopReason: z.string().trim().min(1).max(100),
  })
  .strict();

const TurnCancelledEventSchema = z
  .object({
    type: z.literal("turn.cancelled"),
    reason: z.string().trim().min(1).max(1_000).nullable(),
  })
  .strict();

const TurnFailedEventSchema = z
  .object({
    type: z.literal("turn.failed"),
    error: AppErrorSchema,
  })
  .strict();

const ProcessDisconnectedEventSchema = z
  .object({
    type: z.literal("process.disconnected"),
    reason: z.string().trim().min(1).max(2_000),
    exitCode: z.int().nullable(),
  })
  .strict();

export const AgentEventSchema = z.discriminatedUnion("type", [
  SessionStartedEventSchema,
  SessionReadyEventSchema,
  UserMessageEventSchema,
  AssistantDeltaEventSchema,
  ThoughtDeltaEventSchema,
  ToolStartedEventSchema,
  ToolUpdatedEventSchema,
  ToolCompletedEventSchema,
  ToolFailedEventSchema,
  PermissionRequestedEventSchema,
  PermissionResolvedEventSchema,
  UsageUpdatedEventSchema,
  CommandsUpdatedEventSchema,
  TurnCompletedEventSchema,
  TurnCancelledEventSchema,
  TurnFailedEventSchema,
  ProcessDisconnectedEventSchema,
]);

export const StreamEnvelopeSchema = z
  .object({
    seq: z.int().positive(),
    sessionId: EntityIdSchema,
    turnId: EntityIdSchema.nullable(),
    event: AgentEventSchema,
    timestamp: IsoTimestampSchema,
  })
  .strict();

export const StreamEnvelopeBatchSchema = z
  .array(StreamEnvelopeSchema)
  .max(1_000);

export type TokenCounters = z.infer<typeof TokenCountersSchema>;
export type ModelTokenUsage = z.infer<typeof ModelTokenUsageSchema>;
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
export type PermissionOption = z.infer<typeof PermissionOptionSchema>;
export type AvailableCommand = z.infer<typeof AvailableCommandSchema>;
export type ExternalPromptContextSnapshot = z.infer<typeof ExternalPromptContextSnapshotSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type StreamEnvelope = z.infer<typeof StreamEnvelopeSchema>;
