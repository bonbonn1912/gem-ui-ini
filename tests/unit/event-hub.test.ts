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

  it("liefert einen 50.000-Ereignis-Verlauf begrenzt bis zu einem festen Wasserzeichen", async () => {
    const sessionId = "session-large";
    const persisted = Array.from({ length: 50_000 }, (_, index) => ({
      seq: index + 1,
      sessionId,
      turnId: null,
      event: { type: "session.ready" },
      timestamp: new Date(0).toISOString(),
    } satisfies StreamEnvelope));
    const store = {
      latestSequence: () => persisted.at(-1)!.seq,
      eventsAfter: (id: string, after: number) => persisted.filter((event) => event.sessionId === id && event.seq > after),
      eventsThrough: (id: string, after: number, through: number, limit: number) =>
        persisted.filter((event) => event.sessionId === id && event.seq > after && event.seq <= through).slice(0, limit),
    };
    const hub = new SessionEventHub(store);
    const contents = fakeWebContents();
    const initial = await hub.subscribe({ sessionId, afterSeq: 0, webContents: contents as never });
    expect(initial.replay).toHaveLength(200);
    expect(initial.replayUntilSeq).toBe(50_000);

    const replayed = [...initial.replay];
    let cursor = initial.nextAfterSeq;
    let publishedConcurrently = false;
    while (cursor < initial.replayUntilSeq) {
      const page = await hub.replayPage({
        subscriptionId: initial.subscriptionId,
        sessionId,
        afterSeq: cursor,
        throughSeq: initial.replayUntilSeq,
        limit: 200,
      }, contents as never);
      expect(page.events.length).toBeGreaterThan(0);
      replayed.push(...page.events);
      cursor = page.nextAfterSeq;
      if (!publishedConcurrently) {
        publishedConcurrently = true;
        await hub.publish([{
          seq: 50_001,
          sessionId,
          turnId: null,
          event: { type: "session.ready" },
          timestamp: new Date(0).toISOString(),
        }]);
      }
    }
    expect(replayed).toHaveLength(50_000);
    expect(replayed[0].seq).toBe(1);
    expect(replayed.at(-1)?.seq).toBe(50_000);
    expect(replayed.every((event, index) => event.seq === index + 1)).toBe(true);
    const live = contents.send.mock.calls.flatMap((call) => call[1].events as StreamEnvelope[]);
    expect(live.map((item) => item.seq)).toEqual([50_001]);
    hub.close();
  });

  it("bereinigt destroyed-Listener bei tausend Subscribe/Unsubscribe-Zyklen", async () => {
    const contents = fakeWebContents();
    const hub = new SessionEventHub({ eventsAfter: () => [], latestSequence: () => 0, eventsThrough: () => [] });
    const baseline = contents.listenerCount("destroyed");
    for (let index = 0; index < 1_000; index++) {
      const subscription = await hub.subscribe({ sessionId: "session-a", afterSeq: 0, webContents: contents as never });
      hub.unsubscribe(subscription.subscriptionId, contents as never);
    }
    expect(contents.listenerCount("destroyed")).toBe(baseline);
    hub.close();
  });

  it("stellt ein einzelnes Event über dem Batchbudget live zu, ohne es zu überspringen", async () => {
    const contents = fakeWebContents();
    const event: StreamEnvelope = {
      seq: 1,
      sessionId: "session-a",
      turnId: null,
      event: { type: "session.ready", detail: "x".repeat(2_100_000) },
      timestamp: new Date(0).toISOString(),
    };
    const hub = new SessionEventHub({ latestSequence: () => 0, eventsAfter: () => [], eventsThrough: () => [] });
    const subscription = await hub.subscribe({ sessionId: "session-a", afterSeq: 0, webContents: contents as never });
    await hub.publish([event]);
    const delivered = contents.send.mock.calls.flatMap((call) => call[1].events as StreamEnvelope[]);
    expect(delivered.map((item) => item.seq)).toEqual([1]);
    hub.unsubscribe(subscription.subscriptionId, contents as never);
  });
});
