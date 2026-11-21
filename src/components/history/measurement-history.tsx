import Link from "next/link";
import { Suspense, use } from "react";
import { Announce } from "@/components/history/announce";
import { HistoryChart } from "@/components/history/history-chart";
import { ObservationTable } from "@/components/history/observation-table";
import { Time } from "@/components/latest-reading";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { cx } from "@/lib/cx";
import { loadHistory, type HistoryResult } from "@/lib/history/load";
import { HISTORY_RANGES, rangeWindow, type HistoryRange } from "@/lib/history/range";
import { buildSeries } from "@/lib/history/series";
import { measurementPath, parameterLabel } from "@/lib/labels";
import type { Coverage, CoverageGap } from "@/lib/rdp/contract";
import type { PublicMeasurement } from "@/lib/rdp/public";
import { getRdpClient } from "@/lib/rdp/server";

const STATUS_ID = "history-status";

export type KnownGap = CoverageGap & { reason: Exclude<CoverageGap["reason"], "unknown"> };

const GAP_REASON: Record<KnownGap["reason"], string> = {
  not_collected: "Not collected",
  source_outage: "Source outage",
  legacy_unrecoverable: "Not recoverable from earlier records",
};

export function knownGaps(coverage: Coverage): KnownGap[] {
  return coverage.gaps.filter((gap): gap is KnownGap => gap.reason !== "unknown");
}

/** Range links; each keeps the rest of the view (`hrefFor`) so the page re-renders with only the range changed. */
export function RangeNav({
  range,
  hrefFor,
}: {
  range: HistoryRange;
  hrefFor: (range: HistoryRange) => string;
}) {
  return (
    <nav aria-label="History range">
      <ul className="flex gap-1 rounded-md border border-line-strong bg-surface p-1">
        {(Object.keys(HISTORY_RANGES) as HistoryRange[]).map((key) => (
          <li key={key}>
            <Link
              href={hrefFor(key)}
              scroll={false}
              aria-current={key === range ? "page" : undefined}
              className={cx(
                "inline-flex min-h-10 items-center rounded px-3 text-sm font-medium",
                key === range ? "bg-accent text-surface" : "text-accent hover:bg-canvas",
              )}
            >
              {HISTORY_RANGES[key].label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** RDP's coverage verdict in plain words. Unknown is never presented as complete. */
export function CoverageNote({ coverage }: { coverage: Coverage }) {
  const gaps = knownGaps(coverage);
  return (
    <div className="text-sm text-ink-muted">
      {coverage.status === "complete" ? (
        <p>Coverage verified complete for this period.</p>
      ) : coverage.status === "unknown" ? (
        <p>This record hasn’t been verified as complete.</p>
      ) : (
        <p>Part of this period has no data.</p>
      )}
      {gaps.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {gaps.map((gap) => (
            <li key={gap.from}>
              {GAP_REASON[gap.reason]}: <Time value={gap.from} /> to <Time value={gap.to} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

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
  if (result.status === "deferred" || "intervals" in result) return null;

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
 * back by a multi-page history read. Rainfall period totals are deferred to their own view.
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
  if (measurement.kind === "period_total") {
    return (
      <section aria-labelledby="history">
        {heading}
        <EmptyState title="Rainfall history isn’t charted yet" className="mt-3">
          Period totals need their own view, which is planned.
        </EmptyState>
      </section>
    );
  }
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
