import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

import {
  IPC_CHANNELS,
  TodoPushSchema,
  type ListTodosInput,
} from "../../shared";
import type { TodoService } from "./todo-service";

type Subscription = {
  id: string;
  input: ListTodosInput;
  webContents: WebContents;
  destroyedListener: () => void;
};

export class TodoSubscriptionHub {
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #unsubscribeService: () => void;
  #closed = false;

  constructor(private readonly service: TodoService) {
    this.#unsubscribeService = service.subscribe((projectId) => this.#publish(projectId));
  }

  subscribe(input: { value: ListTodosInput; webContents: WebContents }) {
    if (this.#closed) throw new Error("Todo subscriptions are closed");
    const list = this.service.list(input.value);
    const id = randomUUID();
    const destroyedListener = () => this.unsubscribe(id, input.webContents);
    this.#subscriptions.set(id, {
      id,
      input: input.value,
      webContents: input.webContents,
      destroyedListener,
    });
    input.webContents.once("destroyed", destroyedListener);
    return { subscriptionId: id, list };
  }

  unsubscribe(id: string, sender?: WebContents): void {
    const subscription = this.#subscriptions.get(id);
    if (!subscription || (sender && sender !== subscription.webContents)) return;
    this.#subscriptions.delete(id);
    subscription.webContents.removeListener("destroyed", subscription.destroyedListener);
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribeService();
    for (const id of [...this.#subscriptions.keys()]) this.unsubscribe(id);
  }

  #publish(projectId: string): void {
    if (this.#closed) return;
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.input.projectId !== projectId || subscription.webContents.isDestroyed()) {
        continue;
      }
      try {
        const payload = TodoPushSchema.parse({
          subscriptionId: subscription.id,
          list: this.service.list(subscription.input),
        });
        subscription.webContents.send(IPC_CHANNELS.todosChanged, payload);
      } catch {
        // A deleted project tears down its renderer subscription next.
      }
    }
  }
}
