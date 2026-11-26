import { describe, expect, it } from "vitest";
import { HOUR_MS, isRecentReading, summarizeObservations } from "@/lib/history/observation-summary";
import type { PublicLatest, PublicMeasurement } from "@/lib/rdp/public";

const END = Date.parse("2026-11-26T12:00:00Z");
const QUARTER = HOUR_MS / 4;
const measurement: PublicMeasurement = {
  measurementId: "ea-test-level",
  stationId: "ea-test",
  name: "Test",
  parameter: "level",
  kind: "instantaneous",
  unit: "mASD",
  datum: "ASD",
  expectedIntervalSeconds: 900,
  periodSeconds: null,
  source: { label: "Environment Agency", attribution: "" },
};
const iso = (time: number) => new Date(time).toISOString();
const reading = (quartersAgo: number, value: number) => ({
  observedAt: iso(END - quartersAgo * QUARTER),
  value,
});
const history = (sample: (quartersAgo: number) => number) =>
  Array.from({ length: 96 }, (_, index) => reading(96 - index, sample(96 - index)));

describe("observation summaries", () => {
  it("shows rising level, signed changes, actual extrema and a time-scaled sparkline", () => {
    const result = summarizeObservations(
      measurement,
      reading(0, 1),
      history((ago) => 1 - ago / 64),
      [],
    );
    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("Expected a summary");
    expect(result.changes).toEqual([
      { hours: 1, change: 0.0625 },
      { hours: 6, change: 0.375 },
      { hours: 24, change: 1.5 },
    ]);
    expect(result.recent).toEqual({
      rate: 0.0625,
      trend: "Rising",
      from: iso(END - HOUR_MS),
      elapsedMinutes: 60,
    });
    expect(result.day).toMatchObject({ min: -0.5, max: 1 });
    expect(result.day?.sparkline).toHaveLength(97);
    expect(result.day?.sparkline.at(-1)).toEqual([1, 0]);
  });

  it("shows falling flow using the actual elapsed time between readings", () => {
    const flow = { ...measurement, parameter: "flow", unit: "m3/s" };
    const rows = history((ago) => 10 + ago);
    rows[92] = reading(3.6, 14);
    const result = summarizeObservations(flow, reading(0, 10), rows, []);
    expect(result).toMatchObject({
      status: "available",
      recent: { rate: -4 / 0.9, trend: "Falling", elapsedMinutes: 54 },
    });
  });

  it.each([
    { parameter: "level", unit: "mASD", start: 1, change: 0.004 },
    { parameter: "flow", unit: "m3/s", start: 100, change: 1 },
  ])(
    "treats small $parameter fluctuations as broadly stable",
    ({ parameter, unit, start, change }) => {
      const result = summarizeObservations(
        { ...measurement, parameter, unit },
        reading(0, start + change),
        history((ago) => start + (ago % 2 === 0 ? 0 : change)),
        [],
      );
      expect(result).toMatchObject({ status: "available", recent: { trend: "Broadly stable" } });
    },
  );

  it("suppresses every result when widely spaced endpoints are all that exist", () => {
    expect(
      summarizeObservations(measurement, reading(0, 1), [reading(96, 0), reading(4, 0)], []),
    ).toEqual({ status: "insufficient" });
  });

  it("keeps the short window when a missed reading or reported outage breaks longer windows", () => {
    const rows = history(() => 1);
    for (const [data, gaps] of [
      [rows.filter((row) => row.observedAt !== reading(12, 0).observedAt), []],
      [rows, [{ from: reading(12, 0).observedAt, to: reading(11, 0).observedAt }]],
    ] as const) {
      expect(summarizeObservations(measurement, reading(0, 1), data, gaps)).toMatchObject({
        status: "available",
        changes: [
          { hours: 1, change: 0 },
          { hours: 6, change: null },
          { hours: 24, change: null },
        ],
        day: null,
      });
    }
  });

  it("rejects a comparison outside tolerance and excludes readings older than 24 hours from extrema", () => {
    const oldest = reading(96.4, 100);
    const rows = history(() => 1);
    rows[0] = oldest;
    // Keep continuity while moving both candidates outside the half-cadence tolerance.
    rows[92] = reading(4.6, 2);
    rows[91] = reading(5.6, 1);
    rows[90] = reading(6.4, 1);
    rows[93] = reading(3.4, 1);
    const result = summarizeObservations(measurement, reading(0, 1), rows, []);
    expect(result).toMatchObject({
      status: "available",
      changes: [
        { hours: 1, change: null },
        { hours: 6, change: 0 },
        { hours: 24, change: -99 },
      ],
      recent: null,
      day: { min: 1, max: 2 },
    });
  });

  it("rejects stale and unknown observations, including a cached fresh verdict past its age limit", () => {
    const latest: PublicLatest = {
      kind: "instantaneous",
      status: "available",
      freshness: "fresh",
      quality: null,
      ...reading(0, 1),
    };
    expect(isRecentReading(latest, QUARTER, END)).toBe(true);
    expect(isRecentReading({ ...latest, freshness: "stale" }, QUARTER, END)).toBe(false);
    expect(isRecentReading({ ...latest, freshness: "unknown" }, QUARTER, END)).toBe(false);
    expect(isRecentReading(latest, QUARTER, END + 2 * QUARTER + 1)).toBe(false);
  });
});
