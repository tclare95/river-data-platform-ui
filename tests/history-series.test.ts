import { describe, expect, it } from "vitest";
import { BREAK_FACTOR, buildSeries, type SeriesReading } from "@/lib/history/series";

const T0 = Date.parse("2026-11-19T00:00:00Z");
const MINUTE = 60_000;
const QUARTER = 15 * MINUTE;
const at = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".0000000Z");
const reading = (offsetMs: number, value: number): SeriesReading => ({
  observedAt: at(T0 + offsetMs),
  value,
});
const values = (points: { value: number | null }[]) => points.map((point) => point.value);

describe("buildSeries", () => {
  it("joins regular readings at their own times without adding points", () => {
    const series = buildSeries(
      [reading(0, 1), reading(QUARTER, 2), reading(2 * QUARTER, 3), reading(3 * QUARTER, 4)],
      900,
    );
    expect(series.points).toEqual([
      { t: T0, value: 1, isolated: false },
      { t: T0 + QUARTER, value: 2, isolated: false },
      { t: T0 + 2 * QUARTER, value: 3, isolated: false },
      { t: T0 + 3 * QUARTER, value: 4, isolated: false },
    ]);
    expect(series.missing).toEqual([]);
  });

  it("breaks the line over one missed 15-minute sample", () => {
    const readings = [reading(0, 1), reading(QUARTER, 2), reading(3 * QUARTER, 3)];
    const series = buildSeries(readings, 900);
    expect(values(series.points)).toEqual([1, 2, null, 3]);
    expect(series.points[2].t).toBe(T0 + 2 * QUARTER);
    expect(series.missing).toEqual([
      { after: readings[1].observedAt, before: readings[2].observedAt },
    ]);
  });

  it("joins at exactly the break threshold and breaks just beyond it", () => {
    const threshold = BREAK_FACTOR * QUARTER;
    expect(values(buildSeries([reading(0, 1), reading(threshold, 2)], 900).points)).toEqual([1, 2]);
    expect(values(buildSeries([reading(0, 1), reading(threshold + 1000, 2)], 900).points)).toEqual([
      1,
      null,
      2,
    ]);
  });

  it("keeps irregular corrected timestamps within tolerance joined", () => {
    const series = buildSeries(
      [
        reading(0, 1),
        reading(QUARTER + 40_000, 2),
        reading(31 * MINUTE, 3),
        reading(44 * MINUTE, 4),
        reading(66 * MINUTE, 5),
      ],
      900,
    );
    expect(values(series.points)).toEqual([1, 2, 3, 4, 5]);
    expect(series.missing).toEqual([]);
  });

  it("breaks across a known coverage gap even when readings are close", () => {
    const readings = [reading(0, 1), reading(QUARTER, 2), reading(2 * QUARTER, 3)];
    const series = buildSeries(readings, 900, [
      { from: at(T0 + QUARTER + MINUTE), to: at(T0 + QUARTER + 2 * MINUTE) },
    ]);
    expect(values(series.points)).toEqual([1, 2, null, 3]);
    expect(series.missing).toEqual([
      { after: readings[1].observedAt, before: readings[2].observedAt },
    ]);
  });

  it("does not break for a gap that only touches a reading or lies outside the readings", () => {
    const readings = [reading(QUARTER, 1), reading(2 * QUARTER, 2)];
    const series = buildSeries(readings, 900, [
      { from: at(T0), to: at(T0 + QUARTER) },
      { from: at(T0 + 2 * QUARTER), to: at(T0 + 3 * QUARTER) },
    ]);
    expect(values(series.points)).toEqual([1, 2]);
  });

  it("flags readings with no joined neighbour as isolated", () => {
    const series = buildSeries(
      [reading(0, 1), reading(60 * MINUTE, 2), reading(75 * MINUTE, 3), reading(180 * MINUTE, 4)],
      900,
    );
    const real = series.points.filter((point) => point.value !== null);
    expect(real.map((point) => point.isolated)).toEqual([true, false, false, true]);
    expect(series.points.filter((point) => point.value === null)).toHaveLength(2);
    expect(series.points.every((point) => point.value !== null || !point.isolated)).toBe(true);
  });

  it("flags a single reading as isolated", () => {
    const series = buildSeries([reading(0, 7)], 900);
    expect(series.points).toEqual([{ t: T0, value: 7, isolated: true }]);
    expect(series).toMatchObject({ count: 1, min: 7, max: 7 });
  });

  it("preserves negative and zero values and their order", () => {
    const readings = [reading(0, -0.25), reading(QUARTER, 0), reading(2 * QUARTER, -1.5)];
    const series = buildSeries(readings, 900);
    expect(values(series.points)).toEqual([-0.25, 0, -1.5]);
    expect(series).toMatchObject({ min: -1.5, max: 0 });
  });

  it("reports count, min, max, first and last over readings only", () => {
    const readings = [
      reading(0, 3),
      reading(QUARTER, 9),
      reading(4 * QUARTER, 1),
      reading(5 * QUARTER, 4),
    ];
    const series = buildSeries(readings, 900);
    expect(series).toMatchObject({
      count: 4,
      min: 1,
      max: 9,
      first: readings[0].observedAt,
      last: readings[3].observedAt,
    });
    expect(series.points).toHaveLength(5);
  });

  it("returns an empty series for no readings", () => {
    expect(buildSeries([], 900)).toEqual({
      points: [],
      missing: [],
      count: 0,
      min: null,
      max: null,
      first: null,
      last: null,
    });
  });

  it("parses 100-nanosecond tick timestamps to milliseconds", () => {
    const series = buildSeries(
      [
        { observedAt: "2026-11-19T12:00:00.1234567Z", value: 1 },
        { observedAt: "2026-11-19T12:15:00.9999999Z", value: 2 },
      ],
      900,
    );
    expect(series.points.map((point) => point.t)).toEqual([
      Date.parse("2026-11-19T12:00:00.123Z"),
      Date.parse("2026-11-19T12:15:00.999Z"),
    ]);
    expect(series.points.every((point) => Number.isFinite(point.t))).toBe(true);
    expect(series.missing).toEqual([]);
  });

  it("scales the break threshold with the expected interval", () => {
    const hourly = [reading(0, 1), reading(60 * MINUTE, 2), reading(150 * MINUTE, 3)];
    expect(values(buildSeries(hourly, 3600).points)).toEqual([1, 2, 3]);
    expect(values(buildSeries(hourly, 900).points)).toEqual([1, null, 2, null, 3]);
  });
});
