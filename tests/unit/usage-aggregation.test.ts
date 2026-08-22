import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EMPTY_TOKEN_COUNTERS,
  type UsageTokenObservation,
} from "../../src/main/gemini/usage.js";
import { ProjectService } from "../../src/main/projects";
import {
  EventRepository,
  openSqliteDatabase,
  ProjectRepository,
  SessionRepository,
  UsageRepository,
  type SqliteDatabase,
} from "../../src/main/storage";
import { UsageService } from "../../src/main/usage";

const temporaryDirectories: string[] = [];
const timestamp = "2026-08-20T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function turnObservation(input: number, output: number): UsageTokenObservation {
  return {
    kind: "tokens",
    scope: "turn",
    source: "gemini_meta_quota",
    tokens: {
      ...EMPTY_TOKEN_COUNTERS,
      input,
      output,
      total: input + output,
      totalKind: "derived_input_plus_output",
    },
    byModel: [{ model: "gemini-2.5-pro", input, output }],
  };
}

describe("usage aggregation and persistence", () => {
  it("sums two turns exactly once and stays idempotent for a repeated turn id", async () => {
    const fixture = await createFixture();
    try {
      const turnA = randomUUID();
      const turnB = randomUUID();

      const first = fixture.usage.recordTokens({
        sessionId: fixture.sessionId,
        turnId: turnA,
        observation: turnObservation(100, 20),
        occurredAt: timestamp,
      });
      expect(first?.session).toMatchObject({
        coverage: "complete",
        source: "geminui_aggregate",
      });
      expect(first?.session?.tokens.total).toBe(120);
      expect(first?.lastTurn).toMatchObject({ turnId: turnA, source: "gemini_meta_quota" });

      const second = fixture.usage.recordTokens({
        sessionId: fixture.sessionId,
        turnId: turnB,
        observation: turnObservation(10, 5),
        occurredAt: timestamp,
      });
      expect(second?.session?.tokens).toMatchObject({ input: 110, output: 25, total: 135 });

      // The very same turn arriving again (retry, replay) must change nothing.
      expect(
        fixture.usage.recordTokens({
          sessionId: fixture.sessionId,
          turnId: turnB,
          observation: turnObservation(10, 5),
          occurredAt: timestamp,
        }),
      ).toBeNull();
      expect(fixture.usage.getSnapshot(fixture.sessionId)?.session?.tokens.total).toBe(135);
    } finally {
      fixture.database.close();
    }
  });

  it("lets a cumulative provider value replace the total instead of adding to it", async () => {
    const fixture = await createFixture();
    try {
      fixture.usage.recordTokens({
        sessionId: fixture.sessionId,
        turnId: randomUUID(),
        observation: turnObservation(100, 20),
        occurredAt: timestamp,
      });
      const snapshot = fixture.usage.recordTokens({
        sessionId: fixture.sessionId,
        turnId: randomUUID(),
        observation: {
          kind: "tokens",
          scope: "session_cumulative",
          source: "acp_prompt_usage",
          tokens: {
            ...EMPTY_TOKEN_COUNTERS,
            input: 150,
            output: 30,
            total: 180,
            totalKind: "provider",
          },
          byModel: [],
        },
        occurredAt: timestamp,
      });

      expect(snapshot?.session).toMatchObject({
        coverage: "provider_reported",
        source: "acp_prompt_usage",
      });
      expect(snapshot?.session?.tokens.total).toBe(180);
    } finally {
      fixture.database.close();
    }
  });

  it("never turns context occupancy into consumption and keeps both side by side", async () => {
    const fixture = await createFixture();
    try {
      fixture.usage.recordTokens({
        sessionId: fixture.sessionId,
        turnId: randomUUID(),
        observation: turnObservation(100, 20),
        occurredAt: timestamp,
      });
      const withContext = fixture.usage.recordContext({
        sessionId: fixture.sessionId,
        observation: {
          kind: "context",
          source: "acp_usage_update",
          used: 2_048,
          size: 8_192,
          cost: { amount: 0.01, currency: "USD" },
        },
        occurredAt: timestamp,
      });

      expect(withContext.context).toEqual({
        used: 2_048,
        size: 8_192,
        source: "acp_usage_update",
      });
      // The context update must not touch the consumption counters.
      expect(withContext.session?.tokens.total).toBe(120);
      expect(withContext.cost).toMatchObject({ amount: 0.01, currency: "USD" });

      const invalidated = fixture.usage.invalidateContext(fixture.sessionId, timestamp);
      expect(invalidated?.context).toBeNull();
      expect(invalidated?.session?.tokens.total).toBe(120);
      expect(invalidated?.lastTurn?.tokens.input).toBe(100);
    } finally {
      fixture.database.close();
    }
  });

  it("marks a session partial when an earlier turn completed without usage", async () => {
    const fixture = await createFixture();
    try {
      // A turn that finished before usage tracking existed.
      fixture.events.append({
        sessionId: fixture.sessionId,
        turnId: randomUUID(),
        timestamp,
        event: { type: "turn.completed", stopReason: "end_turn" },
      });

      const snapshot = fixture.usage.recordTokens({
        sessionId: fixture.sessionId,
        turnId: randomUUID(),
        observation: turnObservation(10, 5),
        occurredAt: timestamp,
      });
      expect(snapshot?.session?.coverage).toBe("partial");
    } finally {
      fixture.database.close();
    }
  });

  it("restores the identical snapshot from disk and drops it with the session", async () => {
    const fixture = await createFixture();
    try {
      const stored = fixture.usage.recordTokens({
        sessionId: fixture.sessionId,
        turnId: randomUUID(),
        observation: turnObservation(7, 3),
        occurredAt: timestamp,
      });

      const reopened = new UsageService(new UsageRepository(fixture.database));
      expect(reopened.getSnapshot(fixture.sessionId)).toEqual(stored);

      fixture.sessions.delete(fixture.sessionId);
      expect(reopened.getSnapshot(fixture.sessionId)).toBeNull();
      expect(
        fixture.database
          .prepare("SELECT COUNT(*) AS count FROM turn_usage WHERE session_id = ?")
          .get(fixture.sessionId),
      ).toEqual({ count: 0 });
    } finally {
      fixture.database.close();
    }
  });

  it("keeps the usage snapshot reachable past the 1000 event replay window", async () => {
    const fixture = await createFixture();
    try {
      const messageId = randomUUID();
      for (let index = 0; index < 1_050; index += 1) {
        fixture.events.append({
          sessionId: fixture.sessionId,
          turnId: null,
          timestamp,
          event: { type: "message.assistant.delta", messageId, delta: "x" },
        });
      }
      const snapshot = fixture.usage.recordTokens({
        sessionId: fixture.sessionId,
        turnId: randomUUID(),
        observation: turnObservation(42, 8),
        occurredAt: timestamp,
      });
      fixture.events.append({
        sessionId: fixture.sessionId,
        turnId: null,
        timestamp,
        event: { type: "usage.updated", snapshot: snapshot! },
      });

      // The replay window ends long before the usage event.
      const replay = fixture.events.listAfter(fixture.sessionId, 0);
      expect(replay).toHaveLength(1_000);
      expect(replay.some((envelope) => envelope.event.type === "usage.updated")).toBe(false);
      // The dedicated snapshot is reachable anyway.
      expect(fixture.usage.getSnapshot(fixture.sessionId)?.session?.tokens.total).toBe(50);
    } finally {
      fixture.database.close();
    }
  });

  it("accumulates token usage across multiple models in the same session", async () => {
    const fixture = await createFixture();
    try {
      const turnA = randomUUID();
      const turnB = randomUUID();

      fixture.usage.recordTokens({
        sessionId: fixture.sessionId,
        turnId: turnA,
        observation: {
          kind: "tokens",
          scope: "turn",
          source: "gemini_meta_quota",
          tokens: {
            ...EMPTY_TOKEN_COUNTERS,
            input: 100,
            output: 20,
            total: 120,
            totalKind: "derived_input_plus_output",
          },
          byModel: [{ model: "gemini-2.5-pro", input: 100, output: 20 }],
        },
        occurredAt: timestamp,
      });

      const second = fixture.usage.recordTokens({
        sessionId: fixture.sessionId,
        turnId: turnB,
        observation: {
          kind: "tokens",
          scope: "turn",
          source: "gemini_meta_quota",
          tokens: {
            ...EMPTY_TOKEN_COUNTERS,
            input: 50,
            output: 10,
            total: 60,
            totalKind: "derived_input_plus_output",
          },
          byModel: [{ model: "gemini-2.5-flash", input: 50, output: 10 }],
        },
        occurredAt: timestamp,
      });

      expect(second?.session?.byModel).toEqual(
        expect.arrayContaining([
          { model: "gemini-2.5-pro", input: 100, output: 20 },
          { model: "gemini-2.5-flash", input: 50, output: 10 },
        ]),
      );
      expect(second?.session?.tokens.total).toBe(180);
    } finally {
      fixture.database.close();
    }
  });
});

interface Fixture {
  readonly database: SqliteDatabase;
  readonly sessionId: string;
  readonly usage: UsageService;
  readonly events: EventRepository;
  readonly sessions: SessionRepository;
}

async function createFixture(): Promise<Fixture> {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "gem-ui-usage-"));
  temporaryDirectories.push(rootDirectory);
  const primary = path.join(rootDirectory, "primary");
  await mkdir(primary);

  const database = openSqliteDatabase(":memory:");
  const project = await new ProjectService(new ProjectRepository(database), {
    now: () => new Date(timestamp),
  }).create({
    clientRequestId: randomUUID(),
    name: "Usage fixture",
    primaryRootPath: primary,
    additionalRootPaths: [],
  });

  const sessions = new SessionRepository(database);
  const sessionId = randomUUID();
  sessions.create({
    id: sessionId,
    provider: "gemini-cli",
    providerSessionId: null,
    projectId: project.id,
    lastRootRevision: project.rootRevision,
    lastRootFingerprint: project.rootFingerprint,
    title: "Usage session",
    status: "idle",
    model: null,
    mode: null,
    pinned: false,
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    database,
    sessionId,
    usage: new UsageService(new UsageRepository(database)),
    events: new EventRepository(database),
    sessions,
  };
}
