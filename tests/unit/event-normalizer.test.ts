import { describe, expect, it } from "vitest";

import type { SessionNotification } from "@agentclientprotocol/sdk";

import { normalizeSessionNotification } from "../../src/main/gemini/event-normalizer";

const context = { appSessionId: "app-1", providerSessionId: "provider-1" };

function notification(update: Record<string, unknown>): SessionNotification {
  return { sessionId: "provider-1", update } as unknown as SessionNotification;
}

describe("normalizeSessionNotification", () => {
  it("normalizes the ACP v1 content chunks", () => {
    const events = normalizeSessionNotification(
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
        messageId: "message-1",
      }),
      context,
    );
    expect(events).toMatchObject([
      {
        type: "message.assistant.delta",
        appSessionId: "app-1",
        providerSessionId: "provider-1",
        payload: { content: { type: "text", text: "hello" }, messageId: "message-1" },
      },
    ]);

    const mode = normalizeSessionNotification(
      notification({
        sessionUpdate: "current_mode_update",
        currentModeId: "yolo",
      }),
      context,
    );
    expect(mode).toMatchObject([
      { type: "mode.updated", payload: { currentModeId: "yolo" } },
    ]);
  });

  it("drops Gemini's synthetic [MODE_UPDATE] assistant chunk", () => {
    // Gemini CLI emits "[MODE_UPDATE] <mode>" as an agent_message_chunk when
    // the approval mode changes. It is protocol noise, not model output.
    expect(
      normalizeSessionNotification(
        notification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "[MODE_UPDATE] yolo" },
          messageId: "mode-update",
        }),
        context,
      ),
    ).toEqual([]);
  });

  it("keeps ordinary assistant text that merely mentions the tag", () => {
    const events = normalizeSessionNotification(
      notification({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The [MODE_UPDATE] prefix is Gemini specific." },
      }),
      context,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "message.assistant.delta" });
  });
});
