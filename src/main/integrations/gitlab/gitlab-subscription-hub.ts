import { randomUUID } from "node:crypto";
import type { GitLabReviewState } from "../../../shared/contracts";

export type GitLabStateFetcher = (
  projectId: string,
  bindingId: string,
  signal: AbortSignal,
) => Promise<GitLabReviewState>;

export type GitLabPushCallback = (
  subscriptionId: string,
  state: GitLabReviewState,
) => void;

type Subscription = {
  id: string;
  projectId: string;
  bindingId: string;
  timer: NodeJS.Timeout | null;
  abortController: AbortController | null;
  lastState: GitLabReviewState | null;
};

export class GitLabSubscriptionHub {
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #fetcher: GitLabStateFetcher;
  readonly #pushCallback: GitLabPushCallback;
  #isAppFocused = true;

  constructor(fetcher: GitLabStateFetcher, pushCallback: GitLabPushCallback) {
    this.#fetcher = fetcher;
    this.#pushCallback = pushCallback;
  }

  setAppFocused(focused: boolean): void {
    this.#isAppFocused = focused;
  }

  async subscribe(
    projectId: string,
    bindingId: string,
  ): Promise<{ subscriptionId: string; initial: GitLabReviewState }> {
    const subscriptionId = randomUUID();
    const abortController = new AbortController();

    const initial = await this.#fetcher(projectId, bindingId, abortController.signal);

    const sub: Subscription = {
      id: subscriptionId,
      projectId,
      bindingId,
      timer: null,
      abortController,
      lastState: initial,
    };

    this.#subscriptions.set(subscriptionId, sub);
    this.#schedulePoll(sub);

    return { subscriptionId, initial };
  }

  unsubscribe(subscriptionId: string): void {
    const sub = this.#subscriptions.get(subscriptionId);
    if (!sub) return;

    if (sub.timer) clearTimeout(sub.timer);
    if (sub.abortController) sub.abortController.abort();
    this.#subscriptions.delete(subscriptionId);
  }

  notifyStateChanged(bindingId: string, state: GitLabReviewState): void {
    for (const sub of this.#subscriptions.values()) {
      if (sub.bindingId === bindingId) {
        sub.lastState = state;
        this.#pushCallback(sub.id, state);
      }
    }
  }

  #schedulePoll(sub: Subscription): void {
    const intervalMs = this.#isAppFocused ? 30_000 : 90_000;
    sub.timer = setTimeout(() => {
      void this.#poll(sub);
    }, intervalMs);
  }

  async #poll(sub: Subscription): Promise<void> {
    if (!this.#subscriptions.has(sub.id)) return;

    try {
      sub.abortController = new AbortController();
      const state = await this.#fetcher(
        sub.projectId,
        sub.bindingId,
        sub.abortController.signal,
      );
      sub.lastState = state;
      this.#pushCallback(sub.id, state);
    } catch {
      // Ignore background poll errors
    } finally {
      if (this.#subscriptions.has(sub.id)) {
        this.#schedulePoll(sub);
      }
    }
  }

  dispose(): void {
    for (const sub of this.#subscriptions.values()) {
      if (sub.timer) clearTimeout(sub.timer);
      if (sub.abortController) sub.abortController.abort();
    }
    this.#subscriptions.clear();
  }
}
