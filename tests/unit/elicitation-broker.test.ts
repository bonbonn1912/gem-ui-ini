import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ElicitationBroker } from "../../src/main/gemini/elicitation-broker";

const form = { mode: "form" as const, sessionId: "provider", message: "Choose a value", requestedSchema: {
  type: "object" as const, properties: { count: { type: "integer" as const, minimum: 1, maximum: 5 }, approved: { type: "boolean" as const } }, required: ["count", "approved"],
} };

describe("ACP elicitation broker", () => {
  it("validates session, required fields and constraints without resolving invalid input", async () => {
    const sessionId = randomUUID(); const broker = new ElicitationBroker(sessionId);
    const response = broker.request(form);
    const requestId = broker.list()[0].requestId;
    expect(() => broker.respond({ sessionId: randomUUID(), requestId, action: "accept", content: { count: 3, approved: true } })).toThrow(/anderen Session/);
    expect(() => broker.respond({ sessionId, requestId, action: "accept", content: { count: 8 } })).toThrow();
    expect(broker.size).toBe(1);
    broker.respond({ sessionId, requestId, action: "accept", content: { count: 3, approved: false } });
    await expect(response).resolves.toEqual({ action: "accept", content: { count: 3, approved: false } });
    expect(broker.list()).toEqual([]);
  });
  it("cancels every pending request on disposal and rejects further work", async () => {
    const broker = new ElicitationBroker(randomUUID());
    const responses = [broker.request(form), broker.request(form)];
    broker.dispose();
    await expect(Promise.all(responses)).resolves.toEqual([{ action: "cancel" }, { action: "cancel" }]);
    await expect(broker.request(form)).resolves.toEqual({ action: "cancel" });
  });
  it("does not open URLs and declines unsupported protocols or schemas", async () => {
    const broker = new ElicitationBroker(randomUUID());
    await expect(broker.request({ mode: "url", sessionId: "provider", message: "Login", elicitationId: "id", url: "file:///etc/passwd" })).resolves.toEqual({ action: "decline" });
    await expect(broker.request({ ...form, requestedSchema: { properties: { item: { type: "object" } } } })).resolves.toEqual({ action: "decline" });
    const pending = broker.request({ mode: "url", sessionId: "provider", message: "Login", elicitationId: "id", url: "https://example.com/auth" });
    expect(broker.size).toBe(1);
    broker.respond({ sessionId: broker.list()[0].sessionId, requestId: broker.list()[0].requestId, action: "decline" });
    await expect(pending).resolves.toEqual({ action: "decline" });
  });
});
