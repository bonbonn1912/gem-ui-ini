import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { IPC_CHANNELS } from "../../shared/contracts";

export type StreamEnvelope = {
  seq: number;
  sessionId: string;
  turnId: string | null;
  event: unknown;
  timestamp: string;
};

export interface EventReplayStore {
  eventsAfter(
    sessionId: string,
    afterSeq: number,
  ): StreamEnvelope[] | Promise<StreamEnvelope[]>;
  /** Optional: the persisted usage snapshot, independent of the replay window. */
  usageSnapshot?(sessionId: string): unknown;
  latestSequence?(sessionId: string): number;
  eventsThrough?(sessionId: string, afterSeq: number, throughSeq: number, limit: number): StreamEnvelope[];
}

type Subscription = {
  id: string;
  sessionId: string;
  webContents: WebContents;
  destroyedListener: () => void;
};

export type ReplayPage = { events: StreamEnvelope[]; nextAfterSeq: number; hasMore: boolean };

export class SessionEventHub {
  readonly #store: EventReplayStore;
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #locks = new Map<string, Promise<void>>();

  constructor(store: EventReplayStore) {
    this.#store = store;
  }

  async subscribe(input: {
    sessionId: string;
    afterSeq: number;
    webContents: WebContents;
  }): Promise<{
    subscriptionId: string;
    replay: StreamEnvelope[];
    replayUntilSeq: number;
    nextAfterSeq: number;
    hasMore: boolean;
    usageSnapshot: unknown;
  }> {
    return this.#withSessionLock(input.sessionId, async () => {
      const subscriptionId = randomUUID();
      const subscription: Subscription = {
        id: subscriptionId,
        sessionId: input.sessionId,
        webContents: input.webContents,
        destroyedListener: () => this.#removeSubscription(subscriptionId),
      };
      this.#subscriptions.set(subscriptionId, subscription);
      input.webContents.once("destroyed", subscription.destroyedListener);

      try {
        const replayUntilSeq = this.#store.latestSequence?.(input.sessionId) ??
          (await this.#store.eventsAfter(input.sessionId, input.afterSeq)).at(-1)?.seq ?? input.afterSeq;
        const page = await this.#readPage(input.sessionId, input.afterSeq, replayUntilSeq, 200);
        const usageSnapshot = this.#store.usageSnapshot?.(input.sessionId) ?? null;
        return { subscriptionId, replay: page.events, replayUntilSeq, nextAfterSeq: page.nextAfterSeq, hasMore: page.hasMore, usageSnapshot };
      } catch (error) {
        this.#removeSubscription(subscriptionId);
        throw error;
      }
    });
  }

  async replayPage(input: { subscriptionId: string; sessionId: string; afterSeq: number; throughSeq: number; limit?: number }, webContents: WebContents): Promise<ReplayPage> {
    const subscription = this.#subscriptions.get(input.subscriptionId);
    if (!subscription || subscription.webContents.id !== webContents.id || subscription.sessionId !== input.sessionId) {
      throw new Error("Session event subscription is no longer active");
    }
    return this.#readPage(input.sessionId, input.afterSeq, input.throughSeq, input.limit ?? 200);
  }

  unsubscribe(subscriptionId: string, webContents: WebContents): void {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription?.webContents.id === webContents.id) {
      this.#removeSubscription(subscriptionId);
    }
  }

  async publish(events: StreamEnvelope[]): Promise<void> {
    const bySession = new Map<string, StreamEnvelope[]>();
    for (const event of events) {
      const existing = bySession.get(event.sessionId) ?? [];
      existing.push(event);
      bySession.set(event.sessionId, existing);
    }

    await Promise.all(
      [...bySession].map(([sessionId, sessionEvents]) =>
        this.#withSessionLock(sessionId, () => {
          sessionEvents.sort((left, right) => left.seq - right.seq);
          for (const subscription of this.#subscriptions.values()) {
            if (
              subscription.sessionId !== sessionId ||
              subscription.webContents.isDestroyed()
            ) {
              continue;
            }
            let batch: StreamEnvelope[] = [];
            let bytes = 128;
            for (const event of sessionEvents) {
              const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
              if (batch.length && (batch.length >= 200 || bytes + eventBytes > 2 * 1024 * 1024)) {
                subscription.webContents.send(IPC_CHANNELS.sessionEventBatch, {
                  subscriptionId: subscription.id,
                  events: batch,
                });
                batch = [];
                bytes = 128;
              }
              batch.push(event);
              bytes += eventBytes;
            }
            if (batch.length) subscription.webContents.send(IPC_CHANNELS.sessionEventBatch, {
              subscriptionId: subscription.id,
              events: batch,
            });
          }
        }),
      ),
    );
  }

  close(): void {
    for (const id of this.#subscriptions.keys()) this.#removeSubscription(id);
  }

  #removeSubscription(id: string): void {
    const subscription = this.#subscriptions.get(id);
    if (!subscription) return;
    subscription.webContents.removeListener("destroyed", subscription.destroyedListener);
    this.#subscriptions.delete(id);
  }

  async #readPage(sessionId: string, afterSeq: number, throughSeq: number, limit: number): Promise<ReplayPage> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(throughSeq) || throughSeq < afterSeq) {
      throw new RangeError("Invalid replay cursor");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Replay limit must be between 1 and 500");
    const events = this.#store.eventsThrough
      ? this.#store.eventsThrough(sessionId, afterSeq, throughSeq, limit)
      : (await this.#store.eventsAfter(sessionId, afterSeq)).filter((event) => event.seq <= throughSeq).slice(0, limit);
    for (let index = 0; index < events.length; index++) {
      const expected = afterSeq + index + 1;
      if (events[index].seq !== expected) {
        throw new Error(`Event replay gap for ${sessionId}: expected sequence ${expected}, received ${events[index].seq}`);
      }
    }
    const nextAfterSeq = events.at(-1)?.seq ?? afterSeq;
    return { events, nextAfterSeq, hasMore: nextAfterSeq < throughSeq };
  }

  async #withSessionLock<T>(
    sessionId: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const previous = this.#locks.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#locks.set(sessionId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(sessionId) === tail) {
        this.#locks.delete(sessionId);
      }
    }
  }
}
