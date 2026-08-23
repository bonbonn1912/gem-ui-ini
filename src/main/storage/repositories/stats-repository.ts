import type {
  AppStats,
  GetStatsInput,
  ModelComparisonItem,
  ModelTokenBreakdown,
  StatsGranularity,
  StatsSummary,
  StatsTimeSeriesPoint,
  TokensPerSecondPoint,
} from "../../../shared/contracts";
import type { SqliteDatabase } from "../database";

export type TurnMetricRow = {
  readonly turnId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly model: string;
  readonly mode?: string | null;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly thoughtTokens?: number;
  readonly cachedTokens?: number;
  readonly linesAdded?: number;
  readonly linesDeleted?: number;
  readonly filesCreated?: number;
  readonly filesModified?: number;
  readonly filesDeleted?: number;
  readonly skillsUsedJson?: string;
  readonly mcpUsedJson?: string;
  readonly gitActionsJson?: string;
  readonly shellCommandsJson?: string;
  readonly planDecision?: "accepted" | "rejected" | null;
  readonly status?: "completed" | "cancelled" | "failed";
  readonly createdAt?: string;
};

type SummarySqlRow = {
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thought_tokens: number | null;
  cached_tokens: number | null;
  total_duration_ms: number | null;
  avg_duration_ms: number | null;
  lines_added: number | null;
  lines_deleted: number | null;
  files_created: number | null;
  files_modified: number | null;
  files_deleted: number | null;
  total_turns: number;
  completed_turns: number;
  failed_turns: number;
  cancelled_turns: number;
  plan_accepted: number;
  plan_rejected: number;
  active_projects: number;
  active_sessions: number;
};

type ModelComparisonSqlRow = {
  model: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thought_tokens: number | null;
  cached_tokens: number | null;
  total_duration_ms: number | null;
  avg_duration_ms: number | null;
  turn_count: number;
  lines_added: number | null;
  lines_deleted: number | null;
  failed_turns: number;
};

type TimeSeriesSqlRow = {
  period: string;
  model: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thought_tokens: number | null;
  cached_tokens: number | null;
  avg_duration_ms: number | null;
  lines_added: number | null;
  lines_deleted: number | null;
  files_created: number | null;
  files_modified: number | null;
  files_deleted: number | null;
  plan_accepted: number;
  plan_rejected: number;
  turn_count: number;
};

export class StatsRepository {
  constructor(private readonly database: SqliteDatabase) {
    this.backfillHistoricalIfEmpty();
  }

  /**
   * Records or updates a turn metric row.
   */
  recordTurnMetric(metric: TurnMetricRow): void {
    const createdAt = metric.createdAt ?? new Date().toISOString();
    const status = metric.status ?? "completed";
    const mode = metric.mode ?? null;
    const planDecision = metric.planDecision ?? null;
    const model = metric.model.trim() || "unknown";

    this.database
      .prepare(
        `INSERT INTO turn_metrics (
           turn_id, session_id, project_id, model, mode, duration_ms,
           input_tokens, output_tokens, total_tokens, thought_tokens, cached_tokens,
           lines_added, lines_deleted, files_created, files_modified, files_deleted,
           skills_used_json, mcp_used_json, git_actions_json, shell_commands_json,
           plan_decision, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, turn_id) DO UPDATE SET
           project_id = excluded.project_id,
           model = CASE WHEN excluded.model != 'unknown' THEN excluded.model ELSE turn_metrics.model END,
           mode = COALESCE(excluded.mode, turn_metrics.mode),
           duration_ms = excluded.duration_ms,
           input_tokens = MAX(turn_metrics.input_tokens, excluded.input_tokens),
           output_tokens = MAX(turn_metrics.output_tokens, excluded.output_tokens),
           total_tokens = MAX(turn_metrics.total_tokens, excluded.total_tokens),
           thought_tokens = MAX(turn_metrics.thought_tokens, excluded.thought_tokens),
           cached_tokens = MAX(turn_metrics.cached_tokens, excluded.cached_tokens),
           lines_added = MAX(turn_metrics.lines_added, excluded.lines_added),
           lines_deleted = MAX(turn_metrics.lines_deleted, excluded.lines_deleted),
           files_created = MAX(turn_metrics.files_created, excluded.files_created),
           files_modified = MAX(turn_metrics.files_modified, excluded.files_modified),
           files_deleted = MAX(turn_metrics.files_deleted, excluded.files_deleted),
           skills_used_json = excluded.skills_used_json,
           mcp_used_json = excluded.mcp_used_json,
           git_actions_json = excluded.git_actions_json,
           shell_commands_json = excluded.shell_commands_json,
           plan_decision = COALESCE(excluded.plan_decision, turn_metrics.plan_decision),
           status = excluded.status,
           created_at = excluded.created_at`,
      )
      .run(
        metric.turnId,
        metric.sessionId,
        metric.projectId,
        model,
        mode,
        Math.max(0, Math.round(metric.durationMs)),
        Math.max(0, metric.inputTokens ?? 0),
        Math.max(0, metric.outputTokens ?? 0),
        Math.max(0, metric.totalTokens ?? 0),
        Math.max(0, metric.thoughtTokens ?? 0),
        Math.max(0, metric.cachedTokens ?? 0),
        Math.max(0, metric.linesAdded ?? 0),
        Math.max(0, metric.linesDeleted ?? 0),
        Math.max(0, metric.filesCreated ?? 0),
        Math.max(0, metric.filesModified ?? 0),
        Math.max(0, metric.filesDeleted ?? 0),
        metric.skillsUsedJson ?? "{}",
        metric.mcpUsedJson ?? "{}",
        metric.gitActionsJson ?? "{}",
        metric.shellCommandsJson ?? "{}",
        planDecision,
        status,
        createdAt,
      );
  }

  /**
   * Records a plan decision for a turn or session.
   */
  recordPlanDecision(
    sessionId: string,
    turnId: string | null,
    decision: "accepted" | "rejected",
    _timestamp: string = new Date().toISOString(),
  ): void {
    if (turnId) {
      this.database
        .prepare(
          `UPDATE turn_metrics
           SET plan_decision = ?
           WHERE session_id = ? AND turn_id = ?`,
        )
        .run(decision, sessionId, turnId);
    }
  }

  /**
   * Reads aggregated stats for the specified time range and granularity.
   */
  getAggregatedStats(query: GetStatsInput = { timeRange: "30d", granularity: "day" }): AppStats {
    const timeRange = query.timeRange ?? "30d";
    const granularity = query.granularity ?? "day";
    const projectId = query.projectId;
    const filterModel = query.model;

    const startDate = getRangeStartDate(timeRange);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (startDate) {
      conditions.push("m.created_at >= ?");
      params.push(startDate.toISOString());
    }
    if (projectId) {
      conditions.push("m.project_id = ?");
      params.push(projectId);
    }
    if (filterModel) {
      conditions.push("m.model = ?");
      params.push(filterModel);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 1. Summary
    const summaryRow = this.database
      .prepare(
        `SELECT
           SUM(m.total_tokens) AS total_tokens,
           SUM(m.input_tokens) AS input_tokens,
           SUM(m.output_tokens) AS output_tokens,
           SUM(m.thought_tokens) AS thought_tokens,
           SUM(m.cached_tokens) AS cached_tokens,
           SUM(m.duration_ms) AS total_duration_ms,
           AVG(CASE WHEN m.duration_ms > 0 THEN m.duration_ms ELSE NULL END) AS avg_duration_ms,
           SUM(m.lines_added) AS lines_added,
           SUM(m.lines_deleted) AS lines_deleted,
           SUM(m.files_created) AS files_created,
           SUM(m.files_modified) AS files_modified,
           SUM(m.files_deleted) AS files_deleted,
           COUNT(*) AS total_turns,
           SUM(CASE WHEN m.status = 'completed' THEN 1 ELSE 0 END) AS completed_turns,
           SUM(CASE WHEN m.status = 'failed' THEN 1 ELSE 0 END) AS failed_turns,
           SUM(CASE WHEN m.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_turns,
           SUM(CASE WHEN m.plan_decision = 'accepted' THEN 1 ELSE 0 END) AS plan_accepted,
           SUM(CASE WHEN m.plan_decision = 'rejected' THEN 1 ELSE 0 END) AS plan_rejected,
           COUNT(DISTINCT m.project_id) AS active_projects,
           COUNT(DISTINCT m.session_id) AS active_sessions
         FROM turn_metrics m
         ${whereClause}`,
      )
      .get(...params) as SummarySqlRow;

    const planAccepted = summaryRow.plan_accepted || 0;
    const planRejected = summaryRow.plan_rejected || 0;
    const planTotal = planAccepted + planRejected;
    const planAcceptanceRate =
      planTotal > 0 ? Math.round((planAccepted / planTotal) * 1000) / 10 : 0;

    const inTokens = summaryRow.input_tokens || 0;
    const outTokens = summaryRow.output_tokens || 0;
    const thoughtTokens = summaryRow.thought_tokens || 0;
    const cachedTokens = summaryRow.cached_tokens || 0;
    const tokenSum = inTokens + outTokens + thoughtTokens;

    const inputPercentage =
      tokenSum > 0 ? Math.round((inTokens / tokenSum) * 1000) / 10 : 0;
    const outputPercentage =
      tokenSum > 0 ? Math.round((outTokens / tokenSum) * 1000) / 10 : 0;
    const cacheHitRate =
      inTokens + cachedTokens > 0
        ? Math.round((cachedTokens / (inTokens + cachedTokens)) * 1000) / 10
        : 0;

    // Query JSON fields for activity totals and rankings
    const activityRows = this.database
      .prepare(
        `SELECT
           skills_used_json,
           mcp_used_json,
           git_actions_json,
           shell_commands_json
         FROM turn_metrics m
         ${whereClause}`,
      )
      .all(...params) as Array<{
        skills_used_json?: string;
        mcp_used_json?: string;
        git_actions_json?: string;
        shell_commands_json?: string;
      }>;

    const skillsTotals: Record<string, number> = {};
    const mcpTotals: Record<string, number> = {};
    const gitTotals: Record<string, number> = {};
    const shellTotals: Record<string, number> = {};

    for (const r of activityRows) {
      mergeJsonCounts(skillsTotals, r.skills_used_json);
      mergeJsonCounts(mcpTotals, r.mcp_used_json);
      mergeJsonCounts(gitTotals, r.git_actions_json);
      mergeJsonCounts(shellTotals, r.shell_commands_json);
    }

    const toTopList = (rec: Record<string, number>, limit = 10) =>
      Object.entries(rec)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

    const sumRec = (rec: Record<string, number>) =>
      Object.values(rec).reduce((a, b) => a + b, 0);

    const totalOut = summaryRow.output_tokens || 0;
    const totalDur = summaryRow.total_duration_ms || 0;
    const avgTokensPerSecond =
      totalDur > 0 && totalOut > 0
        ? Math.round((totalOut / (totalDur / 1000)) * 10) / 10
        : 0;

    const summary: StatsSummary = {
      totalTokens: summaryRow.total_tokens || 0,
      inputTokens: inTokens,
      outputTokens: outTokens,
      thoughtTokens,
      cachedTokens,
      cacheHitRate,
      inputPercentage,
      outputPercentage,
      avgDurationMs: Math.round(summaryRow.avg_duration_ms || 0),
      totalDurationMs: summaryRow.total_duration_ms || 0,
      avgTokensPerSecond,
      totalLinesAdded: summaryRow.lines_added || 0,
      totalLinesDeleted: summaryRow.lines_deleted || 0,
      filesCreated: summaryRow.files_created || 0,
      filesModified: summaryRow.files_modified || 0,
      filesDeleted: summaryRow.files_deleted || 0,
      skillsUsedTotal: sumRec(skillsTotals),
      mcpUsedTotal: sumRec(mcpTotals),
      gitActionsTotal: sumRec(gitTotals),
      shellCommandsTotal: sumRec(shellTotals),
      topSkills: toTopList(skillsTotals),
      topMcpTools: toTopList(mcpTotals),
      topGitActions: toTopList(gitTotals),
      topShellCommands: toTopList(shellTotals),
      totalTurns: summaryRow.total_turns || 0,
      completedTurns: summaryRow.completed_turns || 0,
      failedTurns: summaryRow.failed_turns || 0,
      cancelledTurns: summaryRow.cancelled_turns || 0,
      planAccepted,
      planRejected,
      planTotal,
      planAcceptanceRate,
      activeProjectsCount: summaryRow.active_projects || 0,
      activeSessionsCount: summaryRow.active_sessions || 0,
    };

    // 2. Model Comparison
    const modelRows = this.database
      .prepare(
        `SELECT
           m.model,
           SUM(m.total_tokens) AS total_tokens,
           SUM(m.input_tokens) AS input_tokens,
           SUM(m.output_tokens) AS output_tokens,
           SUM(m.thought_tokens) AS thought_tokens,
           SUM(m.cached_tokens) AS cached_tokens,
           SUM(m.duration_ms) AS total_duration_ms,
           AVG(CASE WHEN m.duration_ms > 0 THEN m.duration_ms ELSE NULL END) AS avg_duration_ms,
           COUNT(*) AS turn_count,
           SUM(m.lines_added) AS lines_added,
           SUM(m.lines_deleted) AS lines_deleted,
           SUM(CASE WHEN m.status = 'failed' THEN 1 ELSE 0 END) AS failed_turns
         FROM turn_metrics m
         ${whereClause}
         GROUP BY m.model
         ORDER BY total_tokens DESC`,
      )
      .all(...params) as ModelComparisonSqlRow[];

    const totalModelTokens = modelRows.reduce(
      (acc, r) => acc + (r.total_tokens || 0),
      0,
    );

    const modelComparison: ModelComparisonItem[] = modelRows.map((row) => {
      const rowTotal = row.total_tokens || 0;
      const mInput = row.input_tokens || 0;
      const mOutput = row.output_tokens || 0;
      const mThought = row.thought_tokens || 0;
      const mCached = row.cached_tokens || 0;
      const turnCount = row.turn_count || 0;
      const failed = row.failed_turns || 0;
      const errorRate =
        turnCount > 0 ? Math.round((failed / turnCount) * 1000) / 10 : 0;
      const sharePercentage =
        totalModelTokens > 0
          ? Math.round((rowTotal / totalModelTokens) * 1000) / 10
          : 0;

      const mSum = mInput + mOutput + mThought;
      const mInputPercentage =
        mSum > 0 ? Math.round((mInput / mSum) * 1000) / 10 : 0;
      const mOutputPercentage =
        mSum > 0 ? Math.round((mOutput / mSum) * 1000) / 10 : 0;
      const mCacheHitRate =
        mInput + mCached > 0
          ? Math.round((mCached / (mInput + mCached)) * 1000) / 10
          : 0;

      const mTotalDur = row.total_duration_ms || 0;
      const mTokensPerSecond =
        mTotalDur > 0 && mOutput > 0
          ? Math.round((mOutput / (mTotalDur / 1000)) * 10) / 10
          : 0;

      return {
        model: row.model,
        displayName: formatModelDisplayName(row.model),
        totalTokens: rowTotal,
        inputTokens: mInput,
        outputTokens: mOutput,
        thoughtTokens: mThought,
        cachedTokens: mCached,
        cacheHitRate: mCacheHitRate,
        inputPercentage: mInputPercentage,
        outputPercentage: mOutputPercentage,
        avgDurationMs: Math.round(row.avg_duration_ms || 0),
        totalDurationMs: mTotalDur,
        tokensPerSecond: mTokensPerSecond,
        turnCount,
        linesAdded: row.lines_added || 0,
        linesDeleted: row.lines_deleted || 0,
        failedTurns: failed,
        errorRate,
        sharePercentage,
      };
    });

    // Query availableModels WITHOUT the model filter so the filter dropdown never collapses
    const availableConditions: string[] = [];
    const availableParams: unknown[] = [];
    if (startDate) {
      availableConditions.push("created_at >= ?");
      availableParams.push(startDate.toISOString());
    }
    if (projectId) {
      availableConditions.push("project_id = ?");
      availableParams.push(projectId);
    }
    const availableWhere =
      availableConditions.length > 0 ? `WHERE ${availableConditions.join(" AND ")}` : "";
    const distinctModelRows = this.database
      .prepare(
        `SELECT DISTINCT model
         FROM turn_metrics
         ${availableWhere}
         ORDER BY model ASC`,
      )
      .all(...availableParams) as Array<{ model: string }>;
    const availableModels = distinctModelRows
      .map((r) => r.model)
      .filter((m) => Boolean(m) && m !== "unknown");

    // 3. Time Series
    const periodSql = getPeriodSql(granularity);

    const timeSeriesRows = this.database
      .prepare(
        `SELECT
           ${periodSql} AS period,
           m.model,
           SUM(m.total_tokens) AS total_tokens,
           SUM(m.input_tokens) AS input_tokens,
           SUM(m.output_tokens) AS output_tokens,
           SUM(m.thought_tokens) AS thought_tokens,
           SUM(m.cached_tokens) AS cached_tokens,
           AVG(CASE WHEN m.duration_ms > 0 THEN m.duration_ms ELSE NULL END) AS avg_duration_ms,
           SUM(m.lines_added) AS lines_added,
           SUM(m.lines_deleted) AS lines_deleted,
           SUM(m.files_created) AS files_created,
           SUM(m.files_modified) AS files_modified,
           SUM(m.files_deleted) AS files_deleted,
           SUM(CASE WHEN m.plan_decision = 'accepted' THEN 1 ELSE 0 END) AS plan_accepted,
           SUM(CASE WHEN m.plan_decision = 'rejected' THEN 1 ELSE 0 END) AS plan_rejected,
           COUNT(*) AS turn_count
         FROM turn_metrics m
         ${whereClause}
         GROUP BY period, m.model
         ORDER BY period ASC`,
      )
      .all(...params) as TimeSeriesSqlRow[];

    // Group rows by period
    const periodsMap = new Map<
      string,
      {
        totalTokens: number;
        inputTokens: number;
        outputTokens: number;
        thoughtTokens: number;
        cachedTokens: number;
        tokensByModel: Record<string, ModelTokenBreakdown>;
        durationWeights: number;
        durationSum: number;
        durationByModel: Record<string, number>;
        linesAdded: number;
        linesDeleted: number;
        filesCreated: number;
        filesModified: number;
        filesDeleted: number;
        skillsUsed: number;
        mcpUsed: number;
        gitActions: number;
        shellCommands: number;
        planAccepted: number;
        planRejected: number;
        turnsCount: number;
      }
    >();

    for (const row of timeSeriesRows) {
      let entry = periodsMap.get(row.period);
      if (!entry) {
        entry = {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          cachedTokens: 0,
          tokensByModel: {},
          durationWeights: 0,
          durationSum: 0,
          durationByModel: {},
          linesAdded: 0,
          linesDeleted: 0,
          filesCreated: 0,
          filesModified: 0,
          filesDeleted: 0,
          skillsUsed: 0,
          mcpUsed: 0,
          gitActions: 0,
          shellCommands: 0,
          planAccepted: 0,
          planRejected: 0,
          turnsCount: 0,
        };
        periodsMap.set(row.period, entry);
      }

      const input = row.input_tokens || 0;
      const output = row.output_tokens || 0;
      const thought = row.thought_tokens || 0;
      const cached = row.cached_tokens || 0;
      const total = row.total_tokens || 0;
      const turns = row.turn_count || 0;
      const avgDur = row.avg_duration_ms || 0;

      entry.totalTokens += total;
      entry.inputTokens += input;
      entry.outputTokens += output;
      entry.thoughtTokens += thought;
      entry.cachedTokens += cached;
      entry.tokensByModel[row.model] = { input, output, total, thought, cached };

      if (avgDur > 0 && turns > 0) {
        entry.durationSum += avgDur * turns;
        entry.durationWeights += turns;
        entry.durationByModel[row.model] = Math.round(avgDur);
      }

      entry.linesAdded += row.lines_added || 0;
      entry.linesDeleted += row.lines_deleted || 0;
      entry.filesCreated += row.files_created || 0;
      entry.filesModified += row.files_modified || 0;
      entry.filesDeleted += row.files_deleted || 0;
      entry.planAccepted += row.plan_accepted || 0;
      entry.planRejected += row.plan_rejected || 0;
      entry.turnsCount += turns;
    }

    // Query period activity counts from JSON rows
    const periodActivityRows = this.database
      .prepare(
        `SELECT
           ${periodSql} AS period,
           skills_used_json,
           mcp_used_json,
           git_actions_json,
           shell_commands_json
         FROM turn_metrics m
         ${whereClause}`,
      )
      .all(...params) as Array<{
        period: string;
        skills_used_json?: string;
        mcp_used_json?: string;
        git_actions_json?: string;
        shell_commands_json?: string;
      }>;

    for (const row of periodActivityRows) {
      const entry = periodsMap.get(row.period);
      if (entry) {
        const skills: Record<string, number> = {};
        const mcp: Record<string, number> = {};
        const git: Record<string, number> = {};
        const shell: Record<string, number> = {};
        mergeJsonCounts(skills, row.skills_used_json);
        mergeJsonCounts(mcp, row.mcp_used_json);
        mergeJsonCounts(git, row.git_actions_json);
        mergeJsonCounts(shell, row.shell_commands_json);
        entry.skillsUsed += sumRec(skills);
        entry.mcpUsed += sumRec(mcp);
        entry.gitActions += sumRec(git);
        entry.shellCommands += sumRec(shell);
      }
    }

    // Build complete continuous date range points
    const timeSeries = generateContinuousTimeSeries(
      periodsMap,
      timeRange,
      granularity,
      startDate,
    );

    // 4. Individual Response Tokens Per Second Points
    const turnResponseRows = this.database
      .prepare(
        `SELECT
           m.turn_id,
           m.session_id,
           m.model,
           m.output_tokens,
           m.duration_ms,
           m.created_at
         FROM turn_metrics m
         ${whereClause}
         ORDER BY m.created_at ASC`,
      )
      .all(...params) as Array<{
        turn_id: string;
        session_id: string;
        model: string;
        output_tokens: number | null;
        duration_ms: number | null;
        created_at: string;
      }>;

    const tokensPerSecondSeries: TokensPerSecondPoint[] = turnResponseRows.map((r) => {
      const outputTokens = r.output_tokens || 0;
      const durationMs = r.duration_ms || 0;
      const tokensPerSecond =
        durationMs > 0 && outputTokens > 0
          ? Math.round((outputTokens / (durationMs / 1000)) * 10) / 10
          : 0;

      return {
        turnId: r.turn_id,
        sessionId: r.session_id,
        model: r.model || "unknown",
        tokensPerSecond,
        outputTokens,
        durationMs,
        createdAt: r.created_at,
      };
    });

    return {
      timeRange,
      granularity,
      summary,
      timeSeries,
      tokensPerSecondSeries,
      modelComparison,
      availableModels,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Backfills historical data from existing `turn_usage` and `events` into `turn_metrics`
   * if `turn_metrics` table is empty.
   */
  private backfillHistoricalIfEmpty(): void {
    try {
      const countRow = this.database
        .prepare("SELECT COUNT(*) AS count FROM turn_metrics")
        .get() as { count: number };

      if (countRow.count > 0) return;

      // Read existing turn_usage rows joined with sessions
      const usageRows = this.database
        .prepare(
          `SELECT
             u.session_id,
             u.turn_id,
             u.input_tokens,
             u.output_tokens,
             u.total_tokens,
             u.thought_tokens,
             u.cached_read_tokens,
             u.model_usage_json,
             u.observed_at,
             s.project_id,
             s.model AS session_model,
             s.mode AS session_mode
           FROM turn_usage u
           JOIN sessions s ON s.id = u.session_id`,
        )
        .all() as Array<{
        session_id: string;
        turn_id: string;
        input_tokens: number | null;
        output_tokens: number | null;
        total_tokens: number | null;
        thought_tokens: number | null;
        cached_read_tokens: number | null;
        model_usage_json: string;
        observed_at: string;
        project_id: string;
        session_model: string | null;
        session_mode: string | null;
      }>;

      if (usageRows.length === 0) return;

      this.database.transaction(() => {
        for (const row of usageRows) {
          let primaryModel = row.session_model || "gemini";
          try {
            const list = JSON.parse(row.model_usage_json);
            if (Array.isArray(list) && list[0]?.model) {
              primaryModel = list[0].model;
            }
          } catch {
            // ignore
          }

          // Check if there was a plan decision in user messages for this turn
          const eventRow = this.database
            .prepare(
              `SELECT payload_json FROM events
               WHERE session_id = ? AND turn_id = ? AND event_type = 'message.user'
               LIMIT 1`,
            )
            .get(row.session_id, row.turn_id) as { payload_json: string } | undefined;

          let planDecision: "accepted" | "rejected" | null = null;
          if (eventRow) {
            try {
              const payload = JSON.parse(eventRow.payload_json);
              const text = typeof payload.text === "string" ? payload.text.toLowerCase() : "";
              if (text.includes("plan akzeptiert") || text.includes("plan accepted")) {
                planDecision = "accepted";
              } else if (text.includes("plan abgelehnt") || text.includes("plan rejected")) {
                planDecision = "rejected";
              }
            } catch {
              // ignore
            }
          }

          this.recordTurnMetric({
            turnId: row.turn_id,
            sessionId: row.session_id,
            projectId: row.project_id,
            model: primaryModel,
            mode: row.session_mode,
            durationMs: 0,
            inputTokens: row.input_tokens || 0,
            outputTokens: row.output_tokens || 0,
            totalTokens: row.total_tokens || 0,
            thoughtTokens: row.thought_tokens || 0,
            cachedTokens: row.cached_read_tokens || 0,
            linesAdded: 0,
            linesDeleted: 0,
            planDecision,
            status: "completed",
            createdAt: row.observed_at,
          });
        }
      })();
    } catch {
      // ignore
    }
  }
}

function getRangeStartDate(timeRange: string): Date | null {
  const now = new Date();
  switch (timeRange) {
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "90d":
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    case "all":
    default:
      return null;
  }
}

function getPeriodSql(granularity: StatsGranularity): string {
  switch (granularity) {
    case "week":
      return "strftime('%Y-W%W', m.created_at)";
    case "month":
      return "strftime('%Y-%m', m.created_at)";
    case "day":
    default:
      return "strftime('%Y-%m-%d', m.created_at)";
  }
}

function formatPeriodLabel(period: string, granularity: StatsGranularity): string {
  try {
    if (granularity === "day") {
      const [year, month, day] = period.split("-").map(Number);
      const date = new Date(year, month - 1, day);
      return new Intl.DateTimeFormat("de-DE", {
        day: "2-digit",
        month: "short",
      }).format(date);
    }
    if (granularity === "week") {
      const [year, weekPart] = period.split("-W");
      return `KW ${weekPart} '${year.slice(2)}`;
    }
    if (granularity === "month") {
      const [year, month] = period.split("-").map(Number);
      const date = new Date(year, month - 1, 1);
      return new Intl.DateTimeFormat("de-DE", {
        month: "short",
        year: "numeric",
      }).format(date);
    }
  } catch {
    // fallback
  }
  return period;
}

export function formatModelDisplayName(model: string): string {
  if (!model) return "Unbekannt";
  if (model.includes("gemini-2.5-pro")) return "Gemini 2.5 Pro";
  if (model.includes("gemini-2.5-flash")) return "Gemini 2.5 Flash";
  if (model.includes("gemini-2.0-flash")) return "Gemini 2.0 Flash";
  if (model.includes("gemini-1.5-pro")) return "Gemini 1.5 Pro";
  if (model.includes("gemini-1.5-flash")) return "Gemini 1.5 Flash";
  return model;
}

function mergeJsonCounts(target: Record<string, number>, jsonStr?: string | null): void {
  if (!jsonStr || typeof jsonStr !== "string") return;
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      for (const [key, val] of Object.entries(parsed)) {
        const count = typeof val === "number" ? val : parseInt(String(val), 10);
        if (!isNaN(count) && count > 0) {
          target[key] = (target[key] || 0) + count;
        }
      }
    }
  } catch {}
}

function generateContinuousTimeSeries(
  periodsMap: Map<
    string,
    {
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      thoughtTokens: number;
      cachedTokens: number;
      tokensByModel: Record<string, ModelTokenBreakdown>;
      durationWeights: number;
      durationSum: number;
      durationByModel: Record<string, number>;
      linesAdded: number;
      linesDeleted: number;
      filesCreated: number;
      filesModified: number;
      filesDeleted: number;
      skillsUsed: number;
      mcpUsed: number;
      gitActions: number;
      shellCommands: number;
      planAccepted: number;
      planRejected: number;
      turnsCount: number;
    }
  >,
  timeRange: string,
  granularity: StatsGranularity,
  startDate: Date | null,
): StatsTimeSeriesPoint[] {
  const defaultEntry = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    cachedTokens: 0,
    tokensByModel: {},
    durationWeights: 0,
    durationSum: 0,
    durationByModel: {},
    linesAdded: 0,
    linesDeleted: 0,
    filesCreated: 0,
    filesModified: 0,
    filesDeleted: 0,
    skillsUsed: 0,
    mcpUsed: 0,
    gitActions: 0,
    shellCommands: 0,
    planAccepted: 0,
    planRejected: 0,
    turnsCount: 0,
  };

  // If we have no explicit start date or all time, use all sorted keys
  if (!startDate || timeRange === "all") {
    const sortedKeys = Array.from(periodsMap.keys()).sort();
    if (sortedKeys.length === 0) return [];
    return sortedKeys.map((period) => {
      const entry = periodsMap.get(period) ?? defaultEntry;
      const avgDurationMs =
        entry.durationWeights > 0
          ? Math.round(entry.durationSum / entry.durationWeights)
          : 0;
      return {
        period,
        label: formatPeriodLabel(period, granularity),
        date: period,
        totalTokens: entry.totalTokens,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        thoughtTokens: entry.thoughtTokens,
        cachedTokens: entry.cachedTokens,
        tokensByModel: entry.tokensByModel,
        avgDurationMs,
        durationByModel: entry.durationByModel,
        linesAdded: entry.linesAdded,
        linesDeleted: entry.linesDeleted,
        filesCreated: entry.filesCreated,
        filesModified: entry.filesModified,
        filesDeleted: entry.filesDeleted,
        skillsUsed: entry.skillsUsed,
        mcpUsed: entry.mcpUsed,
        gitActions: entry.gitActions,
        shellCommands: entry.shellCommands,
        planAccepted: entry.planAccepted,
        planRejected: entry.planRejected,
        turnsCount: entry.turnsCount,
      };
    });
  }

  // Generate continuous timeline from startDate to today
  const points: StatsTimeSeriesPoint[] = [];
  const now = new Date();
  const current = new Date(startDate);

  if (granularity === "day") {
    while (current <= now) {
      const period = current.toISOString().slice(0, 10);
      const entry = periodsMap.get(period) ?? defaultEntry;
      const avgDurationMs =
        entry.durationWeights > 0
          ? Math.round(entry.durationSum / entry.durationWeights)
          : 0;

      points.push({
        period,
        label: formatPeriodLabel(period, "day"),
        date: period,
        totalTokens: entry.totalTokens,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        thoughtTokens: entry.thoughtTokens,
        cachedTokens: entry.cachedTokens,
        tokensByModel: entry.tokensByModel,
        avgDurationMs,
        durationByModel: entry.durationByModel,
        linesAdded: entry.linesAdded,
        linesDeleted: entry.linesDeleted,
        filesCreated: entry.filesCreated,
        filesModified: entry.filesModified,
        filesDeleted: entry.filesDeleted,
        skillsUsed: entry.skillsUsed,
        mcpUsed: entry.mcpUsed,
        gitActions: entry.gitActions,
        shellCommands: entry.shellCommands,
        planAccepted: entry.planAccepted,
        planRejected: entry.planRejected,
        turnsCount: entry.turnsCount,
      });

      current.setDate(current.getDate() + 1);
    }
  } else if (granularity === "week") {
    const seen = new Set<string>();
    while (current <= now) {
      const year = current.getFullYear();
      const firstDayOfYear = new Date(year, 0, 1);
      const pastDaysOfYear = (current.getTime() - firstDayOfYear.getTime()) / 86400000;
      const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
      const weekPart = String(weekNum).padStart(2, "0");
      const period = `${year}-W${weekPart}`;

      if (!seen.has(period)) {
        seen.add(period);
        const entry = periodsMap.get(period) ?? defaultEntry;
        const avgDurationMs =
          entry.durationWeights > 0
            ? Math.round(entry.durationSum / entry.durationWeights)
            : 0;

        points.push({
          period,
          label: formatPeriodLabel(period, "week"),
          date: current.toISOString().slice(0, 10),
          totalTokens: entry.totalTokens,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          thoughtTokens: entry.thoughtTokens,
          cachedTokens: entry.cachedTokens,
          tokensByModel: entry.tokensByModel,
          avgDurationMs,
          durationByModel: entry.durationByModel,
          linesAdded: entry.linesAdded,
          linesDeleted: entry.linesDeleted,
          filesCreated: entry.filesCreated,
          filesModified: entry.filesModified,
          filesDeleted: entry.filesDeleted,
          skillsUsed: entry.skillsUsed,
          mcpUsed: entry.mcpUsed,
          gitActions: entry.gitActions,
          shellCommands: entry.shellCommands,
          planAccepted: entry.planAccepted,
          planRejected: entry.planRejected,
          turnsCount: entry.turnsCount,
        });
      }
      current.setDate(current.getDate() + 7);
    }
  } else if (granularity === "month") {
    const seen = new Set<string>();
    while (current <= now) {
      const period = current.toISOString().slice(0, 7);
      if (!seen.has(period)) {
        seen.add(period);
        const entry = periodsMap.get(period) ?? defaultEntry;
        const avgDurationMs =
          entry.durationWeights > 0
            ? Math.round(entry.durationSum / entry.durationWeights)
            : 0;

        points.push({
          period,
          label: formatPeriodLabel(period, "month"),
          date: current.toISOString().slice(0, 10),
          totalTokens: entry.totalTokens,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          thoughtTokens: entry.thoughtTokens,
          cachedTokens: entry.cachedTokens,
          tokensByModel: entry.tokensByModel,
          avgDurationMs,
          durationByModel: entry.durationByModel,
          linesAdded: entry.linesAdded,
          linesDeleted: entry.linesDeleted,
          filesCreated: entry.filesCreated,
          filesModified: entry.filesModified,
          filesDeleted: entry.filesDeleted,
          skillsUsed: entry.skillsUsed,
          mcpUsed: entry.mcpUsed,
          gitActions: entry.gitActions,
          shellCommands: entry.shellCommands,
          planAccepted: entry.planAccepted,
          planRejected: entry.planRejected,
          turnsCount: entry.turnsCount,
        });
      }
      current.setMonth(current.getMonth() + 1);
    }
  }

  return points;
}
