import { describe, expect, it } from "vitest";
import { getSampledTickIndices } from "../../src/renderer/features/stats/StatsCharts";

describe("getSampledTickIndices", () => {
  it("returns empty set for empty series (0 items)", () => {
    const ticks = getSampledTickIndices(0, 600, 65);
    expect(ticks.size).toBe(0);
  });

  it("returns single index 0 for 1 item", () => {
    const ticks = getSampledTickIndices(1, 600, 65);
    expect(Array.from(ticks)).toEqual([0]);
  });

  it("returns all indices when items fit comfortably within width", () => {
    // 7 items (7 days), width 500px, minSpacing 65px -> maxTicks = 7
    const ticks = getSampledTickIndices(7, 500, 65);
    expect(Array.from(ticks)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("samples evenly spaced indices when items exceed available space", () => {
    // 30 items (30 days), width 515px, minSpacing 65px -> maxTicks = 7
    const ticks = getSampledTickIndices(30, 515, 65);
    const list = Array.from(ticks).sort((a, b) => a - b);

    // Must start with 0 (first date) and end with 29 (last date)
    expect(list[0]).toBe(0);
    expect(list[list.length - 1]).toBe(29);
    // Number of ticks should equal maxTicks (7)
    expect(list.length).toBe(7);

    // Check that every index is valid and strictly increasing
    for (let i = 1; i < list.length; i++) {
      expect(list[i]).toBeGreaterThan(list[i - 1]!);
      expect(list[i]).toBeLessThanOrEqual(29);
    }
  });

  it("handles 90-day time series cleanly across scrollable width", () => {
    // 90 items, scrollable innerWidth 995px, minSpacing 65px -> maxTicks = 15
    const ticks = getSampledTickIndices(90, 995, 65);
    const list = Array.from(ticks).sort((a, b) => a - b);

    expect(list[0]).toBe(0);
    expect(list[list.length - 1]).toBe(89);
    expect(list.length).toBeLessThanOrEqual(16);
    expect(list.length).toBeGreaterThanOrEqual(10);
  });

  it("samples timestamps for turn metrics line chart without overlap", () => {
    // 20 turn responses, width 505px, minSpacing 85px -> maxTicks = 5
    const ticks = getSampledTickIndices(20, 505, 85);
    const list = Array.from(ticks).sort((a, b) => a - b);

    expect(list[0]).toBe(0);
    expect(list[list.length - 1]).toBe(19);
    expect(list.length).toBe(5);
  });

  it("handles very narrow containers gracefully", () => {
    // very narrow innerWidth (50px < minSpacing 65px) -> maxTicks = 1
    const ticks = getSampledTickIndices(30, 50, 65);
    expect(Array.from(ticks)).toEqual([29]);
  });
});
