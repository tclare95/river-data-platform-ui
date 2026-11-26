"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/button";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { ComparisonChart } from "@/components/compare/comparison-chart";
import { Announce } from "@/components/history/announce";
import { RainfallModeControl, RainfallTotalsNote } from "@/components/history/rainfall-totals";
import { CoverageNote } from "@/components/history/history-controls";
import { Time } from "@/components/latest-reading";
import { EmptyState, ErrorState } from "@/components/states";
import {
  alignReadings,
  comparisonReadings,
  comparisonWindowResult,
  type ComparisonSide,
} from "@/lib/compare";
import { comparisonOffsetLabel, MAX_COMPARISON_OFFSET } from "@/lib/compare-time";
import { HISTORY_RANGES, type HistoryRange, type HistoryWindow } from "@/lib/history/range";
import { missingLabels, rainfallBounds, visibleRainfallIntervals } from "@/lib/history/rainfall";
import { rainfallTotals, type RainfallMode } from "@/lib/history/rainfall-totals";
import { parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";

function title(measurement: PublicMeasurement) {
  return `${measurement.name} ${parameterLabel(measurement.parameter).toLowerCase()}`;
}

function OffsetControl({
  label,
  offset,
  onChange,
}: {
  label: string;
  offset: number;
  onChange: (offset: number) => void;
}) {
  const [draft, setDraft] = useState(String(offset));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const minutes = Number(draft);
        if (draft && Number.isInteger(minutes) && Math.abs(minutes) <= MAX_COMPARISON_OFFSET) {
          onChange(minutes);
        }
      }}
    >
      <fieldset className="flex flex-wrap items-end gap-2">
        <legend className="mb-1 text-sm font-medium">
          {label}
          {offset !== 0 ? ` (${comparisonOffsetLabel(offset)})` : ""}
        </legend>
        <label className="grid gap-1 text-sm">
          Offset (minutes)
          <input
            type="number"
            required
            min={-MAX_COMPARISON_OFFSET}
            max={MAX_COMPARISON_OFFSET}
            step={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-10 w-28 rounded border border-line-strong bg-surface px-2"
          />
        </label>
        <Button type="submit">Apply</Button>
        <Button
          type="button"
          onClick={() => {
            setDraft("0");
            onChange(0);
          }}
        >
          Reset
        </Button>
      </fieldset>
    </form>
  );
}

function SeriesStatus({
  side,
  span,
  mode,
  shifted,
}: {
  side: ComparisonSide;
  span: string;
  mode: RainfallMode;
  shifted: boolean;
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
      <EmptyState
        title={`${label}: no readings ${shifted ? "in the displayed window" : `in the last ${span}`}`}
      >
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
  sides: sourceSides,
  window,
  range,
  statusId,
}: {
  sides: ComparisonSide[];
  window: HistoryWindow;
  range: HistoryRange;
  statusId: string;
}) {
  const span = HISTORY_RANGES[range].label;
  const [offsetById, setOffsetById] = useState<Record<string, number>>({});
  const offsets = useMemo(
    () => sourceSides.map(({ measurement }) => offsetById[measurement.measurementId] ?? 0),
    [sourceSides, offsetById],
  );
  const sides = useMemo(
    () =>
      sourceSides.map((side, index) => ({
        ...side,
        result: comparisonWindowResult(side.result, window, offsets[index]),
      })),
    [sourceSides, window, offsets],
  );
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
  const rows = useMemo(() => alignReadings(series, offsets), [series, offsets]);
  const timelineKey = offsets.join(",");
  const totals = series.flatMap((readings) => readings.filter((reading) => "expected" in reading));
  const columns = sides.map(({ measurement }, index) => ({
    id: measurement.measurementId,
    label: title(measurement),
    unit: measurement.unit,
    rainfall: measurement.kind === "period_total",
    offset: offsets[index],
  }));

  return (
    <div className="space-y-4">
      <Announce targetId={statusId} text={`Showing ${span} for ${sides.length} measurements`} />
      {hasRainfall ? <RainfallModeControl mode={mode} onChange={setMode} /> : null}
      {sides.some(({ result }) => result.status === "ok") ? (
        <details>
          <summary className="cursor-pointer py-2 text-sm font-medium text-accent">
            Time shifts
          </summary>
          <p className="mb-3 text-sm text-ink-muted">
            Positive offsets move readings later and negative offsets move them earlier. Limit 24
            hours in either direction.
          </p>
          <div className="flex flex-wrap gap-4">
            {sides.map(({ measurement, result }, index) =>
              result.status === "ok" ? (
                <OffsetControl
                  key={measurement.measurementId}
                  label={title(measurement)}
                  offset={offsets[index]}
                  onChange={(offset) =>
                    setOffsetById((current) => ({
                      ...current,
                      [measurement.measurementId]: offset,
                    }))
                  }
                />
              ) : null,
            )}
          </div>
        </details>
      ) : null}
      {rows.length > 0 ? (
        <ComparisonChart
          key={timelineKey}
          sides={sides}
          rows={rows}
          readings={series}
          mode={mode}
          offsets={offsets}
          window={window}
        />
      ) : null}
      <RainfallTotalsNote mode={mode} totals={totals} />
      {sides.map((side, index) => (
        <SeriesStatus
          key={side.measurement.measurementId}
          side={side}
          span={span}
          mode={mode}
          shifted={offsets[index] !== 0}
        />
      ))}
      {rows.length > 0 ? (
        <>
          <details>
            <summary className="cursor-pointer py-2 font-medium text-accent">
              Compared readings table ({rows.length.toLocaleString("en-GB")} times)
            </summary>
            <div className="mt-3">
              <ComparisonTable key={`${mode}:${timelineKey}`} rows={rows} columns={columns} />
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
                    {offsets[index] !== 0 ? (
                      <p className="text-sm text-ink-muted">Source coverage times</p>
                    ) : null}
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
