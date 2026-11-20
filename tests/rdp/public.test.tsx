import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { groupByStation } from "@/lib/discovery";
import { MeasurementList } from "@/components/measurement-list";
import type {
  PeriodTotalLatest,
  PeriodTotalHistoryPage,
  RainfallInterval,
} from "@/lib/rdp/contract";
import { toPublicHistory, toPublicLatest, type PublicMeasurement } from "@/lib/rdp/public";

const LATEST: PeriodTotalLatest = {
  kind: "period_total",
  measurementId: "ea-stone-rainfall",
  status: "available",
  periodSeconds: 900,
  label: "2026-11-19T11:00:00.0000000Z",
  labelConvention: "period_end",
  periodStart: "2026-11-19T10:45:00.0000000Z",
  periodEnd: "2026-11-19T11:00:00.0000000Z",
  totalMm: 0.4,
  unit: "mm",
  quality: '"Suspect"',
  eligible: false,
  labelAgeSeconds: 3600,
  freshness: "stale",
  errorCode: null,
};

describe("public projections of period totals", () => {
  it("never sends a depth for an ineligible interval", () => {
    expect(toPublicLatest(LATEST)).toMatchObject({ totalMm: null, eligible: false });
    expect(toPublicLatest({ ...LATEST, eligible: true })).toMatchObject({ totalMm: 0.4 });
    const interval = {
      label: LATEST.label!,
      periodSeconds: 900,
      labelConvention: "period_end",
      periodStart: LATEST.periodStart,
      periodEnd: LATEST.periodEnd,
      totalMm: 0.4,
      sourceValue: "0.4",
      quality: '"Suspect"',
      eligible: false,
      ineligibleReason: "QualitySuspect",
      knownAt: null,
      sourceId: "ea-flood-monitoring",
      providerMeasureId: "x",
      ingestedAt: LATEST.label!,
      sourceReference: "x",
      revision: 1,
    } satisfies RainfallInterval;
    const page = {
      kind: "period_total",
      measurementId: "ea-stone-rainfall",
      from: "2026-11-19T10:00:00.0000000Z",
      to: "2026-11-19T12:00:00.0000000Z",
      requestAsOf: LATEST.label!,
      cutoff: LATEST.label!,
      coverage: { status: "unknown", gaps: [] },
      nextCursor: null,
      periodSeconds: 900,
      knownAt: null,
      window: null,
      windowUnavailable: null,
      intervals: [interval],
    } satisfies PeriodTotalHistoryPage;
    const projected = toPublicHistory(page);
    expect(projected.kind === "period_total" && projected.intervals[0]).toMatchObject({
      totalMm: null,
      ineligibleReason: "QualitySuspect",
    });
  });
});

describe("rendering an ineligible interval", () => {
  it("states the depth is not reported instead of showing a number", () => {
    const measurement: PublicMeasurement = {
      measurementId: "ea-stone-rainfall",
      stationId: "ea-stone-raingauge",
      name: "Stone",
      parameter: "rainfall",
      unit: "mm",
      datum: "none",
      kind: "period_total",
      expectedIntervalSeconds: 900,
      periodSeconds: 900,
      source: { label: "Environment Agency", attribution: "OGL" },
    };
    const items = [{ measurement, latest: toPublicLatest(LATEST) }];
    render(<MeasurementList groups={groupByStation(items)} />);
    const item = screen.getByRole("link", { name: /Rainfall/ }).closest("li")!;
    expect(item).toHaveTextContent("Depth not reported (quality check failed)");
    expect(item.textContent).not.toMatch(/\d\s*mm/);
  });
});
