import { useState, useMemo, useRef, useLayoutEffect } from "react";
import { Icon } from "../../components/Icon";
import type {
  AppStats,
  ModelComparisonItem,
  StatsTimeSeriesPoint,
  TokensPerSecondPoint,
} from "../../../shared/contracts";

// Categorical chart palette — CSS custom properties, not hardcoded hex, so
// the palette lives in one place (app.css) and follows the light/dark
// theme automatically. Reserved for genuine multi-series identity (which
// model produced this line/bar); polarity (added/removed, accepted/
// rejected) uses --green/--red instead, never these.
const MODEL_COLORS: Record<string, string> = {
  "gemini-2.5-pro": "var(--chart-1)",
  "gemini-2.5-flash": "var(--chart-2)",
  "gemini-2.0-flash": "var(--chart-3)",
  "gemini-1.5-pro": "var(--chart-4)",
  "gemini-1.5-flash": "var(--chart-5)",
  unknown: "var(--chart-neutral)",
};

const FALLBACK_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
];

const DEFAULT_SERIES_COLOR = "var(--chart-1)";

export function getModelColor(model: string, index = 0): string {
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (model.toLowerCase().includes(key)) return color;
  }
  return FALLBACK_PALETTE[index % FALLBACK_PALETTE.length];
}

export function formatNumber(num: number | undefined | null): string {
  if (num === undefined || num === null || isNaN(num)) return "0";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return num.toLocaleString("de-DE");
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || isNaN(ms) || ms <= 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
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

function useAutoScrollToEnd(deps: unknown[] = []) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollRef.current) {
      // Scroll all the way to the right so the latest dates/points are visible first
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, deps);
  return scrollRef;
}

/**
 * 1. Token Usage Chart (Stacked Bars / Lines / Distribution)
 */
export function TokenUsageChart({
  timeSeries,
  models,
}: {
  timeSeries: StatsTimeSeriesPoint[];
  models: string[];
}) {
  const [chartType, setChartType] = useState<"stacked" | "line" | "donut">("stacked");
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const scrollRef = useAutoScrollToEnd([timeSeries, chartType]);

  const maxTokens = useMemo(() => {
    return Math.max(...timeSeries.map((p) => p.totalTokens), 10);
  }, [timeSeries]);

  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    models.forEach((m, idx) => {
      map.set(m, getModelColor(m, idx));
    });
    return map;
  }, [models]);

  const height = 240;
  const isOverflowing = timeSeries.length > 14;
  const width = isOverflowing ? Math.max(timeSeries.length * 36, 600) : 600;
  const padding = { top: 20, right: 30, bottom: 40, left: 55 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  // Donut chart calculation
  const donutData = useMemo(() => {
    const modelTotals: Record<string, number> = {};
    for (const point of timeSeries) {
      for (const [model, breakdown] of Object.entries(point.tokensByModel)) {
        modelTotals[model] = (modelTotals[model] || 0) + breakdown.total;
      }
    }
    const total = Object.values(modelTotals).reduce((a, b) => a + b, 0);
    let currentAngle = 0;
    return Object.entries(modelTotals).map(([model, count], idx) => {
      const percentage = total > 0 ? count / total : 0;
      const angle = percentage * 360;
      const startAngle = currentAngle;
      currentAngle += angle;
      return {
        model,
        count,
        percentage: (percentage * 100).toFixed(1),
        startAngle,
        endAngle: currentAngle,
        color: modelColorMap.get(model) || FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length],
      };
    });
  }, [timeSeries, modelColorMap]);

  return (
    <div className="stats-card">
      <div className="stats-card-header">
        <div className="stats-card-title">
          <Icon name="chart" size={18} />
          <span>Token-Verbrauch je Modell</span>
        </div>
        <div className="stats-pill-group">
          <button
            type="button"
            className={`stats-pill-btn ${chartType === "stacked" ? "stats-pill-btn--active" : ""}`}
            onClick={() => setChartType("stacked")}
          >
            Balken
          </button>
          <button
            type="button"
            className={`stats-pill-btn ${chartType === "line" ? "stats-pill-btn--active" : ""}`}
            onClick={() => setChartType("line")}
          >
            Linien
          </button>
          <button
            type="button"
            className={`stats-pill-btn ${chartType === "donut" ? "stats-pill-btn--active" : ""}`}
            onClick={() => setChartType("donut")}
          >
            Verteilung
          </button>
        </div>
      </div>

      {/* Floating Tooltip anchored to Card */}
      {hoveredIndex !== null && timeSeries[hoveredIndex] && (
        <div className="stats-chart-tooltip">
          <strong>{timeSeries[hoveredIndex].label}</strong>
          <div className="stats-tooltip-total">
            Gesamt: {formatNumber(timeSeries[hoveredIndex].totalTokens)} Tokens
          </div>
          <div className="stats-tooltip-subdetail">
            <span>↓ In: {formatNumber(timeSeries[hoveredIndex].inputTokens)}</span>
            <span>•</span>
            <span>↑ Out: {formatNumber(timeSeries[hoveredIndex].outputTokens)}</span>
            {timeSeries[hoveredIndex].cachedTokens > 0 && (
              <>
                <span>•</span>
                <span><Icon name="zap" size={10} /> Cache: {formatNumber(timeSeries[hoveredIndex].cachedTokens)}</span>
              </>
            )}
          </div>
          {models.map((model) => {
            const breakdown = timeSeries[hoveredIndex].tokensByModel[model];
            if (!breakdown || breakdown.total <= 0) return null;
            return (
              <div key={model} className="stats-tooltip-row">
                <span className="stats-legend-dot" style={{ backgroundColor: modelColorMap.get(model) }} />
                <span>{model}:</span>
                <b>{formatNumber(breakdown.total)}</b>
              </div>
            );
          })}
        </div>
      )}

      {timeSeries.length === 0 || maxTokens === 10 ? (
        <div className="stats-empty-chart">Keine Token-Daten im gewählten Zeitraum vorhanden.</div>
      ) : chartType === "donut" ? (
        <div className="stats-donut-container">
          <svg viewBox="0 0 240 240" className="stats-donut-svg" width={220} height={220}>
            <g transform="translate(120, 120)">
              {donutData.map((slice) => {
                if (slice.count <= 0) return null;
                const pathData = describeArc(0, 0, 95, 55, slice.startAngle, slice.endAngle);
                return (
                  <path
                    key={slice.model}
                    d={pathData}
                    fill={slice.color}
                    className="stats-donut-slice"
                  >
                    <title>{`${slice.model}: ${formatNumber(slice.count)} Tokens (${slice.percentage}%)`}</title>
                  </path>
                );
              })}
            </g>
          </svg>
          <div className="stats-legend">
            {donutData.map((slice) => (
              <div key={slice.model} className="stats-legend-item">
                <span className="stats-legend-dot" style={{ backgroundColor: slice.color }} />
                <span className="stats-legend-name">{slice.model}</span>
                <span className="stats-legend-value">
                  {formatNumber(slice.count)} ({slice.percentage}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div ref={scrollRef} className="stats-chart-scrollable">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="stats-chart-svg"
            style={{ minWidth: isOverflowing ? `${width}px` : "100%" }}
          >
            {/* Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
              const y = padding.top + innerHeight * (1 - ratio);
              const value = Math.round(maxTokens * ratio);
              return (
                <g key={ratio} className="stats-grid-line">
                  <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} />
                  <text x={padding.left - 8} y={y + 3} textAnchor="end" className="stats-axis-text">
                    {formatNumber(value)}
                  </text>
                </g>
              );
            })}

            {/* Stacked Bars Mode */}
            {chartType === "stacked" &&
              timeSeries.map((point, index) => {
                const colWidth = innerWidth / timeSeries.length;
                const barWidth = Math.min(Math.max(colWidth * 0.65, 10), 36);
                const x = padding.left + index * colWidth + (colWidth - barWidth) / 2;
                const isHovered = hoveredIndex === index;

                let currentY = padding.top + innerHeight;
                const segments: Array<{ model: string; height: number; y: number; color: string; tokens: number }> = [];

                for (const model of models) {
                  const breakdown = point.tokensByModel[model];
                  if (!breakdown || breakdown.total <= 0) continue;
                  const segHeight = (breakdown.total / maxTokens) * innerHeight;
                  currentY -= segHeight;
                  segments.push({
                    model,
                    height: segHeight,
                    y: currentY,
                    color: modelColorMap.get(model) || DEFAULT_SERIES_COLOR,
                    tokens: breakdown.total,
                  });
                }

                return (
                  <g
                    key={point.period}
                    className={`stats-bar-group ${isHovered ? "stats-bar-group--active" : ""}`}
                    onMouseEnter={() => setHoveredIndex(index)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                    {segments.map((seg) => (
                      <rect
                        key={seg.model}
                        x={x}
                        y={seg.y}
                        width={barWidth}
                        height={Math.max(seg.height, 1)}
                        fill={seg.color}
                        rx={1.5}
                      />
                    ))}
                    <text
                      x={x + barWidth / 2}
                      y={height - padding.bottom + 16}
                      textAnchor="middle"
                      className="stats-axis-text"
                    >
                      {point.label}
                    </text>
                  </g>
                );
              })}

            {/* Line Mode */}
            {chartType === "line" && (
              <>
                {models.map((model) => {
                  const color = modelColorMap.get(model) || DEFAULT_SERIES_COLOR;
                  const points = timeSeries.map((point, index) => {
                    const colWidth = innerWidth / Math.max(timeSeries.length - 1, 1);
                    const x = padding.left + (timeSeries.length === 1 ? innerWidth / 2 : index * colWidth);
                    const tokens = point.tokensByModel[model]?.total || 0;
                    const y = padding.top + innerHeight - (tokens / maxTokens) * innerHeight;
                    return { x, y, tokens };
                  });

                  const d = points.reduce((acc, p, idx) => `${acc} ${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`, "");

                  return (
                    <g key={model} className="stats-line-series">
                      <path d={d} fill="none" stroke={color} strokeWidth={2.5} />
                      {points.map((p, idx) => (
                        <circle
                          key={idx}
                          cx={p.x}
                          cy={p.y}
                          r={hoveredIndex === idx ? 5 : 3}
                          fill={color}
                          stroke="var(--surface)"
                          strokeWidth={1.5}
                        />
                      ))}
                    </g>
                  );
                })}
                {timeSeries.map((point, index) => {
                  const colWidth = innerWidth / Math.max(timeSeries.length - 1, 1);
                  const x = padding.left + (timeSeries.length === 1 ? innerWidth / 2 : index * colWidth);
                  return (
                    <text
                      key={point.period}
                      x={x}
                      y={height - padding.bottom + 16}
                      textAnchor="middle"
                      className="stats-axis-text"
                    >
                      {point.label}
                    </text>
                  );
                })}
              </>
            )}
          </svg>
        </div>
      )}

      {/* Legend */}
      {chartType !== "donut" && (
        <div className="stats-legend stats-legend--bottom">
          {models.map((model) => (
            <div key={model} className="stats-legend-item">
              <span className="stats-legend-dot" style={{ backgroundColor: modelColorMap.get(model) }} />
              <span className="stats-legend-name">{model}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 2. Response Time / Latency Chart
 */
export function ResponseTimeChart({
  timeSeries,
  models,
}: {
  timeSeries: StatsTimeSeriesPoint[];
  models: string[];
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const scrollRef = useAutoScrollToEnd([timeSeries]);

  const maxDuration = useMemo(() => {
    let max = 1000;
    for (const p of timeSeries) {
      if (p.avgDurationMs > max) max = p.avgDurationMs;
      for (const dur of Object.values(p.durationByModel)) {
        if (dur > max) max = dur;
      }
    }
    return max;
  }, [timeSeries]);

  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    models.forEach((m, idx) => {
      map.set(m, getModelColor(m, idx));
    });
    return map;
  }, [models]);

  const height = 220;
  const isOverflowing = timeSeries.length > 14;
  const width = isOverflowing ? Math.max(timeSeries.length * 36, 600) : 600;
  const padding = { top: 20, right: 30, bottom: 40, left: 60 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  return (
    <div className="stats-card">
      <div className="stats-card-header">
        <div className="stats-card-title">
          <Icon name="clock" size={18} />
          <span>Antwortzeit & Latenz je Modell</span>
        </div>
      </div>

      {/* Floating Tooltip anchored to Card */}
      {hoveredIndex !== null && timeSeries[hoveredIndex] && (
        <div className="stats-chart-tooltip">
          <strong>{timeSeries[hoveredIndex].label}</strong>
          <div className="stats-tooltip-total">
            Durchschnitt: {formatDuration(timeSeries[hoveredIndex].avgDurationMs)}
          </div>
          {models.map((model) => {
            const dur = timeSeries[hoveredIndex].durationByModel[model];
            if (!dur) return null;
            return (
              <div key={model} className="stats-tooltip-row">
                <span className="stats-legend-dot" style={{ backgroundColor: modelColorMap.get(model) }} />
                <span>{model}:</span>
                <b>{formatDuration(dur)}</b>
              </div>
            );
          })}
        </div>
      )}

      {timeSeries.length === 0 ? (
        <div className="stats-empty-chart">Keine Latenz-Daten vorhanden.</div>
      ) : (
        <div ref={scrollRef} className="stats-chart-scrollable">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="stats-chart-svg"
            style={{ minWidth: isOverflowing ? `${width}px` : "100%" }}
          >
            {/* Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
              const y = padding.top + innerHeight * (1 - ratio);
              const value = Math.round(maxDuration * ratio);
              return (
                <g key={ratio} className="stats-grid-line">
                  <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} />
                  <text x={padding.left - 8} y={y + 3} textAnchor="end" className="stats-axis-text">
                    {formatDuration(value)}
                  </text>
                </g>
              );
            })}

            {/* Model lines */}
            {models.map((model) => {
              const color = modelColorMap.get(model) || DEFAULT_SERIES_COLOR;
              const points = timeSeries.map((point, index) => {
                const colWidth = innerWidth / Math.max(timeSeries.length - 1, 1);
                const x = padding.left + (timeSeries.length === 1 ? innerWidth / 2 : index * colWidth);
                const dur = point.durationByModel[model] || point.avgDurationMs || 0;
                const y = padding.top + innerHeight - (dur / maxDuration) * innerHeight;
                return { x, y, dur };
              });

              const d = points.reduce((acc, p, idx) => `${acc} ${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`, "");

              return (
                <g key={model} className="stats-line-series">
                  <path d={d} fill="none" stroke={color} strokeWidth={2.5} />
                  {points.map((p, idx) => (
                    <circle
                      key={idx}
                      cx={p.x}
                      cy={p.y}
                      r={hoveredIndex === idx ? 5 : 3}
                      fill={color}
                      stroke="var(--surface)"
                      strokeWidth={1.5}
                      onMouseEnter={() => setHoveredIndex(idx)}
                      onMouseLeave={() => setHoveredIndex(null)}
                    />
                  ))}
                </g>
              );
            })}

            {timeSeries.map((point, index) => {
              const colWidth = innerWidth / Math.max(timeSeries.length - 1, 1);
              const x = padding.left + (timeSeries.length === 1 ? innerWidth / 2 : index * colWidth);
              return (
                <text
                  key={point.period}
                  x={x}
                  y={height - padding.bottom + 16}
                  textAnchor="middle"
                  className="stats-axis-text"
                >
                  {point.label}
                </text>
              );
            })}
          </svg>
        </div>
      )}

      {/* Legend */}
      <div className="stats-legend stats-legend--bottom">
        {models.map((model) => (
          <div key={model} className="stats-legend-item">
            <span className="stats-legend-dot" style={{ backgroundColor: modelColorMap.get(model) }} />
            <span className="stats-legend-name">{model}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 3. Tokens Per Second (t/s) Line Chart
 * Visualizes individual response throughput per model to clearly highlight latency performance and outliers.
 */
export function TokensPerSecondChart({
  series = [],
  models = [],
}: {
  series?: TokensPerSecondPoint[];
  models?: string[];
}) {
  const [hoveredPoint, setHoveredPoint] = useState<TokensPerSecondPoint | null>(null);
  const scrollRef = useAutoScrollToEnd([series]);

  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    models.forEach((m, idx) => {
      map.set(m, getModelColor(m, idx));
    });
    return map;
  }, [models]);

  const pointsByModel = useMemo(() => {
    const map = new Map<string, TokensPerSecondPoint[]>();
    for (const m of models) {
      map.set(m, []);
    }
    for (const pt of series) {
      const list = map.get(pt.model);
      if (list) {
        list.push(pt);
      } else {
        map.set(pt.model, [pt]);
      }
    }
    return map;
  }, [series, models]);

  const { maxTps, avgTps, peakTps } = useMemo(() => {
    if (series.length === 0) {
      return { maxTps: 50, avgTps: 0, peakTps: 0 };
    }
    let max = 0;
    let sum = 0;
    for (const pt of series) {
      sum += pt.tokensPerSecond;
      if (pt.tokensPerSecond > max) {
        max = pt.tokensPerSecond;
      }
    }
    return {
      maxTps: Math.max(Math.ceil(max * 1.15), 20),
      avgTps: Math.round((sum / series.length) * 10) / 10,
      peakTps: max,
    };
  }, [series]);

  const height = 240;
  const isOverflowing = series.length > 14;
  const width = isOverflowing ? Math.max(series.length * 40, 600) : 600;
  const padding = { top: 24, right: 30, bottom: 44, left: 65 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const pointPositions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    if (series.length === 0) return map;
    const step = series.length === 1 ? 0 : innerWidth / (series.length - 1);
    series.forEach((pt, idx) => {
      const x = series.length === 1 ? padding.left + innerWidth / 2 : padding.left + idx * step;
      const y = padding.top + innerHeight - (pt.tokensPerSecond / maxTps) * innerHeight;
      map.set(pt.turnId, { x, y });
    });
    return map;
  }, [series, innerWidth, innerHeight, maxTps, padding.left, padding.top]);

  return (
    <div className="stats-card">
      <div className="stats-card-header">
        <div className="stats-card-title">
          <Icon name="zap" size={18} />
          <span>Tokens pro Sekunde (t/s) je Antwort & Modell</span>
        </div>
        <div className="stats-header-pills">
          {series.length > 0 && (
            <>
              <span className="stats-pill-metric" title="Durchschnittliche Generierungsgeschwindigkeit aller Antworten">
                Ø <b>{avgTps} t/s</b>
              </span>
              <span className="stats-pill-metric" title={`Maximaler Spitzenwert (Ausreißer): ${peakTps} t/s`}>
                Peak: <b>{peakTps} t/s</b>
              </span>
            </>
          )}
        </div>
      </div>

      {/* Floating Tooltip */}
      {hoveredPoint && (
        <div className="stats-chart-tooltip">
          <strong>
            {new Intl.DateTimeFormat("de-DE", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }).format(new Date(hoveredPoint.createdAt))}
          </strong>
          <div className="stats-tooltip-row">
            <span
              className="stats-legend-dot"
              style={{ backgroundColor: modelColorMap.get(hoveredPoint.model) || DEFAULT_SERIES_COLOR }}
            />
            <span>{formatModelDisplayName(hoveredPoint.model)}:</span>
            <b>{hoveredPoint.tokensPerSecond} t/s</b>
          </div>
          <div className="stats-tooltip-subdetail">
            <span>↑ Out: {formatNumber(hoveredPoint.outputTokens)} Tokens</span>
            <span>•</span>
            <span>Dauer: {formatDuration(hoveredPoint.durationMs)}</span>
          </div>
        </div>
      )}

      {series.length === 0 ? (
        <div className="stats-empty-chart">Keine Antwort-Daten im gewählten Zeitraum vorhanden.</div>
      ) : (
        <div ref={scrollRef} className="stats-chart-scrollable">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="stats-chart-svg"
            style={{ minWidth: isOverflowing ? `${width}px` : "100%" }}
          >
            {/* Horizontal Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
              const y = padding.top + innerHeight * (1 - ratio);
              const value = Math.round(maxTps * ratio);
              return (
                <g key={ratio} className="stats-grid-line">
                  <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} />
                  <text x={padding.left - 8} y={y + 3} textAnchor="end" className="stats-axis-text">
                    {value} t/s
                  </text>
                </g>
              );
            })}

            {/* Model lines & data points */}
            {models.map((model) => {
              const modelPoints = pointsByModel.get(model) || [];
              if (modelPoints.length === 0) return null;
              const color = modelColorMap.get(model) || DEFAULT_SERIES_COLOR;

              const pathCoords = modelPoints
                .map((pt) => pointPositions.get(pt.turnId))
                .filter((pos): pos is { x: number; y: number } => Boolean(pos));

              const d = pathCoords.reduce(
                (acc, p, idx) => `${acc} ${idx === 0 ? "M" : "L"} ${p.x} ${p.y}`,
                "",
              );

              return (
                <g key={model} className="stats-line-series">
                  {pathCoords.length > 1 && (
                    <path
                      d={d}
                      fill="none"
                      stroke={color}
                      strokeWidth={2.2}
                      opacity={0.85}
                    />
                  )}
                  {modelPoints.map((pt) => {
                    const pos = pointPositions.get(pt.turnId);
                    if (!pos) return null;
                    const isHovered = hoveredPoint?.turnId === pt.turnId;
                    const isPeak = pt.tokensPerSecond > 0 && pt.tokensPerSecond === peakTps;

                    return (
                      <g key={pt.turnId}>
                        {isPeak && (
                          <circle
                            cx={pos.x}
                            cy={pos.y}
                            r={isHovered ? 9 : 7}
                            fill="none"
                            stroke={color}
                            strokeWidth={1.5}
                            strokeDasharray="2 2"
                            opacity={0.7}
                          />
                        )}
                        <circle
                          cx={pos.x}
                          cy={pos.y}
                          r={isHovered ? 6 : 4}
                          fill={color}
                          stroke="var(--surface)"
                          strokeWidth={1.5}
                          onMouseEnter={() => setHoveredPoint(pt)}
                          onMouseLeave={() => setHoveredPoint(null)}
                        >
                          <title>{`${formatModelDisplayName(pt.model)}: ${pt.tokensPerSecond} t/s (${pt.outputTokens} Tokens in ${formatDuration(pt.durationMs)})`}</title>
                        </circle>
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* X-axis labels */}
            {series.map((pt, idx) => {
              const skipInterval = series.length > 30 ? Math.ceil(series.length / 15) : 1;
              if (idx % skipInterval !== 0 && idx !== series.length - 1) return null;

              const pos = pointPositions.get(pt.turnId);
              if (!pos) return null;

              const dateObj = new Date(pt.createdAt);
              const label = new Intl.DateTimeFormat("de-DE", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              }).format(dateObj);

              return (
                <text
                  key={pt.turnId}
                  x={pos.x}
                  y={height - padding.bottom + 16}
                  textAnchor="middle"
                  className="stats-axis-text"
                >
                  {label}
                </text>
              );
            })}
          </svg>
        </div>
      )}

      {/* Legend */}
      <div className="stats-legend stats-legend--bottom">
        {models.map((model) => (
          <div key={model} className="stats-legend-item">
            <span className="stats-legend-dot" style={{ backgroundColor: modelColorMap.get(model) }} />
            <span className="stats-legend-name">{formatModelDisplayName(model)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 4. Code Activity Chart (Lines of Code Added / Deleted)
 */
export function CodeActivityChart({ timeSeries }: { timeSeries: StatsTimeSeriesPoint[] }) {
  const scrollRef = useAutoScrollToEnd([timeSeries]);

  const maxLines = useMemo(() => {
    return Math.max(...timeSeries.map((p) => p.linesAdded + p.linesDeleted), 50);
  }, [timeSeries]);

  const height = 200;
  const isOverflowing = timeSeries.length > 14;
  const width = isOverflowing ? Math.max(timeSeries.length * 36, 600) : 600;
  const padding = { top: 20, right: 30, bottom: 40, left: 55 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  return (
    <div className="stats-card">
      <div className="stats-card-header">
        <div className="stats-card-title">
          <Icon name="file-text" size={18} />
          <span>Code-Aktivität (Zeilen ergänzt & angepasst)</span>
        </div>
      </div>

      {timeSeries.length === 0 ? (
        <div className="stats-empty-chart">Keine Code-Aktivität erfasst.</div>
      ) : (
        <div ref={scrollRef} className="stats-chart-scrollable">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="stats-chart-svg"
            style={{ minWidth: isOverflowing ? `${width}px` : "100%" }}
          >
            {/* Grid */}
            {[0, 0.5, 1].map((ratio) => {
              const y = padding.top + innerHeight * (1 - ratio);
              return (
                <g key={ratio} className="stats-grid-line">
                  <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} />
                  <text x={padding.left - 8} y={y + 3} textAnchor="end" className="stats-axis-text">
                    {formatNumber(Math.round(maxLines * ratio))}
                  </text>
                </g>
              );
            })}

            {timeSeries.map((point, index) => {
              const colWidth = innerWidth / timeSeries.length;
              const barWidth = Math.min(Math.max(colWidth * 0.5, 6), 26);
              const x = padding.left + index * colWidth + (colWidth - barWidth) / 2;

              const addedH = (point.linesAdded / maxLines) * innerHeight;
              const deletedH = (point.linesDeleted / maxLines) * innerHeight;

              const addedY = padding.top + innerHeight - addedH;
              const deletedY = addedY - deletedH;

              return (
                <g key={point.period} className="stats-bar-group">
                  {point.linesAdded > 0 && (
                    <rect
                      x={x}
                      y={addedY}
                      width={barWidth}
                      height={Math.max(addedH, 1)}
                      fill="var(--green)"
                      rx={1.5}
                    >
                      <title>{`+${point.linesAdded} Zeilen (${point.label})`}</title>
                    </rect>
                  )}
                  {point.linesDeleted > 0 && (
                    <rect
                      x={x}
                      y={deletedY}
                      width={barWidth}
                      height={Math.max(deletedH, 1)}
                      fill="var(--red)"
                      rx={1.5}
                    >
                      <title>{`-${point.linesDeleted} Zeilen (${point.label})`}</title>
                    </rect>
                  )}
                  <text
                    x={x + barWidth / 2}
                    y={height - padding.bottom + 16}
                    textAnchor="middle"
                    className="stats-axis-text"
                  >
                    {point.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <div className="stats-legend stats-legend--bottom">
        <div className="stats-legend-item">
          <span className="stats-legend-dot" style={{ backgroundColor: "var(--green)" }} />
          <span className="stats-legend-name">Ergänzte Zeilen (+)</span>
        </div>
        <div className="stats-legend-item">
          <span className="stats-legend-dot" style={{ backgroundColor: "var(--red)" }} />
          <span className="stats-legend-name">Gelöschte Zeilen (-)</span>
        </div>
      </div>
    </div>
  );
}

/**
 * 4. File Operations Activity Chart (Created / Modified / Deleted)
 */
export function FileActivityChart({ timeSeries }: { timeSeries: StatsTimeSeriesPoint[] }) {
  const scrollRef = useAutoScrollToEnd([timeSeries]);

  const maxFiles = useMemo(() => {
    return Math.max(...timeSeries.map((p) => p.filesCreated + p.filesModified + p.filesDeleted), 10);
  }, [timeSeries]);

  const totalCreated = useMemo(() => timeSeries.reduce((acc, p) => acc + p.filesCreated, 0), [timeSeries]);
  const totalModified = useMemo(() => timeSeries.reduce((acc, p) => acc + p.filesModified, 0), [timeSeries]);
  const totalDeleted = useMemo(() => timeSeries.reduce((acc, p) => acc + p.filesDeleted, 0), [timeSeries]);

  const height = 200;
  const isOverflowing = timeSeries.length > 14;
  const width = isOverflowing ? Math.max(timeSeries.length * 36, 600) : 600;
  const padding = { top: 20, right: 30, bottom: 40, left: 55 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  return (
    <div className="stats-card">
      <div className="stats-card-header">
        <div className="stats-card-title">
          <Icon name="folder" size={18} />
          <span>Datei-Aktivität (Erstellt, Bearbeitet, Gelöscht)</span>
        </div>
        <div className="stats-pill-metric">
          Gesamt: <b>{totalCreated + totalModified + totalDeleted} Operationen</b>
        </div>
      </div>

      {timeSeries.length === 0 ? (
        <div className="stats-empty-chart">Keine Datei-Aktivität im Zeitraum erfasst.</div>
      ) : (
        <div ref={scrollRef} className="stats-chart-scrollable">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="stats-chart-svg"
            style={{ minWidth: isOverflowing ? `${width}px` : "100%" }}
          >
            {/* Grid */}
            {[0, 0.5, 1].map((ratio) => {
              const y = padding.top + innerHeight * (1 - ratio);
              return (
                <g key={ratio} className="stats-grid-line">
                  <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} />
                  <text x={padding.left - 8} y={y + 3} textAnchor="end" className="stats-axis-text">
                    {formatNumber(Math.round(maxFiles * ratio))}
                  </text>
                </g>
              );
            })}

            {timeSeries.map((point, index) => {
              const colWidth = innerWidth / timeSeries.length;
              const barWidth = Math.min(Math.max(colWidth * 0.5, 6), 26);
              const x = padding.left + index * colWidth + (colWidth - barWidth) / 2;

              const createdH = (point.filesCreated / maxFiles) * innerHeight;
              const modifiedH = (point.filesModified / maxFiles) * innerHeight;
              const deletedH = (point.filesDeleted / maxFiles) * innerHeight;

              const createdY = padding.top + innerHeight - createdH;
              const modifiedY = createdY - modifiedH;
              const deletedY = modifiedY - deletedH;

              return (
                <g key={point.period} className="stats-bar-group">
                  {point.filesCreated > 0 && (
                    <rect
                      x={x}
                      y={createdY}
                      width={barWidth}
                      height={Math.max(createdH, 1)}
                      fill="var(--accent)"
                      rx={1.5}
                    >
                      <title>{`+${point.filesCreated} Dateien erstellt (${point.label})`}</title>
                    </rect>
                  )}
                  {point.filesModified > 0 && (
                    <rect
                      x={x}
                      y={modifiedY}
                      width={barWidth}
                      height={Math.max(modifiedH, 1)}
                      fill="var(--amber)"
                      rx={1.5}
                    >
                      <title>{`~${point.filesModified} Dateien bearbeitet (${point.label})`}</title>
                    </rect>
                  )}
                  {point.filesDeleted > 0 && (
                    <rect
                      x={x}
                      y={deletedY}
                      width={barWidth}
                      height={Math.max(deletedH, 1)}
                      fill="var(--red)"
                      rx={1.5}
                    >
                      <title>{`-${point.filesDeleted} Dateien gelöscht (${point.label})`}</title>
                    </rect>
                  )}
                  <text
                    x={x + barWidth / 2}
                    y={height - padding.bottom + 16}
                    textAnchor="middle"
                    className="stats-axis-text"
                  >
                    {point.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <div className="stats-legend stats-legend--bottom">
        <div className="stats-legend-item">
          <span className="stats-legend-dot" style={{ backgroundColor: "var(--accent)" }} />
          <span className="stats-legend-name">Erstellt (+{totalCreated})</span>
        </div>
        <div className="stats-legend-item">
          <span className="stats-legend-dot" style={{ backgroundColor: "var(--amber)" }} />
          <span className="stats-legend-name">Bearbeitet (~{totalModified})</span>
        </div>
        <div className="stats-legend-item">
          <span className="stats-legend-dot" style={{ backgroundColor: "var(--red)" }} />
          <span className="stats-legend-name">Gelöscht (-{totalDeleted})</span>
        </div>
      </div>
    </div>
  );
}

/**
 * 4. Plan Mode Decisions Chart
 */
export function PlanModeStatsChart({
  timeSeries,
  summary,
}: {
  timeSeries: StatsTimeSeriesPoint[];
  summary: AppStats["summary"];
}) {
  const scrollRef = useAutoScrollToEnd([timeSeries]);

  const maxDecisions = useMemo(() => {
    return Math.max(...timeSeries.map((p) => p.planAccepted + p.planRejected), 5);
  }, [timeSeries]);

  const height = 180;
  const isOverflowing = timeSeries.length > 14;
  const width = isOverflowing ? Math.max(timeSeries.length * 36, 600) : 600;
  const padding = { top: 20, right: 30, bottom: 40, left: 45 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  return (
    <div className="stats-card">
      <div className="stats-card-header">
        <div className="stats-card-title">
          <Icon name="brain" size={18} />
          <span>Planungsmodus Entscheidungen</span>
        </div>
        <div className="stats-pill-metric">
          Akzeptanzrate: <b>{summary.planAcceptanceRate}%</b>
        </div>
      </div>

      {summary.planTotal === 0 ? (
        <div className="stats-empty-chart">Keine Plan-Entscheidungen im gewählten Zeitraum.</div>
      ) : (
        <div ref={scrollRef} className="stats-chart-scrollable">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="stats-chart-svg"
            style={{ minWidth: isOverflowing ? `${width}px` : "100%" }}
          >
            {/* Grid */}
            {[0, 0.5, 1].map((ratio) => {
              const y = padding.top + innerHeight * (1 - ratio);
              return (
                <g key={ratio} className="stats-grid-line">
                  <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} />
                  <text x={padding.left - 8} y={y + 3} textAnchor="end" className="stats-axis-text">
                    {Math.round(maxDecisions * ratio)}
                  </text>
                </g>
              );
            })}

            {timeSeries.map((point, index) => {
              const colWidth = innerWidth / timeSeries.length;
              const barWidth = Math.min(Math.max(colWidth * 0.5, 6), 26);
              const x = padding.left + index * colWidth + (colWidth - barWidth) / 2;

              const accH = (point.planAccepted / maxDecisions) * innerHeight;
              const rejH = (point.planRejected / maxDecisions) * innerHeight;

              const accY = padding.top + innerHeight - accH;
              const rejY = accY - rejH;

              return (
                <g key={point.period} className="stats-bar-group">
                  {point.planAccepted > 0 && (
                    <rect
                      x={x}
                      y={accY}
                      width={barWidth}
                      height={Math.max(accH, 1)}
                      fill="var(--green)"
                      rx={1.5}
                    >
                      <title>{`${point.planAccepted} Pläne akzeptiert (${point.label})`}</title>
                    </rect>
                  )}
                  {point.planRejected > 0 && (
                    <rect
                      x={x}
                      y={rejY}
                      width={barWidth}
                      height={Math.max(rejH, 1)}
                      fill="var(--red)"
                      rx={1.5}
                    >
                      <title>{`${point.planRejected} Pläne abgelehnt (${point.label})`}</title>
                    </rect>
                  )}
                  <text
                    x={x + barWidth / 2}
                    y={height - padding.bottom + 16}
                    textAnchor="middle"
                    className="stats-axis-text"
                  >
                    {point.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <div className="stats-legend stats-legend--bottom">
        <div className="stats-legend-item">
          <span className="stats-legend-dot" style={{ backgroundColor: "var(--green)" }} />
          <span className="stats-legend-name">Angenommen ({summary.planAccepted})</span>
        </div>
        <div className="stats-legend-item">
          <span className="stats-legend-dot" style={{ backgroundColor: "var(--red)" }} />
          <span className="stats-legend-name">Abgelehnt ({summary.planRejected})</span>
        </div>
      </div>
    </div>
  );
}

/**
 * 5. Tool, Skills, MCP, Git & Shell Breakdown Section
 */
export function ToolUsageRankingSection({ summary }: { summary: AppStats["summary"] }) {
  return (
    <div className="stats-tool-rankings-grid">
      {/* 1. Skills Breakdown */}
      <div className="stats-card">
        <div className="stats-card-header">
          <div className="stats-card-title">
            <Icon name="skill" size={18} />
            <span>Verwendete Skills</span>
          </div>
          <span className="stats-badge">{summary.skillsUsedTotal} Aufrufe</span>
        </div>
        <div className="stats-ranking-content">
          {summary.topSkills.length === 0 ? (
            <div className="stats-empty-rankings">Keine Skills im Zeitraum aufgerufen.</div>
          ) : (
            <div className="stats-ranking-list">
              {summary.topSkills.map((item, idx) => {
                const max = summary.topSkills[0]?.count || 1;
                const pct = Math.round((item.count / max) * 100);
                return (
                  <div key={item.name} className="stats-ranking-item">
                    <div className="stats-ranking-item-header">
                      <span className="stats-ranking-rank">#{idx + 1}</span>
                      <span className="stats-ranking-name" title={item.name}>{item.name}</span>
                      <span className="stats-ranking-count">{item.count}×</span>
                    </div>
                    <div className="stats-ranking-bar-bg">
                      <div
                        className="stats-ranking-bar-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 2. MCP Tools Breakdown */}
      <div className="stats-card">
        <div className="stats-card-header">
          <div className="stats-card-title">
            <Icon name="server" size={18} />
            <span>MCP-Tools</span>
          </div>
          <span className="stats-badge">{summary.mcpUsedTotal} Aufrufe</span>
        </div>
        <div className="stats-ranking-content">
          {summary.topMcpTools.length === 0 ? (
            <div className="stats-empty-rankings">Keine MCP-Tools im Zeitraum verwendet.</div>
          ) : (
            <div className="stats-ranking-list">
              {summary.topMcpTools.map((item, idx) => {
                const max = summary.topMcpTools[0]?.count || 1;
                const pct = Math.round((item.count / max) * 100);
                return (
                  <div key={item.name} className="stats-ranking-item">
                    <div className="stats-ranking-item-header">
                      <span className="stats-ranking-rank">#{idx + 1}</span>
                      <span className="stats-ranking-name" title={item.name}>{item.name}</span>
                      <span className="stats-ranking-count">{item.count}×</span>
                    </div>
                    <div className="stats-ranking-bar-bg">
                      <div
                        className="stats-ranking-bar-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 3. Git Actions Breakdown */}
      <div className="stats-card">
        <div className="stats-card-header">
          <div className="stats-card-title">
            <Icon name="branch" size={18} />
            <span>Git-Aktionen</span>
          </div>
          <span className="stats-badge">{summary.gitActionsTotal} Aktionen</span>
        </div>
        <div className="stats-ranking-content">
          {summary.topGitActions.length === 0 ? (
            <div className="stats-empty-rankings">Keine Git-Aktionen im Zeitraum erfasst.</div>
          ) : (
            <div className="stats-ranking-list">
              {summary.topGitActions.map((item, idx) => {
                const max = summary.topGitActions[0]?.count || 1;
                const pct = Math.round((item.count / max) * 100);
                return (
                  <div key={item.name} className="stats-ranking-item">
                    <div className="stats-ranking-item-header">
                      <span className="stats-ranking-rank">#{idx + 1}</span>
                      <span className="stats-ranking-name">
                        <code>git {item.name}</code>
                      </span>
                      <span className="stats-ranking-count">{item.count}×</span>
                    </div>
                    <div className="stats-ranking-bar-bg">
                      <div
                        className="stats-ranking-bar-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 4. Shell & Terminal Commands Breakdown */}
      <div className="stats-card">
        <div className="stats-card-header">
          <div className="stats-card-title">
            <Icon name="tool" size={18} />
            <span>Top Shell-Befehle</span>
          </div>
          <span className="stats-badge">{summary.shellCommandsTotal} Befehle</span>
        </div>
        <div className="stats-ranking-content">
          {summary.topShellCommands.length === 0 ? (
            <div className="stats-empty-rankings">Keine Shell-Befehle im Zeitraum erfasst.</div>
          ) : (
            <div className="stats-ranking-list">
              {summary.topShellCommands.map((item, idx) => {
                const max = summary.topShellCommands[0]?.count || 1;
                const pct = Math.round((item.count / max) * 100);
                return (
                  <div key={item.name} className="stats-ranking-item">
                    <div className="stats-ranking-item-header">
                      <span className="stats-ranking-rank">#{idx + 1}</span>
                      <span className="stats-ranking-name" title={item.name}>
                        <code>{item.name}</code>
                      </span>
                      <span className="stats-ranking-count">{item.count}×</span>
                    </div>
                    <div className="stats-ranking-bar-bg">
                      <div
                        className="stats-ranking-bar-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 6. Model Comparison Table
 */
export function ModelComparisonTable({ models }: { models: ModelComparisonItem[] }) {
  if (models.length === 0) {
    return (
      <div className="stats-card">
        <div className="stats-card-header">
          <div className="stats-card-title">
            <Icon name="sparkle" size={18} />
            <span>Modell-Vergleich</span>
          </div>
        </div>
        <div className="stats-empty-chart">Keine Modelldaten vorhanden.</div>
      </div>
    );
  }

  const maxTokens = Math.max(...models.map((m) => m.totalTokens), 1);
  const minLatency = Math.min(...models.filter((m) => m.avgDurationMs > 0).map((m) => m.avgDurationMs), 999999);

  return (
    <div className="stats-card">
      <div className="stats-card-header">
        <div className="stats-card-title">
          <Icon name="sparkle" size={18} />
          <span>Modell-Vergleich im Detail</span>
        </div>
      </div>

      <div className="stats-table-wrapper">
        <table className="stats-table">
          <thead>
            <tr>
              <th>Modell</th>
              <th>Tokens Gesamt</th>
              <th>Input / Output (%)</th>
              <th>Cache-Rate (%)</th>
              <th>Antwortzeit (Ø)</th>
              <th>Tokens / s (Ø)</th>
              <th>Code-Zeilen (+)</th>
              <th>Anfragen</th>
              <th>Fehlerquote</th>
              <th>Anteil</th>
            </tr>
          </thead>
          <tbody>
            {models.map((item, idx) => {
              const color = getModelColor(item.model, idx);
              const isFastest = item.avgDurationMs > 0 && item.avgDurationMs <= minLatency * 1.05;
              const barWidthPct = Math.round((item.totalTokens / maxTokens) * 100);

              return (
                <tr key={item.model}>
                  <td>
                    <div className="stats-table-model-cell">
                      <span className="stats-legend-dot" style={{ backgroundColor: color }} />
                      <div>
                        <strong>{item.displayName}</strong>
                        <small>{item.model}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="stats-table-tokens-cell">
                      <span>{formatNumber(item.totalTokens)}</span>
                      <div className="stats-table-bar-bg">
                        <div
                          className="stats-table-bar-fill"
                          style={{ width: `${barWidthPct}%`, backgroundColor: color }}
                        />
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="stats-table-io-cell">
                      <span title={`Input: ${item.inputPercentage}%`}>
                        ↓ {formatNumber(item.inputTokens)} <small>({item.inputPercentage}%)</small>
                      </span>
                      <span title={`Output: ${item.outputPercentage}%`}>
                        ↑ {formatNumber(item.outputTokens)} <small>({item.outputPercentage}%)</small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="stats-table-cache">
                      <Icon name="zap" size={10} /> <strong>{item.cacheHitRate}%</strong>
                      {item.cachedTokens > 0 && (
                        <small className="stats-table-cache-tokens">
                          {" "}({formatNumber(item.cachedTokens)})
                        </small>
                      )}
                    </span>
                  </td>
                  <td>
                    <span className={`stats-table-latency ${isFastest ? "stats-table-latency--fastest" : ""}`}>
                      {formatDuration(item.avgDurationMs)}
                      {isFastest && <Icon name="zap" size={11} />}
                    </span>
                  </td>
                  <td>
                    <span className="stats-table-tps">
                      <strong>{item.tokensPerSecond > 0 ? `${item.tokensPerSecond} t/s` : "–"}</strong>
                    </span>
                  </td>
                  <td>
                    <span className="stats-table-loc">+{formatNumber(item.linesAdded)}</span>
                  </td>
                  <td>{item.turnCount}</td>
                  <td>
                    <span className={item.errorRate > 5 ? "stats-text-danger" : "stats-text-success"}>
                      {item.errorRate}%
                    </span>
                  </td>
                  <td>
                    <div className="stats-badge">
                      {item.sharePercentage}%
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeArc(x: number, y: number, radius: number, innerRadius: number, startAngle: number, endAngle: number) {
  const effectiveEnd = endAngle - startAngle >= 360 ? startAngle + 359.99 : endAngle;
  const start = polarToCartesian(x, y, radius, effectiveEnd);
  const end = polarToCartesian(x, y, radius, startAngle);
  const innerStart = polarToCartesian(x, y, innerRadius, effectiveEnd);
  const innerEnd = polarToCartesian(x, y, innerRadius, startAngle);

  const largeArcFlag = effectiveEnd - startAngle <= 180 ? "0" : "1";

  return [
    "M", start.x, start.y,
    "A", radius, radius, 0, largeArcFlag, 0, end.x, end.y,
    "L", innerEnd.x, innerEnd.y,
    "A", innerRadius, innerRadius, 0, largeArcFlag, 1, innerStart.x, innerStart.y,
    "Z",
  ].join(" ");
}
