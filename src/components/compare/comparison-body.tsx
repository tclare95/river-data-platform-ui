"use client";

import { useMemo, useState } from "react";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { ComparisonChart } from "@/components/compare/comparison-chart";
import { Announce } from "@/components/history/announce";
import { RainfallModeControl, RainfallTotalsNote } from "@/components/history/rainfall-totals";
import { CoverageNote } from "@/components/history/history-controls";
import { Time } from "@/components/latest-reading";
import { EmptyState, ErrorState } from "@/components/states";
import { alignReadings, comparisonReadings, type ComparisonSide } from "@/lib/compare";
import { HISTORY_RANGES, type HistoryRange } from "@/lib/history/range";
import { missingLabels, rainfallBounds, visibleRainfallIntervals } from "@/lib/history/rainfall";
import { rainfallTotals, type RainfallMode } from "@/lib/history/rainfall-totals";
import { parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";

function title(measurement: PublicMeasurement) {
  return `${measurement.name} ${parameterLabel(measurement.parameter).toLowerCase()}`;
}

function SeriesStatus({
  side,
  span,
  mode,
}: {
  side: ComparisonSide;
  span: string;
  mode: RainfallMode;
}) {
  const { measurement, result } = side;
  const label = title(measurement);
  if (result.status === "unavailable") {
    return <ErrorState title={`${label}: history unavailable right now`} />;
  }
  if (result.status === "too_large") {
    return (
      <EmptyState title={`${label}: too many readings for ${span}`}>
        Choose a shorter range.
      </EmptyState>
    );
  }
  if (result.status === "deferred") {
    return <EmptyState title={`${label}: history isn’t charted yet`} />;
  }
  if ("intervals" in result && mode !== "native") return null;
  if (comparisonReadings(result).length === 0) {
    return (
      <EmptyState title={`${label}: no readings in the last ${span}`}>
        <CoverageNote coverage={result.coverage} />
      </EmptyState>
    );
  }
  if (!("intervals" in result)) return null;

  const missing = missingLabels(result).reduce((sum, gap) => sum + gap.count, 0);
  const intervals = visibleRainfallIntervals(result);
  const ineligible = intervals.filter((row) => !row.eligible).length;
  const unverified = intervals.filter((row) => row.eligible && !rainfallBounds(row)).length;
  const notes = [
    missing && `${missing.toLocaleString("en-GB")} missing`,
    ineligible && `${ineligible.toLocaleString("en-GB")} ineligible (×)`,
    unverified && `${unverified.toLocaleString("en-GB")} with timing unverified (provider labels)`,
  ].filter(Boolean);
  return notes.length ? (
    <p className="text-sm text-ink-muted">
      {label} · {notes.join(" · ")}
    </p>
  ) : null;
}

export function ComparisonBody({
  sides,
  range,
  statusId,
}: {
  sides: ComparisonSide[];
  range: HistoryRange;
  statusId: string;
}) {
  const span = HISTORY_RANGES[range].label;
  const hasRainfall = sides.some(({ result }) => result.status === "ok" && "intervals" in result);
  const [mode, setMode] = useState<RainfallMode>("24h");
  const series = useMemo(
    () =>
      sides.map(({ result }) =>
        mode !== "native" && result.status === "ok" && "intervals" in result
          ? rainfallTotals(result, mode)
          : comparisonReadings(result),
      ),
    [sides, mode],
  );
  const rows = useMemo(() => alignReadings(series), [series]);
  const totals = series.flatMap((readings) => readings.filter((reading) => "expected" in reading));
  const columns = sides.map(({ measurement }) => ({
    id: measurement.measurementId,
    label: title(measurement),
    unit: measurement.unit,
    rainfall: measurement.kind === "period_total",
  }));

  return (
    <div className="space-y-4">
      <Announce targetId={statusId} text={`Showing ${span} for ${sides.length} measurements`} />
      {hasRainfall ? <RainfallModeControl mode={mode} onChange={setMode} /> : null}
      {rows.length > 0 ? (
        <ComparisonChart sides={sides} rows={rows} readings={series} mode={mode} />
      ) : null}
      <RainfallTotalsNote mode={mode} totals={totals} />
      {sides.map((side) => (
        <SeriesStatus key={side.measurement.measurementId} side={side} span={span} mode={mode} />
      ))}
      {rows.length > 0 ? (
        <>
          <details>
            <summary className="cursor-pointer py-2 font-medium text-accent">
              Compared readings table ({rows.length.toLocaleString("en-GB")} times)
            </summary>
            <div className="mt-3">
              <ComparisonTable key={mode} rows={rows} columns={columns} />
            </div>
          </details>
          <details>
            <summary className="cursor-pointer py-2 text-sm font-medium text-accent">
              Coverage
            </summary>
            <div className="space-y-3">
              {sides.map(({ measurement, result }, index) =>
                result.status === "ok" && series[index].length > 0 ? (
                  <div key={measurement.measurementId}>
                    <p className="text-sm font-medium">{title(measurement)}</p>
                    <CoverageNote coverage={result.coverage} />
                    <p className="text-sm text-ink-muted">
                      Retrieved <Time value={result.retrievedAt} />
                    </p>
                  </div>
                ) : null,
              )}
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}
