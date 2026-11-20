import { describe, expect, it } from "vitest";
import {
  alignReadings,
  compareHref,
  isComparable,
  readCompareQuery,
  scaleBasis,
} from "@/lib/compare";
import type { PublicMeasurement } from "@/lib/rdp/public";

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
      a: "ea-a",
      b: "ea-b",
      range: "30d",
    });
    expect(readCompareQuery({ a: ["ea-a", "ea-c"], b: "", range: "1y" })).toEqual({
      a: "ea-a,ea-c",
      b: null,
      range: "7d",
    });
  });

  it("builds stable links", () => {
    expect(compareHref({})).toBe("/compare");
    expect(compareHref({ a: "ea-a", b: undefined, range: "7d" })).toBe("/compare?a=ea-a&range=7d");
  });

  it("leaves rainfall period totals out", () => {
    expect(isComparable(measure({}))).toBe(true);
    expect(isComparable(measure({ kind: "period_total", parameter: "rainfall" }))).toBe(false);
  });
});

describe("scale basis", () => {
  const colwick = measure({ measurementId: "ea-colwick-level", stationId: "ea-colwick" });
  const shardlow = measure({ measurementId: "ea-shardlow-level", stationId: "ea-shardlow" });

  it("never shares a scale between levels on different station-local datums", () => {
    expect(scaleBasis(colwick, shardlow)).toEqual({ shared: false, reason: "local_datum" });
    const unknown = measure({ stationId: "ea-y", datum: "unknown" });
    expect(scaleBasis(colwick, unknown)).toEqual({ shared: false, reason: "local_datum" });
  });

  it("keeps level and flow on independent scales", () => {
    const flow = measure({ parameter: "flow", unit: "m3/s", datum: "unknown" });
    expect(scaleBasis(shardlow, flow)).toEqual({ shared: false, reason: "different_parameter" });
  });

  it("keeps different units apart even for one parameter", () => {
    const cm = measure({ stationId: "ea-y", unit: "cm" });
    expect(scaleBasis(colwick, cm)).toEqual({ shared: false, reason: "different_unit" });
  });

  it("shares a scale for the same unit on a shared datum, or for flows", () => {
    const aod = (station: string) => measure({ stationId: station, unit: "mAOD", datum: "AOD" });
    expect(scaleBasis(aod("ea-a"), aod("ea-b"))).toEqual({ shared: true });
    const flow = (station: string) =>
      measure({ stationId: station, parameter: "flow", unit: "m3/s", datum: "unknown" });
    expect(scaleBasis(flow("ea-a"), flow("ea-b"))).toEqual({ shared: true });
  });
});

describe("aligned readings", () => {
  it("lines up exact observation times newest first and never fills a missing value", () => {
    const rows = alignReadings(
      [
        { observedAt: "2026-11-19T10:00:00Z", value: 1 },
        { observedAt: "2026-11-19T10:15:00Z", value: 2 },
      ],
      [
        { observedAt: "2026-11-19T10:15:00.000Z", value: 20 },
        { observedAt: "2026-11-19T10:30:00Z", value: -3 },
      ],
    );
    expect(rows).toEqual([
      { observedAt: "2026-11-19T10:30:00Z", a: null, b: -3 },
      { observedAt: "2026-11-19T10:15:00Z", a: 2, b: 20 },
      { observedAt: "2026-11-19T10:00:00Z", a: 1, b: null },
    ]);
  });

  it("keeps readings a few minutes apart as separate times", () => {
    const rows = alignReadings(
      [{ observedAt: "2026-11-19T10:00:00Z", value: 1 }],
      [{ observedAt: "2026-11-19T10:05:00Z", value: 2 }],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.a === null || row.b === null)).toBe(true);
  });
});
