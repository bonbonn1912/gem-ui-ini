import { useCallback, useEffect, useRef, useState } from "react";
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
  const requestGeneration = useRef(0);

  const fetchStats = useCallback(async () => {
    const generation = ++requestGeneration.current;
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
      if (generation === requestGeneration.current) setStats(data);
    } catch (err) {
      if (generation === requestGeneration.current) setError(err instanceof Error ? err.message : "Fehler beim Laden der Statistiken.");
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [timeRange, granularity, selectedModel, projectId]);

  useEffect(() => {
    void fetchStats();
    return () => { requestGeneration.current += 1; };
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
