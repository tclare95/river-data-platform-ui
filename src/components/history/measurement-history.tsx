import { Suspense, use } from "react";
import { CoverageNote, knownGaps, RangeNav } from "@/components/history/history-controls";
import { Announce } from "@/components/history/announce";
import { HistoryChart } from "@/components/history/history-chart";
import { ObservationTable } from "@/components/history/observation-table";
import { RainfallHistory } from "@/components/history/rainfall-history";
import { Time } from "@/components/latest-reading";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { loadHistory, type HistoryResult } from "@/lib/history/load";
import { HISTORY_RANGES, rangeWindow, type HistoryRange } from "@/lib/history/range";
import { buildSeries } from "@/lib/history/series";
import { measurementPath, parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";
import { getRdpClient } from "@/lib/rdp/server";

const STATUS_ID = "history-status";

function HistoryBody({
  measurement,
  range,
  result,
}: {
  measurement: PublicMeasurement;
  range: HistoryRange;
  result: HistoryResult;
}) {
  const span = HISTORY_RANGES[range].label;
  if (result.status === "unavailable") {
    return (
      <ErrorState
        title="History unavailable right now"
        action={
          <a href={`${measurementPath(measurement.measurementId)}?range=${range}`} className="link">
            Try again
          </a>
        }
      >
        Part of this period couldn’t be loaded, so no readings are shown.
      </ErrorState>
    );
  }
  if (result.status === "too_large") {
    return (
      <EmptyState title={`Too many readings to show for ${span}`}>
        <Announce targetId={STATUS_ID} text={`Too many readings to show for ${span}`} />
        Choose a shorter range.
      </EmptyState>
    );
  }
  if (result.status === "deferred") return null;
  if ("intervals" in result) {
    return (
      <div className="space-y-4">
        <Announce
          targetId={STATUS_ID}
          text={
            result.intervals.length
              ? `Showing ${span} of rainfall history`
              : `No readings in the last ${span}`
          }
        />
        <RainfallHistory key={range} history={result} span={span} />
        <div className="space-y-1">
          <CoverageNote coverage={result.coverage} />
          <p className="text-sm text-ink-muted">
            Retrieved <Time value={result.retrievedAt} />. Times are UK time.
          </p>
        </div>
      </div>
    );
  }

  const label = parameterLabel(measurement.parameter);
  if (result.observations.length === 0) {
    return (
      <div className="space-y-3">
        <Announce targetId={STATUS_ID} text={`No readings in the last ${span}`} />
        <EmptyState title={`No readings in the last ${span}`} />
        <CoverageNote coverage={result.coverage} />
        {knownGaps(result.coverage).length > 0 ? (
          <p className="text-sm text-ink-muted">Times are UK time.</p>
        ) : null}
      </div>
    );
  }

  const gaps = knownGaps(result.coverage);
  const { missing } = buildSeries(result.observations, measurement.expectedIntervalSeconds, gaps);
  return (
    <div className="space-y-4">
      <Announce targetId={STATUS_ID} text={`Showing ${span} of history`} />
      <HistoryChart
        readings={result.observations}
        from={result.from}
        to={result.to}
        expectedIntervalSeconds={measurement.expectedIntervalSeconds}
        knownGaps={gaps}
        unit={measurement.unit}
        parameterLabel={label}
      />
      <div className="space-y-1">
        {missing.length > 0 ? (
          <p className="text-sm text-ink-muted">
            Readings are missing in {missing.length} {missing.length === 1 ? "place" : "places"},
            shown as breaks in the line.
          </p>
        ) : null}
        <CoverageNote coverage={result.coverage} />
        <p className="text-sm text-ink-muted">
          Retrieved <Time value={result.retrievedAt} />. Times are UK time.
        </p>
      </div>
      <details className="group">
        <summary className="cursor-pointer py-2 font-medium text-accent">
          Readings table ({result.observations.length.toLocaleString("en-GB")})
        </summary>
        <div className="mt-3">
          <ObservationTable
            readings={result.observations}
            unit={measurement.unit}
            parameterLabel={label}
            expectedIntervalSeconds={measurement.expectedIntervalSeconds}
            knownGaps={gaps}
          />
        </div>
      </details>
    </div>
  );
}

function LoadedHistory({
  measurement,
  range,
  result,
}: {
  measurement: PublicMeasurement;
  range: HistoryRange;
  result: Promise<HistoryResult>;
}) {
  return <HistoryBody measurement={measurement} range={range} result={use(result)} />;
}

/** Never rejects: configuration and transport failures are the `unavailable` state. */
async function readHistory(measurement: PublicMeasurement, range: HistoryRange) {
  try {
    return await loadHistory(
      getRdpClient(),
      measurement.measurementId,
      measurement.kind,
      rangeWindow(range, Date.now()),
    );
  } catch {
    return { status: "unavailable" } as const;
  }
}

/**
 * Observed history for the selected range. Streams under its own boundary so the latest reading is never held
 * back by a multi-page history read.
 */
export function MeasurementHistory({
  measurement,
  range,
}: {
  measurement: PublicMeasurement;
  range: HistoryRange;
}) {
  const heading = (
    <h2 id="history" className="text-lg font-semibold tracking-tight">
      History
    </h2>
  );
  return (
    <section aria-labelledby="history">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {heading}
        <RangeNav
          range={range}
          hrefFor={(key) => `${measurementPath(measurement.measurementId)}?range=${key}`}
        />
      </div>
      <p id={STATUS_ID} role="status" className="sr-only" />
      <div className="mt-4">
        <Suspense
          key={range}
          fallback={
            <LoadingState label={`Loading ${HISTORY_RANGES[range].label} of history`} lines={6} />
          }
        >
          <LoadedHistory
            measurement={measurement}
            range={range}
            result={readHistory(measurement, range)}
          />
        </Suspense>
      </div>
    </section>
  );
}
