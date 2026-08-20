import { describe, expect, it } from "vitest";
import {
  chatReducer,
  createChatState,
  type ChatState,
  type PermissionItem,
  type ToolItem,
} from "../../src/renderer/features/chat/reducer";
import type { AgentEvent, StreamEnvelope } from "../../src/renderer/types";

function envelope(seq: number, event: AgentEvent, turnId = "turn-1"): StreamEnvelope {
  return {
    seq,
    sessionId: "session-1",
    turnId,
    timestamp: `2026-08-20T12:00:0${seq}.000Z`,
    event,
  };
}

describe("chatReducer", () => {
  it("sortiert Stream-Events, fügt Textdeltas zusammen und ignoriert Replay-Duplikate", () => {
    const initial = createChatState("session-1");
    const streamed = chatReducer(initial, {
      type: "events",
      events: [
        envelope(2, { type: "message.assistant.delta", messageId: "assistant-1", delta: " Welt" }),
        envelope(1, { type: "message.assistant.delta", messageId: "assistant-1", delta: "Hallo" }),
      ],
    });

    expect(streamed.lastSeq).toBe(2);
    expect(streamed.phase).toBe("running");
    expect(streamed.items).toHaveLength(1);
    expect(streamed.items[0]).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "Hallo Welt",
      streaming: true,
    });

    const replayed = chatReducer(streamed, {
      type: "events",
      events: [envelope(2, { type: "message.assistant.delta", messageId: "assistant-1", delta: " Welt" })],
    });
    expect(replayed).toEqual(streamed);

    const completed = chatReducer(replayed, {
      type: "events",
      events: [envelope(3, { type: "turn.completed", stopReason: "end_turn" })],
    });
    expect(completed.phase).toBe("idle");
    expect(completed.items[0]).toMatchObject({ streaming: false });
  });

  it("ersetzt eine optimistische User-Nachricht mit dem bestätigten Event", () => {
    const optimistic = chatReducer(createChatState("session-1"), {
      type: "optimistic-user",
      clientRequestId: "request-1",
      text: "Analysiere das Bild",
      attachments: [{
        id: "image-1",
        sessionId: "session-1",
        turnId: null,
        displayName: "bug.png",
        mimeType: "image/png",
        size: 42,
        sha256: "0".repeat(64),
        status: "staged",
        createdAt: "2026-08-20T12:00:00.000Z",
      }],
      timestamp: "2026-08-20T12:00:00.000Z",
    });

    const confirmed = chatReducer(optimistic, {
      type: "events",
      events: [
        envelope(1, {
          type: "message.user",
          messageId: "message-1",
          text: "Analysiere das Bild",
          attachmentIds: ["image-1"],
        }),
      ],
    });

    expect(confirmed.items).toHaveLength(1);
    expect(confirmed.items[0]).toMatchObject({
      id: "user:message-1",
      clientRequestId: "request-1",
      turnId: "turn-1",
    });
  });

  it("führt Tool-Updates zusammen und hält Freigabeoptionen unverändert", () => {
    const withTool = chatReducer(createChatState("session-1"), {
      type: "events",
      events: [
        envelope(1, {
          type: "tool.started",
          toolCallId: "tool-1",
          title: "Datei ändern",
          kind: "edit",
          arguments: { path: "/project/app.ts" },
        }),
        envelope(2, {
          type: "tool.completed",
          toolCallId: "tool-1",
          result: "ok",
        }),
        envelope(3, {
          type: "permission.requested",
          requestId: "permission-1",
          toolCallId: null,
          title: "Datei schreiben",
          options: [
            { optionId: "allow-this", label: "Einmal erlauben", kind: "allow_once" },
            { optionId: "deny-this", label: "Ablehnen", kind: "reject_once" },
          ],
        }),
      ],
    });

    const tool = withTool.items.find((item): item is ToolItem => item.kind === "tool");
    const permission = withTool.items.find((item): item is PermissionItem => item.kind === "permission");
    expect(tool).toMatchObject({ status: "completed", input: { path: "/project/app.ts" }, output: "ok" });
    expect(permission?.options.map((option) => option.optionId)).toEqual(["allow-this", "deny-this"]);
    expect(withTool.phase).toBe("awaiting_permission");

    const submitting = chatReducer(withTool, {
      type: "permission-submitting",
      requestId: "permission-1",
      optionId: "allow-this",
    });
    expect((submitting.items.find((item) => item.kind === "permission") as PermissionItem).status).toBe("submitting");

    const resolved: ChatState = chatReducer(submitting, {
      type: "events",
      events: [envelope(4, { type: "permission.resolved", requestId: "permission-1", optionId: "allow-this" })],
    });
    expect((resolved.items.find((item) => item.kind === "permission") as PermissionItem).status).toBe("allowed");
    expect(resolved.phase).toBe("running");
  });

  it("übernimmt gemeldete Tokennutzung ohne eine Kontextfenstergröße zu erfinden", () => {
    const updated = chatReducer(createChatState("session-1"), {
      type: "events",
      events: [envelope(1, {
        type: "usage.updated",
        inputTokens: 900,
        outputTokens: 124,
        totalTokens: 1_024,
      })],
    });

    expect(updated.usage).toEqual({
      inputTokens: 900,
      outputTokens: 124,
      totalTokens: 1_024,
      used: 1_024,
      size: undefined,
      cost: undefined,
    });
  });
});
