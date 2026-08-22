import { useCallback, useEffect, useState } from "react";
import type {
  AppStats,
  GetStatsInput,
  StatsGranularity,
  StatsTimeRange,
} from "../../../shared/contracts";

export function useAppStats(
  initialTimeRange: StatsTimeRange = "30d",
  initialGranularity: StatsGranularity = "day",
  projectId?: string,
) {
  const [timeRange, setTimeRange] = useState<StatsTimeRange>(initialTimeRange);
  const [granularity, setGranularity] = useState<StatsGranularity>(initialGranularity);
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [stats, setStats] = useState<AppStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = (window as unknown as { gemUi?: { stats?: { get: (input: GetStatsInput) => Promise<AppStats> } } }).gemUi;
      if (!api?.stats?.get) {
        throw new Error("Statistik-Schnittstelle ist nicht verfügbar.");
      }
      const data = await api.stats.get({
        timeRange,
        granularity,
        model: selectedModel,
        projectId,
      });
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fehler beim Laden der Statistiken.");
    } finally {
      setLoading(false);
    }
  }, [timeRange, granularity, selectedModel, projectId]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  return {
    stats,
    loading,
    error,
    timeRange,
    setTimeRange,
    granularity,
    setGranularity,
    selectedModel,
    setSelectedModel,
    refresh: fetchStats,
  };
}
