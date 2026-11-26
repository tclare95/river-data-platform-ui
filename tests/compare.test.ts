import { describe, expect, it } from "vitest";
import {
  alignReadings,
  compareHref,
  comparisonAxes,
  comparisonInspectionRows,
  readCompareQuery,
  sharesScale,
} from "@/lib/compare";
import type { PublicMeasurement } from "@/lib/rdp/public";
import type { RainfallInterval } from "@/lib/history/rainfall";

function measure(overrides: Partial<PublicMeasurement>): PublicMeasurement {
  return {
    measurementId: "ea-x-level",
    stationId: "ea-x",
    name: "X",
    parameter: "level",
    unit: "mASD",
    datum: "ASD",
    kind: "instantaneous",
    expectedIntervalSeconds: 900,
    periodSeconds: null,
    source: { label: "Environment Agency", attribution: "OGL" },
    ...overrides,
  };
}

describe("comparison query", () => {
  it("reads single values, flags repeated ones and defaults the range", () => {
    expect(readCompareQuery({ a: "ea-a", b: "ea-b", range: "30d" })).toEqual({
      ids: ["ea-a", "ea-b"],
      repeated: false,
      range: "30d",
    });
    expect(readCompareQuery({ a: ["ea-a", "ea-c"], b: "", range: "1y" })).toEqual({
      ids: [],
      repeated: true,
      range: "7d",
    });
  });

  it("builds stable links", () => {
    expect(compareHref()).toBe("/compare");
    expect(compareHref(["ea-a"], "7d")).toBe("/compare?a=ea-a&range=7d");
    const ids = ["ea-b", "ea-a", "ea-c", "ea-d"];
    const href = compareHref(ids, "30d");
    expect(href).toBe("/compare?a=ea-b&b=ea-a&c=ea-c&d=ea-d&range=30d");
    expect(
      readCompareQuery(Object.fromEntries(new URL(href, "https://example.test").searchParams)),
    ).toEqual({ ids, repeated: false, range: "30d" });
  });
});

describe("scale basis", () => {
  const colwick = measure({ measurementId: "ea-colwick-level", stationId: "ea-colwick" });
  const shardlow = measure({ measurementId: "ea-shardlow-level", stationId: "ea-shardlow" });

  it("never shares a scale between levels on different station-local datums", () => {
    expect(sharesScale(colwick, shardlow)).toBe(false);
    const unknown = measure({ stationId: "ea-y", datum: "unknown" });
    expect(sharesScale(colwick, unknown)).toBe(false);
  });

  it("keeps different or unknown level datums apart even at the same station", () => {
    expect(sharesScale(colwick, { ...colwick, datum: "AOD" })).toBe(false);
    const unknown = { ...colwick, datum: "unknown" };
    expect(sharesScale(unknown, unknown)).toBe(false);
  });

  it("keeps level and flow on independent scales", () => {
    const flow = measure({ parameter: "flow", unit: "m3/s", datum: "unknown" });
    expect(sharesScale(shardlow, flow)).toBe(false);
  });

  it("keeps different units apart even for one parameter", () => {
    const cm = measure({ stationId: "ea-y", unit: "cm" });
    expect(sharesScale(colwick, cm)).toBe(false);
  });

  it("shares a scale for the same unit on a shared datum, or for flows", () => {
    const aod = (station: string) => measure({ stationId: station, unit: "mAOD", datum: "AOD" });
    expect(sharesScale(aod("ea-a"), aod("ea-b"))).toBe(true);
    const flow = (station: string) =>
      measure({ stationId: station, parameter: "flow", unit: "m3/s", datum: "unknown" });
    expect(sharesScale(flow("ea-a"), flow("ea-b"))).toBe(true);
  });

  it("groups compatible rainfall periods regardless of selection order", () => {
    const rain = measure({
      parameter: "rainfall",
      kind: "period_total",
      unit: "mm",
      periodSeconds: 900,
    });
    const daily = { ...rain, periodSeconds: 86400 };
    const other = { ...rain, stationId: "ea-y" };
    expect(comparisonAxes([rain, daily, other, colwick], (item) => item)).toEqual([
      [rain, other],
      [daily],
      [colwick],
    ]);
  });
});

function observation(observedAt: string, value: number) {
  return { observedAt, value, revision: 1, quality: null, ingestedAt: observedAt };
}

describe("aligned readings", () => {
  it("lines up exact observation times newest first and keeps sub-millisecond source times distinct", () => {
    const a = observation("2026-11-19T10:15:00Z", 2);
    const b = observation("2026-11-19T10:15:00.000Z", 20);
    const later = observation("2026-11-19T10:15:00.0000001Z", -3);
    expect(alignReadings([[a], [], [b, later], [later]])).toEqual([
      { time: later.observedAt, readings: [null, null, later, later] },
      { time: a.observedAt, readings: [a, null, b, null] },
    ]);
  });

  it("aligns opposing offsets at an exact display time and leaves other readings missing", () => {
    const a = Object.freeze(observation("2026-11-19T10:15:00.0000001Z", 2));
    const b = Object.freeze(observation("2026-11-19T11:45:00.0000001Z", 20));
    const later = observation("2026-11-19T11:15:00.0000002Z", 3);
    const rows = alignReadings([[a], [b], [later]], [60, -30, 0]);
    expect(rows).toEqual([
      { time: later.observedAt, readings: [null, null, later] },
      { time: "2026-11-19T11:15:00.0000001Z", readings: [a, b, null] },
    ]);
    expect(rows[1].readings[0]).toBe(a);
    expect(rows[1].readings[1]).toBe(b);
  });

  it("inspects a shifted rainfall interval at its displayed midpoint and leaves the next gap empty", () => {
    const interval = Object.freeze({
      label: "2026-11-19T10:15:00Z",
      periodStart: "2026-11-19T10:00:00Z",
      periodEnd: "2026-11-19T10:15:00Z",
      labelConvention: "period_end",
      totalMm: 1.25,
    } satisfies Partial<RainfallInterval>) as RainfallInterval;
    const missing = observation("2026-11-19T10:30:00Z", 3);
    const offsets = [-15, 0];
    const rows = alignReadings([[interval], [missing]], offsets);
    const window = { from: "2026-11-19T09:00:00Z", to: "2026-11-19T11:00:00Z" };
    expect(
      comparisonInspectionRows(rows, offsets, window).map(({ time, readings }) => ({
        time,
        readings,
      })),
    ).toEqual([
      { time: "2026-11-19T09:52:30.000Z", readings: [interval, null] },
      { time: "2026-11-19T10:00:00Z", readings: [interval, null] },
      { time: missing.observedAt, readings: [null, missing] },
    ]);
  });
});
