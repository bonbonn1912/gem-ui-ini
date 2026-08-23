import { useState } from "react";
import { Icon } from "../../components/Icon";
import type { AppProject, StatsGranularity, StatsTimeRange } from "../../../shared/contracts";
import { useAppStats } from "./useAppStats";
import { StatsSummaryCards } from "./StatsSummaryCards";
import {
  CodeActivityChart,
  FileActivityChart,
  formatModelDisplayName,
  ModelComparisonTable,
  PlanModeStatsChart,
  ResponseTimeChart,
  TokenUsageChart,
  TokensPerSecondChart,
  ToolUsageRankingSection,
} from "./StatsCharts";

type StatisticsViewProps = {
  onClose: () => void;
  projects?: AppProject[];
  activeProject?: AppProject | null;
  onEnableProjectStats?: (projectId: string) => Promise<void> | void;
};

export function StatisticsView({
  onClose,
  projects = [],
  activeProject,
  onEnableProjectStats,
}: StatisticsViewProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [enabling, setEnabling] = useState(false);
  const {
    stats,
    loading,
    error,
    timeRange,
    setTimeRange,
    granularity,
    setGranularity,
    selectedModel,
    setSelectedModel,
    refresh,
  } = useAppStats("30d", "day", selectedProjectId || undefined);

  const currentProject =
    projects.find((p) => p.id === selectedProjectId) ??
    (selectedProjectId && activeProject?.id === selectedProjectId ? activeProject : null);
  const isStatsDisabled = currentProject ? !currentProject.statsEnabled : false;
  const hasHistoricalData =
    Boolean(stats) && ((stats?.summary.totalTokens ?? 0) > 0 || (stats?.summary.totalTurns ?? 0) > 0);

  const handleEnableStats = async () => {
    if (!onEnableProjectStats || enabling || !currentProject) return;
    setEnabling(true);
    try {
      await onEnableProjectStats(currentProject.id);
      await refresh();
    } finally {
      setEnabling(false);
    }
  };

  return (
    <main className="stats-view-container" aria-label="App-Statistiken">
      {/* Top Header */}
      <header className="stats-view-header">
        <div className="stats-header-left">
          <div className="stats-header-title-row">
            <span className="stats-header-icon">
              <Icon name="chart" size={24} />
            </span>
            <div>
              <h1>Statistiken & Metriken</h1>
              <p className="stats-header-subtitle">
                {currentProject
                  ? `Nutzungs- und Performance-Daten für „${currentProject.name}“`
                  : "Gesamte globale Nutzungs- und Performance-Daten aller Projekte und Sessions"}
              </p>
            </div>
          </div>
        </div>

        <div className="stats-header-right">
          {/* Project Filter Dropdown */}
          {projects.length > 0 && (
            <select
              className="stats-model-select stats-project-select"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              aria-label="Projekt filtern"
            >
              <option value="">Alle Projekte (Global)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          {/* Granularity Toggle */}
          <div className="stats-pill-group" role="group" aria-label="Zeitebene">
            <button
              type="button"
              className={`stats-pill-btn ${granularity === "day" ? "stats-pill-btn--active" : ""}`}
              onClick={() => setGranularity("day")}
            >
              Tage
            </button>
            <button
              type="button"
              className={`stats-pill-btn ${granularity === "week" ? "stats-pill-btn--active" : ""}`}
              onClick={() => setGranularity("week")}
            >
              Wochen
            </button>
            <button
              type="button"
              className={`stats-pill-btn ${granularity === "month" ? "stats-pill-btn--active" : ""}`}
              onClick={() => setGranularity("month")}
            >
              Monate
            </button>
          </div>

          {/* Time Range Selector */}
          <div className="stats-pill-group" role="group" aria-label="Zeitraum">
            <button
              type="button"
              className={`stats-pill-btn ${timeRange === "7d" ? "stats-pill-btn--active" : ""}`}
              onClick={() => setTimeRange("7d")}
            >
              7 Tage
            </button>
            <button
              type="button"
              className={`stats-pill-btn ${timeRange === "30d" ? "stats-pill-btn--active" : ""}`}
              onClick={() => setTimeRange("30d")}
            >
              30 Tage
            </button>
            <button
              type="button"
              className={`stats-pill-btn ${timeRange === "90d" ? "stats-pill-btn--active" : ""}`}
              onClick={() => setTimeRange("90d")}
            >
              3 Monate
            </button>
            <button
              type="button"
              className={`stats-pill-btn ${timeRange === "all" ? "stats-pill-btn--active" : ""}`}
              onClick={() => setTimeRange("all")}
            >
              Gesamt
            </button>
          </div>

          {/* Model Filter Dropdown - stays visible even when filtered */}
          {stats && (stats.availableModels.length > 1 || Boolean(selectedModel)) && (
            <select
              className="stats-model-select"
              value={selectedModel ?? ""}
              onChange={(e) => setSelectedModel(e.target.value || undefined)}
              aria-label="Modell filtern"
            >
              <option value="">Alle Modelle</option>
              {stats.availableModels.map((m) => (
                <option key={m} value={m}>
                  {formatModelDisplayName(m)}
                </option>
              ))}
            </select>
          )}

          {/* Refresh button */}
          <button
            type="button"
            className="icon-button stats-action-btn"
            onClick={() => void refresh()}
            title="Statistiken neu laden"
            aria-label="Statistiken neu laden"
            disabled={loading}
          >
            <Icon name="refresh" size={16} />
          </button>

          {/* Close / Return button */}
          <button
            type="button"
            className="icon-button stats-action-btn"
            onClick={onClose}
            title="Zurück zum Workspace"
            aria-label="Zurück zum Workspace"
          >
            <Icon name="x" size={17} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="stats-view-content">
        {error && (
          <div className="stats-error-banner" role="alert">
            <Icon name="warning" size={18} />
            <span>{error}</span>
            <button type="button" onClick={() => void refresh()}>
              Erneut versuchen
            </button>
          </div>
        )}

        {loading && !stats ? (
          <div className="stats-loading-state">
            <div className="boot-progress">
              <i />
            </div>
            <p>Statistiken werden berechnet …</p>
          </div>
        ) : isStatsDisabled && !hasHistoricalData ? (
          /* Disabled State when NO historical data exists */
          <div className="stats-disabled-state">
            <div className="stats-disabled-icon">
              <Icon name="chart" size={48} />
            </div>
            <h2>Statistiken sind aktuell nicht aktiviert</h2>
            <p>
              Für {activeProject ? <strong>{activeProject.name}</strong> : "dieses Projekt"} ist die
              Statistik- und Nutzungsverfolgung momentan ausgeschaltet (Standard: Aus).
            </p>
            <p className="stats-disabled-question">
              Möchtest du die Erfassung von Token, Antwortzeiten und Modell-Vergleichen für dieses Projekt jetzt aktivieren?
            </p>
            {onEnableProjectStats && (
              <button
                type="button"
                className="primary-button stats-enable-btn"
                onClick={() => void handleEnableStats()}
                disabled={enabling}
              >
                {enabling ? <span className="mini-spinner" /> : <Icon name="check" size={16} />}
                Statistiken jetzt aktivieren
              </button>
            )}
          </div>
        ) : stats ? (
          <>
            {/* Warning banner when tracking is disabled but historical stats exist */}
            {isStatsDisabled && (
              <div className="stats-warning-banner" role="alert">
                <div className="stats-warning-banner-left">
                  <Icon name="warning" size={20} />
                  <div>
                    <strong>Statistik-Erfassung ist für dieses Projekt aktuell deaktiviert</strong>
                    <p>
                      Neue Sessions, Token und Latenzen werden derzeit nicht erfasst. Bisherige
                      historische Daten werden unten angezeigt.
                    </p>
                  </div>
                </div>
                {onEnableProjectStats && (
                  <button
                    type="button"
                    className="primary-button stats-banner-action-btn"
                    onClick={() => void handleEnableStats()}
                    disabled={enabling}
                  >
                    {enabling ? <span className="mini-spinner" /> : null}
                    Jetzt wieder aktivieren
                  </button>
                )}
              </div>
            )}

            {/* KPI Cards */}
            <StatsSummaryCards summary={stats.summary} />

            {/* Visual Charts Grid */}
            <div className="stats-dashboard-grid">
              <div className="stats-grid-full">
                <TokenUsageChart
                  timeSeries={stats.timeSeries}
                  models={stats.availableModels.length > 0 ? stats.availableModels : ["gemini"]}
                />
              </div>

              <div className="stats-grid-half">
                <ResponseTimeChart
                  timeSeries={stats.timeSeries}
                  models={stats.availableModels.length > 0 ? stats.availableModels : ["gemini"]}
                />
              </div>

              <div className="stats-grid-half">
                <CodeActivityChart timeSeries={stats.timeSeries} />
              </div>

              <div className="stats-grid-full">
                <TokensPerSecondChart
                  series={stats.tokensPerSecondSeries}
                  models={stats.availableModels.length > 0 ? stats.availableModels : ["gemini"]}
                />
              </div>

              <div className="stats-grid-full">
                <FileActivityChart timeSeries={stats.timeSeries} />
              </div>

              <div className="stats-grid-full">
                <ToolUsageRankingSection summary={stats.summary} />
              </div>

              <div className="stats-grid-full">
                <PlanModeStatsChart timeSeries={stats.timeSeries} summary={stats.summary} />
              </div>

              <div className="stats-grid-full">
                <ModelComparisonTable models={stats.modelComparison} />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
