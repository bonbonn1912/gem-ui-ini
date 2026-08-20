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
}

type Subscription = {
  id: string;
  sessionId: string;
  webContents: WebContents;
};

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
  }): Promise<{ subscriptionId: string; replay: StreamEnvelope[] }> {
    return this.#withSessionLock(input.sessionId, async () => {
      const subscriptionId = randomUUID();
      this.#subscriptions.set(subscriptionId, {
        id: subscriptionId,
        sessionId: input.sessionId,
        webContents: input.webContents,
      });
      input.webContents.once("destroyed", () => {
        this.#subscriptions.delete(subscriptionId);
      });

      const replay = await this.#store.eventsAfter(
        input.sessionId,
        input.afterSeq,
      );
      return { subscriptionId, replay };
    });
  }

  unsubscribe(subscriptionId: string, webContents: WebContents): void {
    const subscription = this.#subscriptions.get(subscriptionId);
    if (subscription?.webContents.id === webContents.id) {
      this.#subscriptions.delete(subscriptionId);
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
            subscription.webContents.send(IPC_CHANNELS.sessionEventBatch, {
              subscriptionId: subscription.id,
              events: sessionEvents,
            });
          }
        }),
      ),
    );
  }

  close(): void {
    this.#subscriptions.clear();
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
