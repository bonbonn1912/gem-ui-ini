import type { AgentEvent, StreamEnvelope } from "../../shared";
import type { AppendEventInput } from "../storage/repositories/event-repository";

type BufferState = { events: AppendEventInput[]; bytes: number; attempts: number; timer?: ReturnType<typeof setTimeout>; stopped: boolean };
const isDelta = (event: AgentEvent): event is Extract<AgentEvent, { type: "message.assistant.delta" | "message.thought.delta" }> =>
  event.type === "message.assistant.delta" || event.type === "message.thought.delta";

/** A commit is the only acknowledgement; failures retain the bounded pending batch. */
export class BufferedEventWriter {
  readonly #buffers = new Map<string, BufferState>();
  constructor(private readonly options: {
    appendBatch: (events: AppendEventInput[]) => StreamEnvelope[];
    publish: (events: StreamEnvelope[]) => void | Promise<void>;
    onFailure: (sessionId: string, message: string, stopProducer: boolean) => void;
    onRecovered?: (sessionId: string) => void;
  }) {}
  enqueue(input: AppendEventInput): void {
    let state = this.#buffers.get(input.sessionId);
    if (!state) { state = { events: [], bytes: 0, attempts: 0, stopped: false }; this.#buffers.set(input.sessionId, state); }
    if (state.stopped) return;
    const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    if (state.events.length >= 1_000 || state.bytes + bytes > 2 * 1024 * 1024) this.flush(input.sessionId);
    if (state.stopped) return;
    state = this.#buffers.get(input.sessionId) ?? { events: [], bytes: 0, attempts: 0, stopped: false };
    this.#buffers.set(input.sessionId, state);
    if (state.events.length >= 1_000 || (state.events.length > 0 && state.bytes + bytes > 4 * 1024 * 1024)) {
      state.stopped = true;
      this.options.onFailure(input.sessionId, "Der Verlauf konnte nicht gespeichert werden. Die Antwort wurde angehalten; der letzte Teil kann fehlen. Freien Speicherplatz prüfen und die App erneut öffnen.", true);
      return;
    }
    const previous = state.events.at(-1);
    if (previous && isDelta(previous.event) && isDelta(input.event) && previous.event.type === input.event.type &&
        previous.event.messageId === input.event.messageId && !previous.event.contentBlocks && !input.event.contentBlocks &&
        previous.event.delta.length + input.event.delta.length <= 100_000) {
      previous.event = { ...previous.event, delta: previous.event.delta + input.event.delta };
    } else state.events.push(input);
    state.bytes += bytes;
    if (!isDelta(input.event) || state.bytes >= 2 * 1024 * 1024 || state.events.length >= 1_000) this.flush(input.sessionId);
    else if (!state.timer) this.schedule(input.sessionId, state, 32);
  }
  flush(sessionId: string): void {
    const state = this.#buffers.get(sessionId);
    if (!state?.events.length) return;
    clearTimeout(state.timer); state.timer = undefined;
    try {
      const committed = this.options.appendBatch(state.events.slice(0, 1_000));
      state.events.splice(0, committed.length);
      state.bytes = state.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), "utf8"), 0);
      state.attempts = 0;
      if (!state.events.length) this.#buffers.delete(sessionId);
      if (!state.stopped) this.options.onRecovered?.(sessionId);
      Promise.resolve().then(() => this.options.publish(committed)).catch(() => {
        this.options.onFailure(sessionId, "Die Live-Anzeige wurde unterbrochen. Der Verlauf ist gespeichert; die Session erneut öffnen.", false);
      });
    } catch {
      state.attempts += 1;
      const exhausted = state.attempts >= 3;
      state.stopped ||= exhausted;
      this.options.onFailure(sessionId, "Der Verlauf kann momentan nicht gespeichert werden. Die Antwort wird angehalten. Freien Speicherplatz und Datenbankzugriff prüfen.", exhausted);
      if (!exhausted) this.schedule(sessionId, state, state.attempts * 250);
    }
  }
  retry(sessionId: string): boolean {
    const state = this.#buffers.get(sessionId);
    if (!state) { this.options.onRecovered?.(sessionId); return true; }
    state.stopped = false;
    state.attempts = 0;
    this.flush(sessionId);
    return !this.#buffers.has(sessionId);
  }
  dispose(): void {
    for (const [id, state] of this.#buffers) {
      clearTimeout(state.timer); this.flush(id); clearTimeout(state.timer);
    }
  }
  private schedule(id: string, state: BufferState, delay: number) {
    state.timer = setTimeout(() => this.flush(id), delay); state.timer.unref?.();
  }
}
