import type {
  ContentBlock,
  SessionNotification,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

import type {
  NormalizedAgentEvent,
  NormalizedContent,
  NormalizedToolCall,
} from "./types.js";
import { parseUsageUpdate } from "./usage.js";

interface NormalizerContext {
  readonly appSessionId: string;
  readonly providerSessionId: string;
  readonly now?: () => Date;
}

export function normalizeSessionNotification(
  notification: SessionNotification,
  context: NormalizerContext,
): NormalizedAgentEvent[] {
  const update = notification.update;
  const make = <T extends NormalizedAgentEvent["type"]>(
    type: T,
    payload: Extract<NormalizedAgentEvent, { type: T }>["payload"],
  ): Extract<NormalizedAgentEvent, { type: T }> =>
    ({
      type,
      appSessionId: context.appSessionId,
      providerSessionId: context.providerSessionId,
      occurredAt: (context.now?.() ?? new Date()).toISOString(),
      payload,
    }) as Extract<NormalizedAgentEvent, { type: T }>;

  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return [
        make("message.user", {
          content: normalizeContent(update.content),
          ...(update.messageId ? { messageId: update.messageId } : {}),
        }),
      ];
    case "agent_message_chunk":
      return [
        make("message.assistant.delta", {
          content: normalizeContent(update.content),
          ...(update.messageId ? { messageId: update.messageId } : {}),
        }),
      ];
    case "agent_thought_chunk":
      return [
        make("message.thought.delta", {
          content: normalizeContent(update.content),
          ...(update.messageId ? { messageId: update.messageId } : {}),
        }),
      ];
    case "tool_call":
      return [make(toolEventType(update.status, true), { toolCall: normalizeToolCall(update) })];
    case "tool_call_update":
      return [make(toolEventType(update.status, false), { toolCall: normalizeToolCall(update) })];
    case "available_commands_update":
      return [make("commands.updated", { commands: update.availableCommands })];
    case "current_mode_update":
      return [make("mode.updated", { currentModeId: update.currentModeId })];
    case "config_option_update":
      return [make("config.updated", { configOptions: update.configOptions })];
    case "session_info_update":
      return [
        make("session.info.updated", {
          ...(update.title !== undefined ? { title: update.title } : {}),
          ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt } : {}),
        }),
      ];
    case "usage_update": {
      // Context occupancy, never token consumption. Broken values are dropped
      // instead of being forwarded as a plausible looking number.
      const observation = parseUsageUpdate(update);
      return observation ? [make("usage.context.observed", observation)] : [];
    }
    case "plan":
      return [make("plan.updated", { plan: update.entries })];
    case "plan_update":
      return [make("plan.updated", { plan: update.plan })];
    case "plan_removed":
      return [make("plan.removed", { planId: update.planId })];
    default:
      return assertNever(update);
  }
}

export function normalizeContent(content: ContentBlock): NormalizedContent {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return {
        type: "image",
        mimeType: content.mimeType,
        data: content.data,
        ...(content.uri ? { uri: content.uri } : {}),
      };
    case "audio":
      return { type: "audio", mimeType: content.mimeType, data: content.data };
    case "resource_link":
      return {
        type: "resource_link",
        name: content.name,
        uri: content.uri,
        ...(content.mimeType ? { mimeType: content.mimeType } : {}),
        ...(content.size !== undefined && content.size !== null
          ? { size: content.size }
          : {}),
        ...(content.description ? { description: content.description } : {}),
      };
    case "resource":
      return {
        type: "resource",
        resource: content.resource as unknown as Readonly<Record<string, unknown>>,
      };
    default:
      return unreachable(content);
  }
}

export function normalizeToolCall(
  toolCall: ToolCall | ToolCallUpdate,
): NormalizedToolCall {
  return {
    toolCallId: toolCall.toolCallId,
    ...(toolCall.title ? { title: toolCall.title } : {}),
    ...(toolCall.name ? { name: toolCall.name } : {}),
    ...(toolCall.kind ? { kind: toolCall.kind } : {}),
    ...(toolCall.status ? { status: toolCall.status } : {}),
    ...(toolCall.content ? { content: toolCall.content } : {}),
    ...(toolCall.locations ? { locations: toolCall.locations } : {}),
    ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
    ...(toolCall.rawOutput !== undefined ? { rawOutput: toolCall.rawOutput } : {}),
  };
}

function toolEventType(
  status: ToolCall["status"] | ToolCallUpdate["status"],
  initial: boolean,
): "tool.started" | "tool.updated" | "tool.completed" | "tool.failed" {
  if (status === "completed") return "tool.completed";
  if (status === "failed") return "tool.failed";
  return initial ? "tool.started" : "tool.updated";
}

function assertNever(value: never): [] {
  void value;
  return [];
}

function unreachable(value: never): never {
  throw new Error(`Unhandled ACP content block: ${JSON.stringify(value)}`);
}
