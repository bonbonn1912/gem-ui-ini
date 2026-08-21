import { describe, expect, it } from "vitest";

import {
  addTokenCounters,
  parsePromptUsage,
  parseUsageUpdate,
  EMPTY_TOKEN_COUNTERS,
} from "../../src/main/gemini/usage.js";

describe("provider usage parser", () => {
  it("reads the standardized PromptResponse.usage as a cumulative session value", () => {
    const observation = parsePromptUsage({
      stopReason: "end_turn",
      usage: {
        totalTokens: 1_024,
        inputTokens: 900,
        outputTokens: 124,
        thoughtTokens: 12,
        cachedReadTokens: 7,
      },
    });

    expect(observation).toEqual({
      kind: "tokens",
      scope: "session_cumulative",
      source: "acp_prompt_usage",
      byModel: [],
      tokens: {
        input: 900,
        output: 124,
        total: 1_024,
        thought: 12,
        cachedRead: 7,
        cachedWrite: null,
        tool: null,
        totalKind: "provider",
      },
    });
  });

  it("reads Gemini's snake_case _meta.quota as a per-turn value and marks the derived total", () => {
    const observation = parsePromptUsage({
      stopReason: "end_turn",
      _meta: {
        quota: {
          token_count: { input_tokens: 1_234, output_tokens: 567 },
          model_usage: [
            {
              model: "gemini-2.5-pro",
              token_count: { input_tokens: 1_200, output_tokens: 500 },
            },
            {
              model: "gemini-2.5-flash",
              token_count: { input_tokens: 34, output_tokens: 67 },
            },
          ],
        },
      },
    });

    expect(observation?.scope).toBe("turn");
    expect(observation?.source).toBe("gemini_meta_quota");
    expect(observation?.tokens).toMatchObject({
      input: 1_234,
      output: 567,
      total: 1_801,
      totalKind: "derived_input_plus_output",
    });
    expect(observation?.byModel).toEqual([
      { model: "gemini-2.5-pro", input: 1_200, output: 500 },
      { model: "gemini-2.5-flash", input: 34, output: 67 },
    ]);
  });

  it("prefers the standard field when both are present and never counts twice", () => {
    const observation = parsePromptUsage({
      usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 },
      _meta: {
        quota: {
          token_count: { input_tokens: 10, output_tokens: 20 },
          model_usage: [
            { model: "gemini-2.5-pro", token_count: { input_tokens: 10, output_tokens: 20 } },
          ],
        },
      },
    });

    expect(observation?.source).toBe("acp_prompt_usage");
    expect(observation?.scope).toBe("session_cumulative");
    expect(observation?.tokens.total).toBe(30);
    // The per-model split may still come from _meta, it just must not be added
    // to the session totals a second time.
    expect(observation?.byModel).toHaveLength(1);
  });

  it("accepts zero tokens but drops broken, negative and unsafe values", () => {
    expect(
      parsePromptUsage({ usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } })?.tokens,
    ).toMatchObject({ input: 0, output: 0, total: 0, totalKind: "provider" });

    expect(parsePromptUsage(null)).toBeNull();
    expect(parsePromptUsage({})).toBeNull();
    expect(parsePromptUsage({ usage: null })).toBeNull();
    expect(parsePromptUsage({ _meta: { quota: {} } })).toBeNull();
    expect(parsePromptUsage({ _meta: { quota: { token_count: {} } } })).toBeNull();
    expect(
      parsePromptUsage({ usage: { inputTokens: "900", outputTokens: -1, totalTokens: 1.5 } }),
    ).toBeNull();
    expect(
      parsePromptUsage({
        _meta: { quota: { token_count: { input_tokens: Number.MAX_SAFE_INTEGER + 2 } } },
      }),
    ).toBeNull();
  });

  it("ignores unknown _meta fields instead of forwarding them", () => {
    const observation = parsePromptUsage({
      _meta: {
        unknownVendorField: { secret: "value" },
        quota: {
          token_count: { input_tokens: 1, output_tokens: 2 },
          futureField: 42,
        },
      },
    });

    expect(observation?.tokens.input).toBe(1);
    expect(JSON.stringify(observation)).not.toContain("secret");
  });

  it("keeps used/size/cost of a native usage_update and rejects an unusable window", () => {
    expect(
      parseUsageUpdate({ used: 10, size: 100, cost: { amount: 0.01, currency: "usd" } }),
    ).toEqual({
      kind: "context",
      source: "acp_usage_update",
      used: 10,
      size: 100,
      cost: { amount: 0.01, currency: "USD" },
    });

    expect(parseUsageUpdate({ used: 10, size: 0 })).toBeNull();
    expect(parseUsageUpdate({ used: -1, size: 100 })).toBeNull();
    expect(parseUsageUpdate({ used: 10, size: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parseUsageUpdate({ used: 5, size: 50, cost: { amount: -1, currency: "EUR" } })?.cost)
      .toBeNull();
  });

  it("adds counters without turning unknown values into zero", () => {
    const sum = addTokenCounters(
      { ...EMPTY_TOKEN_COUNTERS, input: 10, output: 5, total: 15, totalKind: "provider" },
      { ...EMPTY_TOKEN_COUNTERS, input: 1, output: 2, total: 3, totalKind: "derived_input_plus_output" },
    );
    expect(sum).toMatchObject({ input: 11, output: 7, total: 18, thought: null });
  });
});
