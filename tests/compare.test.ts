import { describe, expect, it } from "vitest";
import { alignReadings, compareHref, readCompareQuery, sharesScale } from "@/lib/compare";
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
});

function observation(observedAt: string, value: number) {
  return { observedAt, value, revision: 1, quality: null, ingestedAt: observedAt };
}

describe("aligned readings", () => {
  it("lines up exact observation times newest first and keeps sub-millisecond source times distinct", () => {
    const a = observation("2026-11-19T10:15:00Z", 2);
    const b = observation("2026-11-19T10:15:00.000Z", 20);
    const later = observation("2026-11-19T10:15:00.0000001Z", -3);
    expect(alignReadings([a], [b, later])).toEqual([
      { time: later.observedAt, a: null, b: later },
      { time: a.observedAt, a, b },
    ]);
  });
});
