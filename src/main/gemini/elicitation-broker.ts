import { randomUUID } from "node:crypto";
import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import { ElicitationFormSchema, RespondToElicitationInputSchema, validateElicitationContent,
  type ElicitationRequest, type RespondToElicitationInput } from "../../shared/contracts/elicitation";

/** Pending responses are kept only in memory, never in timeline/storage/logs. */
export class ElicitationBroker {
  readonly #pending = new Map<string, { request: ElicitationRequest; resolve: (response: CreateElicitationResponse) => void }>();
  #disposed = false;
  constructor(private readonly appSessionId: string) {}
  get size() { return this.#pending.size; }
  list(): ElicitationRequest[] { return [...this.#pending.values()].map((entry) => entry.request); }
  request(input: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    if (this.#disposed || this.#pending.size >= 10) return Promise.resolve({ action: "cancel" });
    const raw = input as unknown as Record<string, unknown>;
    let request: ElicitationRequest;
    try {
      const base = { requestId: randomUUID(), sessionId: this.appSessionId, message: String(input.message).slice(0, 8_000) };
      if (input.mode === "form") {
        const schema = ElicitationFormSchema.parse(raw.requestedSchema);
        // Unknown/unsafe regular expressions cannot block the main process.
        // HTML forms still support length, format and enum constraints.
        if (Object.values(schema.properties).some((field) => field.pattern)) return Promise.resolve({ action: "decline" });
        request = { ...base, mode: "form", schema };
      } else if (input.mode === "url" && typeof raw.url === "string") {
        const url = new URL(raw.url);
        if (url.protocol !== "https:" || url.username || url.password || raw.url.length > 2_048) return Promise.resolve({ action: "decline" });
        request = { ...base, mode: "url", url: raw.url };
      } else return Promise.resolve({ action: "decline" });
    } catch { return Promise.resolve({ action: "decline" }); }
    return new Promise((resolve) => { this.#pending.set(request.requestId, { request, resolve }); });
  }
  respond(raw: RespondToElicitationInput): void {
    const input = RespondToElicitationInputSchema.parse(raw);
    if (input.sessionId !== this.appSessionId) throw new Error("Die Rückfrage gehört zu einer anderen Session.");
    const pending = this.#pending.get(input.requestId);
    if (!pending) throw new Error("Diese Rückfrage ist nicht mehr offen.");
    if (input.action === "accept") validateElicitationContent(pending.request, input.content);
    this.#pending.delete(input.requestId);
    pending.resolve(input.action === "accept" ? { action: "accept", ...(pending.request.mode === "form" ? { content: input.content ?? {} } : {}) } : { action: input.action });
  }
  cancelAll(): void {
    for (const entry of this.#pending.values()) entry.resolve({ action: "cancel" });
    this.#pending.clear();
  }
  dispose(): void { this.#disposed = true; this.cancelAll(); }
}
