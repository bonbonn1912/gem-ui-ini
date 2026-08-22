import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  openSqliteDatabase,
  ProjectRepository,
  SessionRepository,
  StatsRepository,
  type SqliteDatabase,
} from "../../src/main/storage";
import { ProjectService } from "../../src/main/projects";
import {
  analyzeToolActivity,
  extractLineDiffCounts,
  mergeToolActivity,
} from "../../src/main/app-controller";

const temporaryDirectories: string[] = [];
const openDatabases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const db of openDatabases.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
    ),
  );
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gem-ui-stats-test-"));
  temporaryDirectories.push(directory);
  const database = openSqliteDatabase(":memory:");
  openDatabases.push(database);

  const projectRepository = new ProjectRepository(database);
  const projectService = new ProjectService(projectRepository);
  const sessionRepository = new SessionRepository(database);
  const statsRepository = new StatsRepository(database);

  const rootPath = path.join(directory, "project");
  await mkdir(rootPath, { recursive: true });
  const project = await projectService.create({
    clientRequestId: randomUUID(),
    name: "Stats Test Project",
    primaryRootPath: rootPath,
    additionalRootPaths: [],
  });

  const session = sessionRepository.create({
    id: randomUUID(),
    provider: "gemini-cli",
    providerSessionId: null,
    projectId: project.id,
    lastRootRevision: project.rootRevision,
    lastRootFingerprint: project.rootFingerprint,
    title: "Test Session",
    status: "idle",
    model: null,
    mode: null,
    pinned: false,
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return { database, project, session, sessionRepository, statsRepository };
}

describe("StatsRepository", () => {
  it("records turn metrics and computes aggregated summaries and comparisons", async () => {
    const { session, project, statsRepository } = await createFixture();

    const turn1 = randomUUID();
    const turn2 = randomUUID();
    const turn3 = randomUUID();

    // Turn 1: Pro model, 5000 tokens, 1200ms, 50 lines added, plan accepted
    statsRepository.recordTurnMetric({
      turnId: turn1,
      sessionId: session.id,
      projectId: project.id,
      model: "gemini-2.5-pro",
      mode: "code",
      durationMs: 1200,
      inputTokens: 4000,
      outputTokens: 1000,
      totalTokens: 5000,
      thoughtTokens: 200,
      linesAdded: 50,
      linesDeleted: 10,
      planDecision: "accepted",
      status: "completed",
      createdAt: new Date().toISOString(),
    });

    // Turn 2: Flash model, 2000 tokens, 400ms, 20 lines added, plan rejected
    statsRepository.recordTurnMetric({
      turnId: turn2,
      sessionId: session.id,
      projectId: project.id,
      model: "gemini-2.5-flash",
      mode: "chat",
      durationMs: 400,
      inputTokens: 1500,
      outputTokens: 500,
      totalTokens: 2000,
      thoughtTokens: 0,
      linesAdded: 20,
      linesDeleted: 5,
      planDecision: "rejected",
      status: "completed",
      createdAt: new Date().toISOString(),
    });

    // Turn 3: Flash model, 1000 tokens, 600ms, failed
    statsRepository.recordTurnMetric({
      turnId: turn3,
      sessionId: session.id,
      projectId: project.id,
      model: "gemini-2.5-flash",
      mode: "chat",
      durationMs: 600,
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1000,
      thoughtTokens: 0,
      linesAdded: 0,
      linesDeleted: 0,
      planDecision: null,
      status: "failed",
      createdAt: new Date().toISOString(),
    });

    const stats = statsRepository.getAggregatedStats({ timeRange: "30d", granularity: "day" });

    // Verify summary
    expect(stats.summary.totalTokens).toBe(8000);
    expect(stats.summary.inputTokens).toBe(6300);
    expect(stats.summary.outputTokens).toBe(1700);
    expect(stats.summary.thoughtTokens).toBe(200);
    expect(stats.summary.totalTurns).toBe(3);
    expect(stats.summary.totalLinesAdded).toBe(70);
    expect(stats.summary.totalLinesDeleted).toBe(15);
    expect(stats.summary.planAccepted).toBe(1);
    expect(stats.summary.planRejected).toBe(1);
    expect(stats.summary.planTotal).toBe(2);
    expect(stats.summary.planAcceptanceRate).toBe(50);
    expect(stats.summary.avgDurationMs).toBeCloseTo((1200 + 400 + 600) / 3, 0);

    // Verify model comparisons
    expect(stats.modelComparison).toHaveLength(2);

    const pro = stats.modelComparison.find((m) => m.model === "gemini-2.5-pro")!;
    expect(pro).toBeDefined();
    expect(pro.totalTokens).toBe(5000);
    expect(pro.turnCount).toBe(1);
    expect(pro.avgDurationMs).toBe(1200);
    expect(pro.linesAdded).toBe(50);
    expect(pro.errorRate).toBe(0);
    expect(pro.sharePercentage).toBe(62.5);

    const flash = stats.modelComparison.find((m) => m.model === "gemini-2.5-flash")!;
    expect(flash).toBeDefined();
    expect(flash.totalTokens).toBe(3000);
    expect(flash.turnCount).toBe(2);
    expect(flash.avgDurationMs).toBe(500);
    expect(flash.linesAdded).toBe(20);
    expect(flash.errorRate).toBe(50); // 1 out of 2 failed
    expect(flash.sharePercentage).toBe(37.5);

    // Verify time series
    expect(stats.timeSeries.length).toBeGreaterThan(0);
    const todayPoint = stats.timeSeries[stats.timeSeries.length - 1];
    expect(todayPoint.totalTokens).toBe(8000);
    expect(todayPoint.tokensByModel["gemini-2.5-pro"]?.total).toBe(5000);
    expect(todayPoint.tokensByModel["gemini-2.5-flash"]?.total).toBe(3000);
    expect(todayPoint.linesAdded).toBe(70);
    expect(todayPoint.planAccepted).toBe(1);
    expect(todayPoint.planRejected).toBe(1);
  });

  it("updates plan decision on an existing turn", async () => {
    const { session, project, statsRepository } = await createFixture();

    const turnId = randomUUID();
    statsRepository.recordTurnMetric({
      turnId,
      sessionId: session.id,
      projectId: project.id,
      model: "gemini-2.5-pro",
      mode: "plan",
      durationMs: 900,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      thoughtTokens: 100,
      linesAdded: 0,
      linesDeleted: 0,
      planDecision: null,
      status: "completed",
      createdAt: new Date().toISOString(),
    });

    let stats = statsRepository.getAggregatedStats({ timeRange: "7d", granularity: "day" });
    expect(stats.summary.planTotal).toBe(0);

    statsRepository.recordPlanDecision(session.id, turnId, "accepted");

    stats = statsRepository.getAggregatedStats({ timeRange: "7d", granularity: "day" });
    expect(stats.summary.planTotal).toBe(1);
    expect(stats.summary.planAccepted).toBe(1);
    expect(stats.summary.planAcceptanceRate).toBe(100);
  });

  it("filters stats by selected model", async () => {
    const { session, project, statsRepository } = await createFixture();

    statsRepository.recordTurnMetric({
      turnId: randomUUID(),
      sessionId: session.id,
      projectId: project.id,
      model: "gemini-2.5-pro",
      mode: "code",
      durationMs: 1000,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      thoughtTokens: 0,
      linesAdded: 10,
      linesDeleted: 0,
      planDecision: null,
      status: "completed",
      createdAt: new Date().toISOString(),
    });

    statsRepository.recordTurnMetric({
      turnId: randomUUID(),
      sessionId: session.id,
      projectId: project.id,
      model: "gemini-2.5-flash",
      mode: "chat",
      durationMs: 300,
      inputTokens: 500,
      outputTokens: 200,
      totalTokens: 700,
      thoughtTokens: 0,
      linesAdded: 5,
      linesDeleted: 0,
      planDecision: null,
      status: "completed",
      createdAt: new Date().toISOString(),
    });

    const proStats = statsRepository.getAggregatedStats({
      timeRange: "30d",
      granularity: "day",
      model: "gemini-2.5-pro",
    });

    expect(proStats.summary.totalTokens).toBe(1500);
    expect(proStats.summary.totalTurns).toBe(1);
    expect(proStats.summary.totalLinesAdded).toBe(10);
    // availableModels must still return both models so dropdown does not disappear
    expect(proStats.availableModels).toContain("gemini-2.5-pro");
    expect(proStats.availableModels).toContain("gemini-2.5-flash");
  });

  it("calculates cache-hit-rate, cached tokens and input/output percentages correctly", async () => {
    const { session, project, statsRepository } = await createFixture();

    // Turn with cached tokens: 3000 input, 1000 cached, 1000 output = 4000 total (3000 input + 1000 output)
    // cache hit rate = (1000 / (3000 + 1000)) * 100% = 25%
    // input percentage = (3000 / 4000) * 100% = 75%
    // output percentage = (1000 / 4000) * 100% = 25%
    statsRepository.recordTurnMetric({
      turnId: randomUUID(),
      sessionId: session.id,
      projectId: project.id,
      model: "gemini-2.5-pro",
      mode: "code",
      durationMs: 1000,
      inputTokens: 3000,
      outputTokens: 1000,
      cachedTokens: 1000,
      totalTokens: 4000,
      thoughtTokens: 0,
      linesAdded: 15,
      linesDeleted: 0,
      planDecision: null,
      status: "completed",
      createdAt: new Date().toISOString(),
    });

    const stats = statsRepository.getAggregatedStats({ timeRange: "30d", granularity: "day" });

    expect(stats.summary.cachedTokens).toBe(1000);
    expect(stats.summary.cacheHitRate).toBe(25);
    expect(stats.summary.inputPercentage).toBe(75);
    expect(stats.summary.outputPercentage).toBe(25);

    const pro = stats.modelComparison.find((m) => m.model === "gemini-2.5-pro")!;
    expect(pro.cachedTokens).toBe(1000);
    expect(pro.cacheHitRate).toBe(25);
    expect(pro.inputPercentage).toBe(75);
    expect(pro.outputPercentage).toBe(25);
  });

  it("persists project statsEnabled setting and defaults to false", async () => {
    const { database, project } = await createFixture();
    const projectRepo = new ProjectRepository(database);

    // Initial state: default false
    const initial = projectRepo.getById(project.id);
    expect(initial.statsEnabled).toBe(false);

    // Enable stats
    const enabled = projectRepo.setStatsEnabled(project.id, true);
    expect(enabled.statsEnabled).toBe(true);

    const fetched = projectRepo.getById(project.id);
    expect(fetched.statsEnabled).toBe(true);

    // Disable stats again
    const disabled = projectRepo.setStatsEnabled(project.id, false);
    expect(disabled.statsEnabled).toBe(false);
  });

  describe("extractLineDiffCounts", () => {
    it("extracts added and deleted lines from write_to_file tool calls", () => {
      const toolCall = {
        toolCallId: "call-1",
        rawInput: {
          TargetFile: "/src/hello.ts",
          CodeContent: "const a = 1;\nconst b = 2;\nconst c = 3;\n",
        },
      };
      const diff = extractLineDiffCounts(toolCall);
      expect(diff.added).toBe(3);
      expect(diff.deleted).toBe(0);
    });

    it("extracts added and deleted lines from replace_file_content tool calls", () => {
      const toolCall = {
        toolCallId: "call-2",
        rawInput: {
          TargetFile: "/src/hello.ts",
          TargetContent: "const a = 1;\n",
          ReplacementContent: "const a = 10;\nconst a2 = 20;\n",
        },
      };
      const diff = extractLineDiffCounts(toolCall);
      expect(diff.added).toBe(2);
      expect(diff.deleted).toBe(1);
    });

    it("extracts from old_str / new_str edits (stringified JSON rawInput)", () => {
      const toolCall = {
        toolCallId: "call-3",
        rawInput: JSON.stringify({
          path: "file.js",
          old_str: "function oldFn() {\n  return 1;\n}\n",
          new_str: "function newFn() {\n  return 2;\n}\n",
        }),
      };
      const diff = extractLineDiffCounts(toolCall);
      expect(diff.added).toBe(3);
      expect(diff.deleted).toBe(3);
    });

    it("extracts from unified diff patches", () => {
      const toolCall = {
        toolCallId: "call-4",
        rawInput: {
          patch: "--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n unchanged\n-deleted line 1\n-deleted line 2\n+added line 1\n+added line 2\n+added line 3\n",
        },
      };
      const diff = extractLineDiffCounts(toolCall);
      expect(diff.added).toBe(3);
      expect(diff.deleted).toBe(2);
    });

    it("extracts from content array with diff blocks", () => {
      const toolCall = {
        toolCallId: "call-5",
        content: [
          {
            type: "diff",
            diff: "@@ -1,2 +1,114 @@\n-lineA\n+lineB\n+lineC\n",
          },
        ],
      };
      const diff = extractLineDiffCounts(toolCall);
      expect(diff.added).toBe(2);
      expect(diff.deleted).toBe(1);
    });
  });

  describe("analyzeToolActivity", () => {
    it("analyzes file creation and modification", () => {
      const createCall = {
        toolCallId: "c1",
        name: "write_to_file",
        rawInput: { TargetFile: "new-file.ts", CodeContent: "line1\nline2\n" },
      };
      const act1 = analyzeToolActivity(createCall);
      expect(act1.filesCreated).toBe(1);
      expect(act1.filesModified).toBe(0);
      expect(act1.filesDeleted).toBe(0);

      const editCall = {
        toolCallId: "c2",
        name: "replace_file_content",
        rawInput: { TargetFile: "existing.ts", TargetContent: "old\n", ReplacementContent: "new\n" },
      };
      const act2 = analyzeToolActivity(editCall);
      expect(act2.filesCreated).toBe(0);
      expect(act2.filesModified).toBe(1);
      expect(act2.filesDeleted).toBe(0);

      const delCall = {
        toolCallId: "c3",
        name: "delete_file",
        rawInput: { path: "old.ts" },
      };
      const act3 = analyzeToolActivity(delCall);
      expect(act3.filesDeleted).toBe(1);
    });

    it("analyzes skill calls and MCP tools", () => {
      const skillCall = {
        toolCallId: "s1",
        name: "run_skill",
        rawInput: { skillName: "agy-customizations" },
      };
      const act1 = analyzeToolActivity(skillCall);
      expect(act1.skills).toEqual(["agy-customizations"]);

      const mcpCall = {
        toolCallId: "m1",
        name: "mcp__github__create_issue",
        rawInput: { title: "Bug" },
      };
      const act2 = analyzeToolActivity(mcpCall);
      expect(act2.mcpTools).toEqual(["github:create_issue"]);
    });

    it("analyzes git and shell commands", () => {
      const shellCall = {
        toolCallId: "sh1",
        name: "run_command",
        rawInput: { CommandLine: "npm test && git commit -m 'feat' && rm temp.txt" },
      };
      const act = analyzeToolActivity(shellCall);
      expect(act.shellCommands).toContain("npm test");
      expect(act.shellCommands).toContain("git commit");
      expect(act.shellCommands).toContain("rm");
      expect(act.gitActions).toContain("commit");
      expect(act.filesDeleted).toBe(1);
    });

    /**
     * Regression: Gemini CLI setzt über ACP weder `name` noch `rawInput`. Die
     * Auswertung stützte sich genau darauf und lieferte deshalb im echten
     * Betrieb dauerhaft Nullen — obwohl die Tests oben grün waren, weil sie
     * die Eingabe konstruierten, die die Auswertung erwartete.
     */
    it("erkennt Gemini-Aufrufe, die nur title und kind mitschicken", () => {
      const shell = analyzeToolActivity({
        toolCallId: "g1",
        title: "git commit -m 'fix' (Committet die Änderung)",
        kind: "execute",
        status: "in_progress",
      } as never);
      expect(shell.shellCommands).toContain("git commit");
      expect(shell.gitActions).toContain("commit");

      const npm = analyzeToolActivity({
        toolCallId: "g2",
        title: "npm test",
        kind: "execute",
      } as never);
      expect(npm.shellCommands).toContain("npm test");

      const skill = analyzeToolActivity({
        toolCallId: "g3",
        title: 'Activate skill "pdf"',
        kind: "other",
      } as never);
      expect(skill.skills).toEqual(["pdf"]);

      const mcp = analyzeToolActivity({
        toolCallId: "g4",
        title: "create_issue (github MCP Server)",
        kind: "other",
      } as never);
      expect(mcp.mcpTools).toEqual(["github:create_issue"]);
    });

    it("unterscheidet neue von geänderten Dateien am Diff-Inhalt", () => {
      const created = analyzeToolActivity({
        toolCallId: "d1",
        title: "src/neu.ts",
        kind: "edit",
        content: [{ type: "diff", path: "src/neu.ts", oldText: null, newText: "a\nb\n" }],
      } as never);
      expect(created.filesCreated).toBe(1);
      expect(created.filesModified).toBe(0);

      const changed = analyzeToolActivity({
        toolCallId: "d2",
        title: "src/alt.ts",
        kind: "edit",
        content: [{ type: "diff", path: "src/alt.ts", oldText: "a\n", newText: "b\n" }],
      } as never);
      expect(changed.filesCreated).toBe(0);
      expect(changed.filesModified).toBe(1);
    });

    /**
     * Regression: Ein Werkzeugaufruf erzeugt mehrere ACP-Nachrichten. Nur die
     * erste trägt Titel und Art, die folgenden Updates sind für die
     * Einordnung leer. Ohne Zusammenführung überschrieb das letzte Update die
     * Auswertung der ersten Nachricht — der eigentliche Grund für die leeren
     * Statistiken.
     */
    it("führt die Nachrichten eines Aufrufs zusammen, statt sie zu überschreiben", () => {
      const start = analyzeToolActivity({
        toolCallId: "m1",
        title: "git push",
        kind: "execute",
        status: "in_progress",
      } as never);
      const completed = analyzeToolActivity({
        toolCallId: "m1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      } as never);

      // Das Abschluss-Update allein weiß nichts mehr:
      expect(completed.shellCommands).toEqual([]);

      const merged = mergeToolActivity(start, completed);
      expect(merged.shellCommands).toContain("git push");
      expect(merged.gitActions).toContain("push");

      // Dieselbe Nachricht doppelt verarbeitet zählt nicht doppelt.
      expect(mergeToolActivity(merged, start).shellCommands).toEqual(["git push"]);
    });
  });

  it("records and aggregates extended activity metrics (files, skills, mcp, git, shell)", async () => {
    const { session, project, statsRepository } = await createFixture();
    const turnId = randomUUID();

    statsRepository.recordTurnMetric({
      turnId,
      sessionId: session.id,
      projectId: project.id,
      model: "gemini-2.5-pro",
      durationMs: 1500,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      thoughtTokens: 20,
      cachedTokens: 25,
      linesAdded: 10,
      linesDeleted: 2,
      filesCreated: 2,
      filesModified: 3,
      filesDeleted: 1,
      skillsUsedJson: JSON.stringify({ "agy-customizations": 3, "code-review": 1 }),
      mcpUsedJson: JSON.stringify({ "github:create_issue": 2 }),
      gitActionsJson: JSON.stringify({ commit: 1, diff: 2, push: 1 }),
      shellCommandsJson: JSON.stringify({ "npm test": 4, "git commit": 1 }),
      status: "completed",
    });

    const stats = statsRepository.getAggregatedStats({ timeRange: "30d", granularity: "day" });

    expect(stats.summary.filesCreated).toBe(2);
    expect(stats.summary.filesModified).toBe(3);
    expect(stats.summary.filesDeleted).toBe(1);
    expect(stats.summary.skillsUsedTotal).toBe(4);
    expect(stats.summary.mcpUsedTotal).toBe(2);
    expect(stats.summary.gitActionsTotal).toBe(4);
    expect(stats.summary.shellCommandsTotal).toBe(5);

    expect(stats.summary.topSkills).toEqual([
      { name: "agy-customizations", count: 3 },
      { name: "code-review", count: 1 },
    ]);
    expect(stats.summary.topMcpTools).toEqual([
      { name: "github:create_issue", count: 2 },
    ]);
    expect(stats.summary.topGitActions).toEqual([
      { name: "diff", count: 2 },
      { name: "commit", count: 1 },
      { name: "push", count: 1 },
    ]);
    expect(stats.summary.topShellCommands).toEqual([
      { name: "npm test", count: 4 },
      { name: "git commit", count: 1 },
    ]);

    const point = stats.timeSeries[stats.timeSeries.length - 1];
    expect(point.filesCreated).toBe(2);
    expect(point.filesModified).toBe(3);
    expect(point.filesDeleted).toBe(1);
    expect(point.skillsUsed).toBe(4);
    expect(point.mcpUsed).toBe(2);
    expect(point.gitActions).toBe(4);
    expect(point.shellCommands).toBe(5);
  });

  it("preserves turn metrics globally in stats even when a session is deleted", async () => {
    const { session, sessionRepository, project, statsRepository } = await createFixture();
    const turnId = randomUUID();

    // 1. Record metrics for session
    statsRepository.recordTurnMetric({
      turnId,
      sessionId: session.id,
      projectId: project.id,
      model: "gemini-2.5-pro",
      durationMs: 2000,
      inputTokens: 5000,
      outputTokens: 1000,
      totalTokens: 6000,
      thoughtTokens: 500,
      cachedTokens: 1000,
      linesAdded: 25,
      linesDeleted: 5,
      filesCreated: 1,
      filesModified: 2,
      filesDeleted: 0,
      skillsUsedJson: JSON.stringify({ "agy-customizations": 1 }),
      mcpUsedJson: JSON.stringify({ "github:create_issue": 1 }),
      gitActionsJson: JSON.stringify({ commit: 1 }),
      shellCommandsJson: JSON.stringify({ "npm test": 2 }),
      status: "completed",
    });

    // Verify stats before session deletion
    let stats = statsRepository.getAggregatedStats({ timeRange: "all", granularity: "day" });
    expect(stats.summary.totalTokens).toBe(6000);
    expect(stats.summary.totalTurns).toBe(1);

    // 2. Delete the session
    sessionRepository.delete(session.id);

    // 3. Verify session was deleted from sessions table
    expect(sessionRepository.findById(session.id)).toBeNull();

    // 4. Verify turn metrics and statistics persist completely intact!
    stats = statsRepository.getAggregatedStats({ timeRange: "all", granularity: "day" });
    expect(stats.summary.totalTokens).toBe(6000);
    expect(stats.summary.inputTokens).toBe(5000);
    expect(stats.summary.outputTokens).toBe(1000);
    expect(stats.summary.cachedTokens).toBe(1000);
    expect(stats.summary.totalTurns).toBe(1);
    expect(stats.summary.totalLinesAdded).toBe(25);
    expect(stats.summary.totalLinesDeleted).toBe(5);
    expect(stats.summary.filesCreated).toBe(1);
    expect(stats.summary.filesModified).toBe(2);
    expect(stats.summary.skillsUsedTotal).toBe(1);
    expect(stats.summary.mcpUsedTotal).toBe(1);
    expect(stats.summary.gitActionsTotal).toBe(1);
    expect(stats.summary.shellCommandsTotal).toBe(2);
    expect(stats.summary.topSkills).toEqual([{ name: "agy-customizations", count: 1 }]);
    expect(stats.summary.topShellCommands).toEqual([{ name: "npm test", count: 2 }]);
  });
});
