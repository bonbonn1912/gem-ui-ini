import { z } from "zod";
import { EntityIdSchema, IsoTimestampSchema } from "./common";

export const StatsTimeRangeSchema = z.enum(["7d", "30d", "90d", "all"]);
export type StatsTimeRange = z.infer<typeof StatsTimeRangeSchema>;

export const StatsGranularitySchema = z.enum(["day", "week", "month"]);
export type StatsGranularity = z.infer<typeof StatsGranularitySchema>;

export const GetStatsInputSchema = z
  .object({
    timeRange: StatsTimeRangeSchema.default("30d"),
    granularity: StatsGranularitySchema.default("day"),
    projectId: EntityIdSchema.optional(),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type GetStatsInput = z.infer<typeof GetStatsInputSchema>;

export const ItemCountBreakdownSchema = z
  .object({
    name: z.string(),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type ItemCountBreakdown = z.infer<typeof ItemCountBreakdownSchema>;

export const StatsSummarySchema = z
  .object({
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    thoughtTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative().default(0),
    cacheHitRate: z.number().min(0).max(100).default(0),
    inputPercentage: z.number().min(0).max(100).default(0),
    outputPercentage: z.number().min(0).max(100).default(0),
    avgDurationMs: z.number().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    avgTokensPerSecond: z.number().nonnegative().default(0),
    totalLinesAdded: z.number().int().nonnegative(),
    totalLinesDeleted: z.number().int().nonnegative(),
    filesCreated: z.number().int().nonnegative().default(0),
    filesModified: z.number().int().nonnegative().default(0),
    filesDeleted: z.number().int().nonnegative().default(0),
    skillsUsedTotal: z.number().int().nonnegative().default(0),
    mcpUsedTotal: z.number().int().nonnegative().default(0),
    gitActionsTotal: z.number().int().nonnegative().default(0),
    shellCommandsTotal: z.number().int().nonnegative().default(0),
    topSkills: z.array(ItemCountBreakdownSchema).default([]),
    topMcpTools: z.array(ItemCountBreakdownSchema).default([]),
    topGitActions: z.array(ItemCountBreakdownSchema).default([]),
    topShellCommands: z.array(ItemCountBreakdownSchema).default([]),
    totalTurns: z.number().int().nonnegative(),
    completedTurns: z.number().int().nonnegative(),
    failedTurns: z.number().int().nonnegative(),
    cancelledTurns: z.number().int().nonnegative(),
    planAccepted: z.number().int().nonnegative(),
    planRejected: z.number().int().nonnegative(),
    planTotal: z.number().int().nonnegative(),
    planAcceptanceRate: z.number().min(0).max(100),
    activeProjectsCount: z.number().int().nonnegative(),
    activeSessionsCount: z.number().int().nonnegative(),
  })
  .strict();
export type StatsSummary = z.infer<typeof StatsSummarySchema>;

export const ModelTokenBreakdownSchema = z
  .object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    thought: z.number().int().nonnegative().default(0),
    cached: z.number().int().nonnegative().default(0),
  })
  .strict();
export type ModelTokenBreakdown = z.infer<typeof ModelTokenBreakdownSchema>;

export const StatsTimeSeriesPointSchema = z
  .object({
    period: z.string().min(1),
    label: z.string().min(1),
    date: z.string().min(1),
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    thoughtTokens: z.number().int().nonnegative().default(0),
    cachedTokens: z.number().int().nonnegative().default(0),
    tokensByModel: z.record(z.string(), ModelTokenBreakdownSchema),
    avgDurationMs: z.number().nonnegative(),
    durationByModel: z.record(z.string(), z.number().nonnegative()),
    linesAdded: z.number().int().nonnegative(),
    linesDeleted: z.number().int().nonnegative(),
    filesCreated: z.number().int().nonnegative().default(0),
    filesModified: z.number().int().nonnegative().default(0),
    filesDeleted: z.number().int().nonnegative().default(0),
    skillsUsed: z.number().int().nonnegative().default(0),
    mcpUsed: z.number().int().nonnegative().default(0),
    gitActions: z.number().int().nonnegative().default(0),
    shellCommands: z.number().int().nonnegative().default(0),
    planAccepted: z.number().int().nonnegative(),
    planRejected: z.number().int().nonnegative(),
    turnsCount: z.number().int().nonnegative(),
  })
  .strict();
export type StatsTimeSeriesPoint = z.infer<typeof StatsTimeSeriesPointSchema>;

export const TokensPerSecondPointSchema = z
  .object({
    turnId: z.string().min(1),
    sessionId: z.string().min(1),
    model: z.string().min(1),
    tokensPerSecond: z.number().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type TokensPerSecondPoint = z.infer<typeof TokensPerSecondPointSchema>;

export const ModelComparisonItemSchema = z
  .object({
    model: z.string().min(1),
    displayName: z.string().min(1),
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    thoughtTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative().default(0),
    cacheHitRate: z.number().min(0).max(100).default(0),
    inputPercentage: z.number().min(0).max(100).default(0),
    outputPercentage: z.number().min(0).max(100).default(0),
    avgDurationMs: z.number().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    tokensPerSecond: z.number().nonnegative().default(0),
    turnCount: z.number().int().nonnegative(),
    linesAdded: z.number().int().nonnegative(),
    linesDeleted: z.number().int().nonnegative(),
    failedTurns: z.number().int().nonnegative(),
    errorRate: z.number().min(0).max(100),
    sharePercentage: z.number().min(0).max(100),
  })
  .strict();
export type ModelComparisonItem = z.infer<typeof ModelComparisonItemSchema>;

export const AppStatsSchema = z
  .object({
    timeRange: StatsTimeRangeSchema,
    granularity: StatsGranularitySchema,
    summary: StatsSummarySchema,
    timeSeries: z.array(StatsTimeSeriesPointSchema),
    tokensPerSecondSeries: z.array(TokensPerSecondPointSchema).default([]),
    modelComparison: z.array(ModelComparisonItemSchema),
    availableModels: z.array(z.string()),
    generatedAt: IsoTimestampSchema,
  })
  .strict();
export type AppStats = z.infer<typeof AppStatsSchema>;
