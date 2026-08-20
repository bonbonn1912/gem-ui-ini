import { z } from "zod";

import {
  AppErrorSchema,
  EntityIdSchema,
  IsoTimestampSchema,
  JsonValueSchema,
} from "./common";

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

const UserMessageEventSchema = z
  .object({
    type: z.literal("message.user"),
    messageId: EntityIdSchema,
    text: z.string().max(200_000),
    attachmentIds: z.array(EntityIdSchema).max(4),
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

const UsageUpdatedEventSchema = z
  .object({
    type: z.literal("usage.updated"),
    inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(),
    totalTokens: z.int().nonnegative().nullable(),
    used: z.int().nonnegative().nullable().optional(),
    size: z.int().nonnegative().nullable().optional(),
  })
  .strict();

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

export type PermissionOption = z.infer<typeof PermissionOptionSchema>;
export type AvailableCommand = z.infer<typeof AvailableCommandSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type StreamEnvelope = z.infer<typeof StreamEnvelopeSchema>;
