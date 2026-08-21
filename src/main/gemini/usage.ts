/**
 * Provider boundary for token/context usage.
 *
 * Everything Gemini-specific about usage reporting lives here: the standardized
 * ACP `PromptResponse.usage` field, Gemini CLI 0.56's proprietary
 * `_meta.quota.token_count` payload (snake_case) and the ACP `usage_update`
 * notification. Nothing outside this module may know about `_meta` or
 * snake_case keys, and no raw provider object is ever forwarded.
 */

export interface TokenCounters {
  readonly input: number | null;
  readonly output: number | null;
  readonly total: number | null;
  readonly thought: number | null;
  readonly cachedRead: number | null;
  readonly cachedWrite: number | null;
  readonly tool: number | null;
  readonly totalKind: "provider" | "derived_input_plus_output" | null;
}

export interface ModelTokenUsage {
  readonly model: string;
  readonly input: number;
  readonly output: number;
}

export interface UsageCost {
  readonly amount: number;
  readonly currency: string;
}

/**
 * Token counters observed for one prompt response.
 *
 * `scope` is deliberately explicit: the SDK 1.3.0 type comments describe
 * `PromptResponse.usage` as cumulative for the session, while Gemini's
 * `_meta.quota` counters are reset at the start of every `Session.prompt()`.
 * Guessing the level of validity is exactly the bug this module prevents.
 */
export interface UsageTokenObservation {
  readonly kind: "tokens";
  readonly scope: "turn" | "session_cumulative";
  readonly source: "acp_prompt_usage" | "gemini_meta_quota";
  readonly tokens: TokenCounters;
  readonly byModel: readonly ModelTokenUsage[];
}

/** Context-window occupancy. Never a token consumption value. */
export interface UsageContextObservation {
  readonly kind: "context";
  readonly source: "acp_usage_update";
  readonly used: number;
  readonly size: number;
  readonly cost: UsageCost | null;
}

export type UsageObservation = UsageTokenObservation | UsageContextObservation;

export type UsageDiagnostic = (message: string) => void;

export const EMPTY_TOKEN_COUNTERS: TokenCounters = {
  input: null,
  output: null,
  total: null,
  thought: null,
  cachedRead: null,
  cachedWrite: null,
  tool: null,
  totalKind: null,
};

/**
 * Reads the token counters of a finished prompt turn.
 *
 * Priority follows the fallback table in token-usage.md: the standardized
 * `usage` field wins, Gemini's `_meta.quota` is the fallback. When both exist
 * the standardized field defines the session state while `_meta.quota` may
 * still contribute the per-model split, so nothing is counted twice.
 */
export function parsePromptUsage(
  response: unknown,
  diagnose?: UsageDiagnostic,
): UsageTokenObservation | null {
  const record = asRecord(response);
  if (!record) return null;

  const byModel = parseModelUsage(record, diagnose);
  const standard = parseStandardUsage(record.usage, diagnose);
  if (standard) {
    return {
      kind: "tokens",
      scope: "session_cumulative",
      source: "acp_prompt_usage",
      tokens: standard,
      byModel,
    };
  }

  const quota = parseGeminiQuota(record, diagnose);
  if (quota) {
    return {
      kind: "tokens",
      scope: "turn",
      source: "gemini_meta_quota",
      tokens: quota,
      byModel,
    };
  }
  return null;
}

/** Reads an ACP `usage_update` notification body. */
export function parseUsageUpdate(
  update: unknown,
  diagnose?: UsageDiagnostic,
): UsageContextObservation | null {
  const record = asRecord(update);
  if (!record) return null;

  const used = safeCount(record.used);
  const size = safeCount(record.size);
  if (used === null || size === null || size <= 0) {
    diagnose?.("usage_update dropped: used/size are not usable token counts");
    return null;
  }
  return {
    kind: "context",
    source: "acp_usage_update",
    used,
    size,
    cost: parseCost(record.cost, diagnose),
  };
}

function parseStandardUsage(
  value: unknown,
  diagnose?: UsageDiagnostic,
): TokenCounters | null {
  const usage = asRecord(value);
  if (!usage) return null;

  const input = safeCount(usage.inputTokens);
  const output = safeCount(usage.outputTokens);
  const providerTotal = safeCount(usage.totalTokens);
  if (input === null && output === null && providerTotal === null) {
    if (value !== undefined && value !== null) {
      diagnose?.("PromptResponse.usage contained no usable token counts");
    }
    return null;
  }

  return buildCounters({
    input,
    output,
    providerTotal,
    thought: safeCount(usage.thoughtTokens),
    cachedRead: safeCount(usage.cachedReadTokens),
    cachedWrite: safeCount(usage.cachedWriteTokens),
    tool: safeCount(usage.toolTokens),
  });
}

function parseGeminiQuota(
  response: Record<string, unknown>,
  diagnose?: UsageDiagnostic,
): TokenCounters | null {
  const quota = asRecord(asRecord(response._meta)?.quota);
  if (!quota) return null;
  const counts = asRecord(quota.token_count);
  if (!counts) {
    diagnose?.("_meta.quota did not contain a token_count object");
    return null;
  }

  const input = safeCount(counts.input_tokens);
  const output = safeCount(counts.output_tokens);
  const providerTotal = safeCount(counts.total_tokens);
  if (input === null && output === null && providerTotal === null) {
    diagnose?.("_meta.quota.token_count contained no usable token counts");
    return null;
  }

  return buildCounters({
    input,
    output,
    providerTotal,
    thought: safeCount(counts.thoughts_token_count),
    cachedRead: safeCount(counts.cached_content_token_count),
    cachedWrite: null,
    tool: safeCount(counts.tool_use_prompt_token_count),
  });
}

function parseModelUsage(
  response: Record<string, unknown>,
  diagnose?: UsageDiagnostic,
): ModelTokenUsage[] {
  const quota = asRecord(asRecord(response._meta)?.quota);
  const entries = quota?.model_usage;
  if (!Array.isArray(entries)) return [];

  const result: ModelTokenUsage[] = [];
  for (const entry of entries.slice(0, 50)) {
    const record = asRecord(entry);
    const model = typeof record?.model === "string" ? record.model.trim() : "";
    const counts = asRecord(record?.token_count);
    if (!model || !counts) {
      diagnose?.("_meta.quota.model_usage entry ignored: missing model or token_count");
      continue;
    }
    const input = safeCount(counts.input_tokens) ?? 0;
    const output = safeCount(counts.output_tokens) ?? 0;
    result.push({ model: model.slice(0, 200), input, output });
  }
  return result;
}

function parseCost(value: unknown, diagnose?: UsageDiagnostic): UsageCost | null {
  const cost = asRecord(value);
  if (!cost) return null;
  const amount = cost.amount;
  const currency = cost.currency;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    typeof currency !== "string" ||
    !/^[A-Za-z]{3}$/.test(currency.trim())
  ) {
    diagnose?.("usage_update.cost dropped: amount or currency is not usable");
    return null;
  }
  return { amount, currency: currency.trim().toUpperCase() };
}

function buildCounters(input: {
  input: number | null;
  output: number | null;
  providerTotal: number | null;
  thought: number | null;
  cachedRead: number | null;
  cachedWrite: number | null;
  tool: number | null;
}): TokenCounters {
  const derived =
    input.input !== null && input.output !== null ? input.input + input.output : null;
  const total = input.providerTotal ?? derived;
  const totalKind =
    input.providerTotal !== null
      ? ("provider" as const)
      : derived !== null
        ? ("derived_input_plus_output" as const)
        : null;

  return {
    input: input.input,
    output: input.output,
    total: total !== null && Number.isSafeInteger(total) ? total : null,
    thought: input.thought,
    cachedRead: input.cachedRead,
    cachedWrite: input.cachedWrite,
    tool: input.tool,
    totalKind: total !== null && Number.isSafeInteger(total) ? totalKind : null,
  };
}

/** Adds two counter sets. Unknown values stay unknown instead of becoming zero. */
export function addTokenCounters(
  left: TokenCounters,
  right: TokenCounters,
): TokenCounters {
  const input = addCounts(left.input, right.input);
  const output = addCounts(left.output, right.output);
  const total = addCounts(left.total, right.total);
  const derivedOnly =
    left.totalKind !== "provider" && right.totalKind !== "provider";
  return {
    input,
    output,
    total,
    thought: addCounts(left.thought, right.thought),
    cachedRead: addCounts(left.cachedRead, right.cachedRead),
    cachedWrite: addCounts(left.cachedWrite, right.cachedWrite),
    tool: addCounts(left.tool, right.tool),
    totalKind:
      total === null ? null : derivedOnly ? "derived_input_plus_output" : "provider",
  };
}

function addCounts(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : null;
}

/**
 * Accepts only non-negative safe integers. Negative, non-finite, fractional and
 * unsafe values are dropped instead of being rounded into a plausible lie.
 */
export function safeCount(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
