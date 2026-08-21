import { createHash, randomUUID } from "node:crypto";
import type { WebContents } from "electron";

import {
  GitStatusPushSchema,
  IPC_CHANNELS,
  type GitProjectStatus,
  type SubscribeGitProjectStatusInput,
} from "../../shared/contracts";
import type { GitService } from "./git-service";

type Subscription = {
  id: string;
  input: SubscribeGitProjectStatusInput;
  webContents: WebContents;
  fingerprint: string;
  timer: ReturnType<typeof setTimeout> | null;
  polling: boolean;
  destroyedListener: () => void;
};

const POLL_INTERVAL_MS = 4_000;

export class GitStatusSubscriptionHub {
  readonly #git: GitService;
  readonly #subscriptions = new Map<string, Subscription>();
  #closed = false;

  constructor(git: GitService) {
    this.#git = git;
  }

  async subscribe(input: {
    value: SubscribeGitProjectStatusInput;
    webContents: WebContents;
    signal?: AbortSignal;
  }) {
    if (this.#closed) throw new Error("Git status subscriptions are closed");
    const status = await this.#git.getProjectStatus(input.value, input.signal);
    const id = randomUUID();
    const destroyedListener = () => this.unsubscribe(id, input.webContents);
    const subscription: Subscription = {
      id,
      input: input.value,
      webContents: input.webContents,
      fingerprint: statusFingerprint(status),
      timer: null,
      polling: false,
      destroyedListener,
    };
    this.#subscriptions.set(id, subscription);
    input.webContents.once("destroyed", destroyedListener);
    this.#schedule(subscription);
    return { subscriptionId: id, status };
  }

  unsubscribe(id: string, sender?: WebContents): void {
    const subscription = this.#subscriptions.get(id);
    if (!subscription || (sender && subscription.webContents !== sender)) return;
    this.#subscriptions.delete(id);
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.webContents.removeListener(
      "destroyed",
      subscription.destroyedListener,
    );
  }

  close(): void {
    this.#closed = true;
    for (const id of [...this.#subscriptions.keys()]) this.unsubscribe(id);
  }

  #schedule(subscription: Subscription): void {
    if (this.#closed || !this.#subscriptions.has(subscription.id)) return;
    subscription.timer = setTimeout(
      () => void this.#poll(subscription),
      POLL_INTERVAL_MS,
    );
    subscription.timer.unref?.();
  }

  async #poll(subscription: Subscription): Promise<void> {
    subscription.timer = null;
    if (
      this.#closed ||
      subscription.polling ||
      !this.#subscriptions.has(subscription.id) ||
      subscription.webContents.isDestroyed()
    ) return;
    subscription.polling = true;
    try {
      const status = await this.#git.getProjectStatus(subscription.input);
      const fingerprint = statusFingerprint(status);
      if (fingerprint !== subscription.fingerprint) {
        subscription.fingerprint = fingerprint;
        const payload = GitStatusPushSchema.parse({
          subscriptionId: subscription.id,
          status,
        });
        subscription.webContents.send(
          IPC_CHANNELS.gitProjectStatusChanged,
          payload,
        );
      }
    } catch {
      // Root changes and transient repository locks are handled by the next
      // renderer refresh or polling cycle; never push an unvalidated partial.
    } finally {
      subscription.polling = false;
      this.#schedule(subscription);
    }
  }
}

function statusFingerprint(status: GitProjectStatus): string {
  return createHash("sha256")
    .update(JSON.stringify({
      rootRevision: status.rootRevision,
      repositories: status.repositories,
      changes: status.changes,
    }))
    .digest("hex");
}
