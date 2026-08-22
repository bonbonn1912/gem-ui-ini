import type { UsageSnapshot } from "../../shared/contracts";
import type {
  UsageContextObservation,
  UsageTokenObservation,
} from "../gemini";
import type { UsageRepository } from "../storage";

export interface RecordTokensInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly observation: UsageTokenObservation;
  readonly occurredAt: string;
}

export interface RecordContextInput {
  readonly sessionId: string;
  readonly observation: UsageContextObservation;
  readonly occurredAt: string;
}

/**
 * Turns provider observations into one authoritative session snapshot.
 *
 * Two invariants shape this class:
 *  - consumption and context occupancy never bleed into each other;
 *  - a turn contributes to the session totals exactly once, even after a retry,
 *    a restart or an event replay.
 */
export class UsageService {
  readonly #repository: UsageRepository;

  constructor(repository: UsageRepository) {
    this.#repository = repository;
  }

  getSnapshot(sessionId: string): UsageSnapshot | null {
    return this.#repository.readSnapshot(sessionId)?.snapshot ?? null;
  }

  /**
   * Records the token counters of a finished turn. Returns null when nothing
   * changed, i.e. when this turn was already counted.
   */
  recordTokens(input: RecordTokensInput): UsageSnapshot | null {
    return this.#repository.transaction(() => {
      const previous = this.#repository.readSnapshot(input.sessionId)?.snapshot ?? null;
      const observation = input.observation;

      if (observation.scope === "turn") {
        const inserted = this.#repository.reserveTurn(input.sessionId, {
          turnId: input.turnId,
          source: observation.source,
          tokens: observation.tokens,
          byModel: observation.byModel,
          observedAt: input.occurredAt,
        });
        if (!inserted) return null;
      }

      const aggregate = this.#repository.aggregatedTurns(input.sessionId);
      // A provider that reports cumulative session totals stays authoritative
      // until it reports again; GeminUI's own sum must not overrule it.
      const providerSession =
        observation.scope === "session_cumulative"
          ? observation.tokens
          : previous?.session?.coverage === "provider_reported"
            ? previous.session.tokens
            : null;

      const session: UsageSnapshot["session"] = providerSession
        ? {
            tokens: providerSession,
            byModel: aggregate.byModel,
            coverage: "provider_reported",
            source: "acp_prompt_usage",
          }
        : aggregate.turns > 0
          ? {
              tokens: aggregate.tokens,
              byModel: aggregate.byModel,
              coverage: this.#repository.hasUnaccountedTurns(input.sessionId)
                ? "partial"
                : "complete",
              source: "geminui_aggregate",
            }
          : previous?.session ?? null;

      return this.#write(input.sessionId, previous, {
        lastTurn: {
          turnId: input.turnId,
          tokens: observation.tokens,
          byModel: [...observation.byModel],
          source: observation.source,
        },
        session,
        context: previous?.context ?? null,
        cost: previous?.cost ?? null,
        updatedAt: input.occurredAt,
      });
    });
  }

  /** Records context-window occupancy without touching any token counters. */
  recordContext(input: RecordContextInput): UsageSnapshot {
    return this.#repository.transaction(() => {
      const previous = this.#repository.readSnapshot(input.sessionId)?.snapshot ?? null;
      return this.#write(input.sessionId, previous, {
        lastTurn: previous?.lastTurn ?? null,
        session: previous?.session ?? null,
        context: {
          used: input.observation.used,
          size: input.observation.size,
          source: "acp_usage_update",
        },
        cost: input.observation.cost
          ? {
              amount: input.observation.cost.amount,
              currency: input.observation.cost.currency,
              source: "acp_usage_update",
            }
          : previous?.cost ?? null,
        updatedAt: input.occurredAt,
      });
    });
  }

  /**
   * Drops a context value that belongs to a model the session no longer uses.
   * The consumption history stays untouched.
   */
  invalidateContext(sessionId: string, occurredAt: string): UsageSnapshot | null {
    return this.#repository.transaction(() => {
      const previous = this.#repository.readSnapshot(sessionId)?.snapshot ?? null;
      if (!previous?.context) return null;
      return this.#write(sessionId, previous, {
        lastTurn: previous.lastTurn,
        session: previous.session,
        context: null,
        cost: previous.cost,
        updatedAt: occurredAt,
      });
    });
  }

  #write(
    sessionId: string,
    previous: UsageSnapshot | null,
    next: Omit<UsageSnapshot, "revision">,
  ): UsageSnapshot {
    return this.#repository.writeSnapshot(sessionId, {
      ...next,
      revision: (previous?.revision ?? 0) + 1,
    });
  }
}
