import { Icon } from "../../components/Icon";
import type { StatsSummary } from "../../../shared/contracts";
import { formatNumber, formatDuration } from "./StatsCharts";

export function StatsSummaryCards({ summary }: { summary: StatsSummary }) {
  const inPct = summary.inputPercentage || 0;
  const outPct = summary.outputPercentage || 0;
  const thoughtPct =
    summary.totalTokens > 0
      ? Math.round((summary.thoughtTokens / summary.totalTokens) * 1000) / 10
      : 0;

  return (
    <div className="stats-cards-grid">
      {/* 1. Tokens Card */}
      <div className="stats-kpi-card stats-kpi-card--primary">
        <div className="stats-kpi-header">
          <span className="stats-kpi-icon">
            <Icon name="sparkle" size={20} />
          </span>
          <span className="stats-kpi-title">Token-Verbrauch</span>
        </div>
        <div className="stats-kpi-value">{formatNumber(summary.totalTokens)}</div>

        {/* Visual Token Proportion Bar */}
        {summary.totalTokens > 0 && (
          <div className="stats-token-bar" title={`Input: ${inPct}% | Output: ${outPct}%`}>
            <div
              className="stats-token-bar-seg stats-token-bar-seg--in"
              style={{ width: `${inPct}%` }}
            />
            <div
              className="stats-token-bar-seg stats-token-bar-seg--out"
              style={{ width: `${outPct}%` }}
            />
            {thoughtPct > 0 && (
              <div
                className="stats-token-bar-seg stats-token-bar-seg--thought"
                style={{ width: `${thoughtPct}%` }}
              />
            )}
          </div>
        )}

        <div className="stats-kpi-subtext stats-kpi-subtext--tokens">
          <span className="stats-token-chip" title="Input Tokens">
            <i className="stats-chip-dot stats-chip-dot--in" />
            In: <strong>{formatNumber(summary.inputTokens)}</strong> ({inPct}%)
          </span>
          <span className="stats-token-chip" title="Output Tokens">
            <i className="stats-chip-dot stats-chip-dot--out" />
            Out: <strong>{formatNumber(summary.outputTokens)}</strong> ({outPct}%)
          </span>
          <span className="stats-token-chip stats-token-chip--cache" title="Prompt Cache Hit-Rate">
            <Icon name="zap" size={10} /> Cache: <strong>{summary.cacheHitRate}%</strong>
            {summary.cachedTokens > 0 && ` (${formatNumber(summary.cachedTokens)})`}
          </span>
          {summary.thoughtTokens > 0 && (
            <span className="stats-token-chip" title="Thought Tokens">
              <Icon name="brain" size={10} /> Thought: <strong>{formatNumber(summary.thoughtTokens)}</strong>
            </span>
          )}
        </div>
      </div>

      {/* 2. Response Duration Card */}
      <div className="stats-kpi-card">
        <div className="stats-kpi-header">
          <span className="stats-kpi-icon">
            <Icon name="clock" size={20} />
          </span>
          <span className="stats-kpi-title">Ø Antwortzeit</span>
        </div>
        <div className="stats-kpi-value">{formatDuration(summary.avgDurationMs)}</div>
        <div className="stats-kpi-subtext">
          <span>Gesamtzeit: {formatDuration(summary.totalDurationMs)}</span>
        </div>
      </div>

      {/* 3. Lines of Code Card */}
      <div className="stats-kpi-card">
        <div className="stats-kpi-header">
          <span className="stats-kpi-icon">
            <Icon name="file-text" size={20} />
          </span>
          <span className="stats-kpi-title">Code-Zeilen geändert</span>
        </div>
        <div className="stats-kpi-value">+{formatNumber(summary.totalLinesAdded)}</div>
        <div className="stats-kpi-subtext">
          <span>-{formatNumber(summary.totalLinesDeleted)} Zeilen gelöscht/ersetzt</span>
        </div>
      </div>

      {/* 4. File Operations Card */}
      <div className="stats-kpi-card">
        <div className="stats-kpi-header">
          <span className="stats-kpi-icon">
            <Icon name="folder" size={20} />
          </span>
          <span className="stats-kpi-title">Datei-Operationen</span>
        </div>
        <div className="stats-kpi-value">
          +{formatNumber(summary.filesCreated)}{" "}
          <small style={{ fontSize: "0.55em", fontWeight: "normal", opacity: 0.8 }}>neu</small>
        </div>
        <div className="stats-kpi-subtext">
          <span>~{formatNumber(summary.filesModified)} bearbeitet</span>
          <span>•</span>
          <span>-{formatNumber(summary.filesDeleted)} gelöscht</span>
        </div>
      </div>

      {/* 5. Skills & MCP Tools Card */}
      <div className="stats-kpi-card">
        <div className="stats-kpi-header">
          <span className="stats-kpi-icon">
            <Icon name="skill" size={20} />
          </span>
          <span className="stats-kpi-title">Skills & MCP</span>
        </div>
        <div className="stats-kpi-value">
          {formatNumber(summary.skillsUsedTotal + summary.mcpUsedTotal)}
        </div>
        <div className="stats-kpi-subtext">
          <span>{summary.skillsUsedTotal} Skill-Aufrufe</span>
          <span>•</span>
          <span>{summary.mcpUsedTotal} MCP-Tools</span>
        </div>
      </div>

      {/* 6. Git & Shell Actions Card */}
      <div className="stats-kpi-card">
        <div className="stats-kpi-header">
          <span className="stats-kpi-icon">
            <Icon name="tool" size={20} />
          </span>
          <span className="stats-kpi-title">Git & Shell-Aktionen</span>
        </div>
        <div className="stats-kpi-value">
          {formatNumber(summary.gitActionsTotal + summary.shellCommandsTotal)}
        </div>
        <div className="stats-kpi-subtext">
          <span>{summary.gitActionsTotal} Git-Aktionen</span>
          <span>•</span>
          <span>{summary.shellCommandsTotal} Shell-Befehle</span>
        </div>
      </div>

      {/* 7. Plan Mode Acceptance Card */}
      <div className="stats-kpi-card">
        <div className="stats-kpi-header">
          <span className="stats-kpi-icon">
            <Icon name="brain" size={20} />
          </span>
          <span className="stats-kpi-title">Plan-Modus Akzeptanz</span>
        </div>
        <div className="stats-kpi-value">{summary.planAcceptanceRate}%</div>
        <div className="stats-kpi-subtext">
          <span><Icon name="check" size={10} /> {summary.planAccepted} Angenommen</span>
          <span>•</span>
          <span><Icon name="x" size={10} /> {summary.planRejected} Abgelehnt</span>
        </div>
      </div>

      {/* 8. Total Turns Card */}
      <div className="stats-kpi-card">
        <div className="stats-kpi-header">
          <span className="stats-kpi-icon">
            <Icon name="chat" size={20} />
          </span>
          <span className="stats-kpi-title">Anfragen / Turns</span>
        </div>
        <div className="stats-kpi-value">{formatNumber(summary.totalTurns)}</div>
        <div className="stats-kpi-subtext">
          <span>{summary.activeProjectsCount} Projekte</span>
          <span>•</span>
          <span>{summary.activeSessionsCount} Sessions</span>
        </div>
      </div>
    </div>
  );
}
