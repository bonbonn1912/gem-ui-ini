import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  SessionEventHub,
  type StreamEnvelope,
} from "../../src/main/ipc/event-hub";

function fakeWebContents() {
  const emitter = new EventEmitter() as EventEmitter & {
    id: number;
    isDestroyed: () => boolean;
    send: ReturnType<typeof vi.fn>;
  };
  emitter.id = 7;
  emitter.isDestroyed = () => false;
  emitter.send = vi.fn();
  return emitter;
}

describe("SessionEventHub", () => {
  it("liefert Replay und danach nur passende Live-Batches", async () => {
    const stored: StreamEnvelope = {
      seq: 2,
      sessionId: "session-a",
      turnId: null,
      event: { type: "session.ready" },
      timestamp: new Date().toISOString(),
    };
    const hub = new SessionEventHub({ eventsAfter: () => [stored] });
    const webContents = fakeWebContents();
    const subscription = await hub.subscribe({
      sessionId: "session-a",
      afterSeq: 1,
      webContents: webContents as never,
    });

    expect(subscription.replay).toEqual([stored]);
    await hub.publish([
      { ...stored, seq: 3 },
      { ...stored, seq: 1, sessionId: "session-b" },
    ]);

    expect(webContents.send).toHaveBeenCalledOnce();
    expect(webContents.send.mock.calls[0][1]).toMatchObject({
      subscriptionId: subscription.subscriptionId,
      events: [{ seq: 3 }],
    });
  });
});
