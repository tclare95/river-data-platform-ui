import { Suspense, use } from "react";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { Announce } from "@/components/history/announce";
import { ComparisonChart } from "@/components/compare/comparison-chart";
import { CoverageNote, RangeNav } from "@/components/history/measurement-history";
import { Time } from "@/components/latest-reading";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { alignReadings, compareHref, comparisonReadings, type ComparisonSide } from "@/lib/compare";
import { loadComparisonPair } from "@/lib/compare-load";
import type { HistoryResult } from "@/lib/history/load";
import { HISTORY_RANGES, type HistoryRange } from "@/lib/history/range";
import { missingLabels, rainfallBounds } from "@/lib/history/rainfall";
import { parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";

const STATUS_ID = "compare-status";

function title(measurement: PublicMeasurement) {
  return `${measurement.name} ${parameterLabel(measurement.parameter).toLowerCase()}`;
}

function SeriesStatus({ side, span }: { side: ComparisonSide; span: string }) {
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
  if (comparisonReadings(result).length === 0) {
    return (
      <EmptyState title={`${label}: no readings in the last ${span}`}>
        <CoverageNote coverage={result.coverage} />
      </EmptyState>
    );
  }
  if (!("intervals" in result)) return null;

  const missing = missingLabels(result).reduce((sum, gap) => sum + gap.count, 0);
  const ineligible = result.intervals.filter((row) => !row.eligible).length;
  const unverified = result.intervals.filter((row) => row.eligible && !rainfallBounds(row)).length;
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

function ComparisonBody({
  sides,
  range,
}: {
  sides: [ComparisonSide, ComparisonSide];
  range: HistoryRange;
}) {
  const [a, b] = sides;
  const span = HISTORY_RANGES[range].label;
  const rows = alignReadings(comparisonReadings(a.result), comparisonReadings(b.result));
  const columns = sides.map(({ measurement }) => ({
    label: title(measurement),
    unit: measurement.unit,
    rainfall: measurement.kind === "period_total",
  }));

  return (
    <div className="space-y-4">
      <Announce targetId={STATUS_ID} text={`Showing ${span} for both measurements`} />
      {rows.length > 0 ? <ComparisonChart sides={sides} rows={rows} /> : null}
      {sides.map((side) => (
        <SeriesStatus key={side.measurement.measurementId} side={side} span={span} />
      ))}
      {rows.length > 0 ? (
        <>
          <details>
            <summary className="cursor-pointer py-2 font-medium text-accent">
              Compared readings table ({rows.length.toLocaleString("en-GB")} times)
            </summary>
            <div className="mt-3">
              <ComparisonTable rows={rows} a={columns[0]} b={columns[1]} />
            </div>
          </details>
          <details>
            <summary className="cursor-pointer py-2 text-sm font-medium text-accent">
              Coverage
            </summary>
            <div className="space-y-3">
              {sides.map(({ measurement, result }) =>
                result.status === "ok" && comparisonReadings(result).length > 0 ? (
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

function LoadedComparison({
  measurements,
  range,
  results,
}: {
  measurements: [PublicMeasurement, PublicMeasurement];
  range: HistoryRange;
  results: Promise<[HistoryResult, HistoryResult]>;
}) {
  const [ra, rb] = use(results);
  return (
    <ComparisonBody
      range={range}
      sides={[
        { measurement: measurements[0], result: ra },
        { measurement: measurements[1], result: rb },
      ]}
    />
  );
}

export function Comparison({
  a,
  b,
  range,
}: {
  a: PublicMeasurement;
  b: PublicMeasurement;
  range: HistoryRange;
}) {
  const results = loadComparisonPair(a, b, range);
  return (
    <section aria-labelledby="comparison" className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="comparison" className="text-lg font-semibold tracking-tight">
          History
        </h2>
        <RangeNav
          range={range}
          hrefFor={(key) => compareHref({ a: a.measurementId, b: b.measurementId, range: key })}
        />
      </div>
      <p id={STATUS_ID} role="status" className="sr-only" />
      <div className="mt-4">
        <Suspense
          key={`${a.measurementId}|${b.measurementId}|${range}`}
          fallback={
            <LoadingState
              label={`Loading ${HISTORY_RANGES[range].label} for both measurements`}
              lines={8}
            />
          }
        >
          <LoadedComparison measurements={[a, b]} range={range} results={results} />
        </Suspense>
      </div>
    </section>
  );
}
