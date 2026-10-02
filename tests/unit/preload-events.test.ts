import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type GemUiDesktopApi } from "../../src/shared/contracts";

const electronMock = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  invoke: vi.fn(),
  expose: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => electronMock.listeners.set(channel, listener),
  },
  contextBridge: { exposeInMainWorld: electronMock.expose },
  webUtils: { getPathForFile: () => "" },
}));

const event = (seq: number) => ({
  seq,
  sessionId: "00000000-0000-4000-8000-000000000010",
  turnId: null,
  event: { type: "session.ready" },
  timestamp: "2026-09-30T12:00:00.000Z",
});

describe("preload session event replay", () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.listeners.clear();
    electronMock.invoke.mockReset();
    electronMock.expose.mockReset();
  });

  it("uses the live high-water mark to fill a batch that arrived before subscribe returned", async () => {
    const subscriptionId = "00000000-0000-4000-8000-000000000001";
    electronMock.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.subscribeSessionEvents) {
        electronMock.listeners.get(IPC_CHANNELS.sessionEventBatch)?.({}, {
          subscriptionId,
          events: [event(2)],
        });
        return {
          subscriptionId,
          replay: [event(1)],
          replayUntilSeq: 1,
          nextAfterSeq: 1,
          hasMore: false,
          usageSnapshot: null,
        };
      }
      if (channel === IPC_CHANNELS.replaySessionEvents) {
        return { events: [event(2)], nextAfterSeq: 2, hasMore: false };
      }
      return { ok: true };
    });
    await import("../../src/preload/index");
    const api = electronMock.expose.mock.calls[0][1] as GemUiDesktopApi;
    const batches: number[][] = [];
    const unsubscribe = await api.subscribeSessionEvents(
      { sessionId: "00000000-0000-4000-8000-000000000010", afterSeq: 0 },
      (items) => batches.push(items.map(({ seq }) => seq)),
    );

    expect(batches.flat()).toEqual([1, 2]);
    expect(electronMock.invoke).toHaveBeenCalledWith(IPC_CHANNELS.replaySessionEvents, expect.objectContaining({
      afterSeq: 1,
      throughSeq: 2,
    }));
    unsubscribe();
  });

  it("unsubscribes and rejects when a replay page contains a gap", async () => {
    const subscriptionId = "00000000-0000-4000-8000-000000000002";
    electronMock.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.subscribeSessionEvents) {
        return {
          subscriptionId,
          replay: [event(1)],
          replayUntilSeq: 3,
          nextAfterSeq: 1,
          hasMore: true,
          usageSnapshot: null,
        };
      }
      if (channel === IPC_CHANNELS.replaySessionEvents) {
        return { events: [event(3)], nextAfterSeq: 3, hasMore: false };
      }
      return { ok: true };
    });
    await import("../../src/preload/index");
    const api = electronMock.expose.mock.calls[0][1] as GemUiDesktopApi;
    const callback = vi.fn();

    await expect(api.subscribeSessionEvents(
      { sessionId: "00000000-0000-4000-8000-000000000010", afterSeq: 0 },
      callback,
    )).rejects.toThrow(/Lücke/);
    expect(electronMock.invoke).toHaveBeenCalledWith(IPC_CHANNELS.unsubscribeSessionEvents, { subscriptionId });
  });
});
