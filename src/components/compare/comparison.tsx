import Link from "next/link";
import { Suspense, use } from "react";
import { ComparisonTable } from "@/components/compare/comparison-table";
import { Announce } from "@/components/history/announce";
import { HistoryChart } from "@/components/history/history-chart";
import { CoverageNote, knownGaps, RangeNav } from "@/components/history/measurement-history";
import { Time } from "@/components/latest-reading";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { alignReadings, compareHref, SCALE_NOTE, scaleBasis } from "@/lib/compare";
import { loadComparisonPair } from "@/lib/compare-load";
import type { HistoryResult } from "@/lib/history/load";
import { HISTORY_RANGES, type HistoryRange } from "@/lib/history/range";
import { buildSeries } from "@/lib/history/series";
import { datumSummary, measurementPath, parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";

const STATUS_ID = "compare-status";
const SYNC_ID = "compare";
/** Fixed so both charts' plot areas, and therefore their time axes, line up exactly. */
const Y_AXIS_WIDTH = 56;

type Side = { measurement: PublicMeasurement; result: HistoryResult };

function title(measurement: PublicMeasurement) {
  return `${measurement.name} ${parameterLabel(measurement.parameter).toLowerCase()}`;
}

function valueRange(results: readonly HistoryResult[]): [number, number] | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const result of results) {
    if (result.status !== "ok" || !("observations" in result)) continue;
    for (const { value } of result.observations) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return min <= max ? [min, max] : undefined;
}

function SeriesPanel({
  side,
  index,
  range,
  shared,
}: {
  side: Side;
  index: number;
  range: HistoryRange;
  shared: [number, number] | undefined;
}) {
  const { measurement, result } = side;
  const span = HISTORY_RANGES[range].label;
  const label = parameterLabel(measurement.parameter);
  const headingId = `series-${index}`;
  const facts = [measurement.unit, datumSummary(measurement), measurement.source.label]
    .filter(Boolean)
    .join(" · ");

  let body;
  if (result.status === "unavailable") {
    body = (
      <ErrorState title="History unavailable right now">
        Part of this period couldn’t be loaded, so no readings are shown.
      </ErrorState>
    );
  } else if (result.status === "too_large") {
    body = (
      <EmptyState title={`Too many readings to show for ${span}`}>
        Choose a shorter range.
      </EmptyState>
    );
  } else if (result.status === "deferred" || "intervals" in result) {
    body = <EmptyState title="This history isn’t charted yet" />;
  } else if (result.observations.length === 0) {
    body = (
      <div className="space-y-3">
        <EmptyState title={`No readings in the last ${span}`} />
        <CoverageNote coverage={result.coverage} />
      </div>
    );
  } else {
    const gaps = knownGaps(result.coverage);
    const { missing } = buildSeries(result.observations, measurement.expectedIntervalSeconds, gaps);
    body = (
      <div className="space-y-3">
        <HistoryChart
          readings={result.observations}
          from={result.from}
          to={result.to}
          expectedIntervalSeconds={measurement.expectedIntervalSeconds}
          knownGaps={gaps}
          unit={measurement.unit}
          parameterLabel={`${measurement.name} ${label.toLowerCase()}`}
          syncId={SYNC_ID}
          valueRange={shared}
          yAxisWidth={Y_AXIS_WIDTH}
          caption={false}
          tableHint="Both series are in the Compared readings table below."
        />
        <div className="space-y-1">
          {missing.length > 0 ? (
            <p className="text-sm text-ink-muted">
              Readings are missing in {missing.length} {missing.length === 1 ? "place" : "places"},
              shown as breaks in the line.
            </p>
          ) : null}
          <CoverageNote coverage={result.coverage} />
        </div>
      </div>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-line bg-surface px-4 py-4 sm:px-6 sm:py-5"
    >
      <h3 id={headingId} className="font-semibold tracking-tight">
        <Link href={measurementPath(measurement.measurementId)} className="link">
          {title(measurement)}
        </Link>
      </h3>
      <p className="mt-0.5 mb-3 text-sm text-ink-muted">{facts}</p>
      {body}
    </section>
  );
}

function ComparisonBody({ sides, range }: { sides: [Side, Side]; range: HistoryRange }) {
  const [a, b] = sides;
  const basis = scaleBasis(a.measurement, b.measurement);
  const shared = basis.shared ? valueRange([a.result, b.result]) : undefined;
  const span = HISTORY_RANGES[range].label;
  const withReadings = sides.filter(
    (side) =>
      side.result.status === "ok" &&
      "observations" in side.result &&
      side.result.observations.length > 0,
  );
  const retrieved = sides
    .map((side) =>
      side.result.status === "ok" && "observations" in side.result ? side.result.retrievedAt : null,
    )
    .filter((value): value is string => value !== null)
    .sort()[0];
  const observations = (side: Side) =>
    side.result.status === "ok" && "observations" in side.result ? side.result.observations : [];
  const rows = alignReadings(observations(a), observations(b));

  return (
    <div className="space-y-4">
      <Announce targetId={STATUS_ID} text={`Showing ${span} for both measurements`} />
      <p className="text-sm text-ink-muted">
        {basis.shared ? "Same unit, so both charts share one scale." : SCALE_NOTE[basis.reason]}
      </p>
      <SeriesPanel side={a} index={0} range={range} shared={shared} />
      <SeriesPanel side={b} index={1} range={range} shared={shared} />
      {retrieved ? (
        <p className="text-sm text-ink-muted">
          Retrieved <Time value={retrieved} />. Times are UK time.
        </p>
      ) : null}
      {withReadings.length > 0 ? (
        <details>
          <summary className="cursor-pointer py-2 font-medium text-accent">
            Compared readings table ({rows.length.toLocaleString("en-GB")} times)
          </summary>
          <div className="mt-3">
            <ComparisonTable
              rows={rows}
              a={{ label: title(a.measurement), unit: a.measurement.unit }}
              b={{ label: title(b.measurement), unit: b.measurement.unit }}
            />
          </div>
        </details>
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

/**
 * Two measurements over one shared window, each in its own chart with its own unit and datum. The charts share the
 * time axis (same window, same plot width, synced cursor); values share a scale only when they are directly
 * comparable.
 */
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
