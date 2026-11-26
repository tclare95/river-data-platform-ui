import { describe, expect, it } from "vitest";
import type { RainfallInterval, RainfallResult } from "@/lib/history/rainfall";
import {
  rainfallReadWindow,
  rainfallSummaries,
  rainfallTotals,
} from "@/lib/history/rainfall-totals";

const HOUR = 3_600_000;
const STEP = HOUR / 4;
const start = Date.parse("2026-10-25T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function interval(
  from: number,
  totalMm: number | null = 0.2,
  convention: RainfallInterval["labelConvention"] = "period_end",
): RainfallInterval {
  return {
    label: iso(convention === "period_end" ? from + STEP : from),
    labelConvention: convention,
    periodStart: convention === "unverified" ? null : iso(from),
    periodEnd: convention === "unverified" ? null : iso(from + STEP),
    totalMm,
    eligible: totalMm !== null,
    quality: null,
    ineligibleReason: totalMm === null ? "QualitySuspect" : null,
    revision: 1,
  };
}

function history(intervals: RainfallInterval[], from = start, to = start + HOUR): RainfallResult {
  return {
    status: "ok",
    from: iso(from),
    to: iso(to),
    intervals,
    periodSeconds: 900,
    retrievedAt: iso(to),
    pages: 2,
    coverage: { status: "unknown", gaps: [] },
    window: null,
    windowUnavailable: "paginated",
  };
}

describe("rainfall accumulations", () => {
  it.each(["period_start", "period_end"] as const)(
    "uses exactly the physical hour for %s",
    (convention) => {
      const intervals = Array.from({ length: 6 }, (_, index) =>
        interval(start + (index - 1) * STEP, index === 0 || index === 5 ? 10 : 0.5, convention),
      );
      expect(rainfallTotals(history(intervals), "hourly")).toEqual([
        {
          from: iso(start),
          to: iso(start + HOUR),
          used: 4,
          expected: 4,
          totalMm: 2,
          status: "complete",
          basis: "verified",
        },
      ]);
    },
  );

  it("distinguishes gaps and ineligible depths from an explicit zero", () => {
    const rows = [
      interval(start, 0),
      interval(start + STEP, null),
      interval(start + 3 * STEP, 0.4),
    ];
    expect(rainfallTotals(history(rows), "hourly")[0]).toMatchObject({
      used: 2,
      expected: 4,
      status: "partial",
      totalMm: 0.4,
    });
    expect(rainfallTotals(history([]), "hourly")[0]).toMatchObject({
      used: 0,
      expected: 4,
      status: "unavailable",
      totalMm: null,
    });
    expect(
      rainfallTotals(
        history(Array.from({ length: 4 }, (_, i) => interval(start + i * STEP, 0))),
        "hourly",
      )[0],
    ).toMatchObject({
      used: 4,
      status: "complete",
      totalMm: 0,
    });
  });

  it("uses provider labels for indicative totals outside evidence and excludes the end label", () => {
    const rows = [
      interval(start - STEP, 1),
      interval(start + STEP, 2, "unverified"),
      interval(start + 3 * STEP, 4, "period_start"),
      interval(start + HOUR, 10, "unverified"),
    ];
    expect(rainfallTotals(history(rows), "hourly")[0]).toMatchObject({
      used: 3,
      expected: 4,
      status: "partial",
      basis: "indicative",
      totalMm: 7,
    });
    const unverified = Array.from({ length: 4 }, (_, i) =>
      interval(start + i * STEP, 1, "unverified"),
    );
    expect(rainfallTotals(history(unverified), "hourly")[0]).toMatchObject({
      status: "complete",
      basis: "indicative",
      totalMm: 4,
    });
  });

  it("does not extend a verified end-label convention beyond its last evidenced row", () => {
    const rows = [
      interval(start - STEP),
      interval(start),
      interval(start + STEP),
      interval(start + 2 * STEP),
      interval(start + HOUR, 1, "unverified"),
    ];
    expect(rainfallTotals(history(rows), "hourly")[0]).toMatchObject({
      used: 4,
      expected: 4,
      basis: "indicative",
      status: "complete",
    });
  });

  it("uses the newest revision once and excludes conflicting revisions and overlapping intervals", () => {
    const old = interval(start, 1);
    const newRow = {
      ...old,
      label: old.label.replace(".000Z", ".0000000Z"),
      totalMm: 2,
      revision: 2,
    };
    const ambiguous = interval(start + STEP, 3);
    const overlap = interval(start + 3 * STEP, 4);
    const rows = [
      newRow,
      old,
      newRow,
      ambiguous,
      { ...ambiguous, totalMm: 9 },
      overlap,
      interval(start + 3 * STEP, 8, "period_start"),
    ];
    expect(rainfallTotals(history(rows), "hourly")[0]).toMatchObject({
      used: 1,
      expected: 4,
      status: "partial",
      totalMm: 2,
    });
  });

  it("excludes off-grid labels and verified rows with invalid physical bounds", () => {
    const invalid = { ...interval(start + STEP), periodStart: iso(start) };
    const offGrid = {
      ...interval(start + 2 * STEP, 4, "unverified"),
      label: iso(start + 2 * STEP).replace(".000Z", ".0000001Z"),
    };
    expect(rainfallTotals(history([invalid, offGrid]), "hourly")[0]).toMatchObject({
      used: 0,
      status: "unavailable",
      basis: "verified",
    });
  });

  it.each(["2026-03-29", "2026-10-25"])(
    "buckets the UTC day across the UK clock change on %s",
    (day) => {
      const midnight = Date.parse(`${day}T00:00:00Z`);
      const end = midnight + 24 * HOUR;
      const rows = Array.from({ length: 97 }, (_, i) => interval(midnight + i * STEP, 1));
      expect(rainfallTotals(history(rows, midnight, end + HOUR / 4), "daily")).toMatchObject([
        {
          from: iso(midnight),
          to: iso(end),
          expected: 96,
          used: 96,
          totalMm: 96,
          status: "complete",
        },
        {
          from: iso(end),
          to: iso(end + STEP),
          expected: 96,
          used: 1,
          totalMm: 1,
          status: "partial",
        },
      ]);
    },
  );

  it("uses preceding observations from the first rolling point but starts cumulative at the visible edge", () => {
    const hours = 168;
    const before = start - hours * HOUR;
    const rows = Array.from({ length: (hours + 1) * 4 }, (_, i) =>
      interval(before + i * STEP, 0.25),
    );
    const data = history(rows);
    expect(rainfallReadWindow(data)).toEqual({ from: iso(before), to: iso(start + HOUR + 1) });
    for (const [mode, expected] of [
      ["6h", 6],
      ["12h", 12],
      ["24h", 24],
      ["48h", 48],
      ["72h", 72],
      ["7d", 168],
    ] as const) {
      expect(rainfallTotals(data, mode)[0]).toMatchObject({
        to: iso(start),
        totalMm: expected,
        status: "complete",
      });
    }
    expect(rainfallTotals(data, "cumulative")).toMatchObject([
      { from: iso(start), to: iso(start + HOUR), totalMm: 1, status: "complete" },
    ]);
    expect(rainfallSummaries(data).map(({ label, totalMm, to }) => [label, totalMm, to])).toEqual([
      ["Previous 24 hours", 24, iso(start + HOUR)],
      ["Previous 48 hours", 48, iso(start + HOUR)],
      ["Previous 72 hours", 72, iso(start + HOUR)],
      ["Previous 7 days", 168, iso(start + HOUR)],
    ]);
  });
});
