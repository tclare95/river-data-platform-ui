import type { ReactNode } from "react";
import { formatNumber, formatPeriod, formatTime } from "@/lib/format";
import type { PublicLatest, PublicMeasurement } from "@/lib/rdp/public";

export function Time({ value }: { value: string }) {
  return <time dateTime={value}>{formatTime(value)}</time>;
}

export type LatestView =
  | { state: "unavailable" }
  | { state: "no_observations" }
  | {
      state: "available";
      /** `null` when the interval has no reportable depth (ineligible quality). */
      value: string | null;
      /** When the value applies, phrased for its kind: an instant ("at …") or a period ("in the … to …"). */
      when: ReactNode;
      /** Sentence lead for `when` on its own line: "Observed " or "Total ". */
      lead: string;
      freshness: PublicLatest["freshness"];
      quality: string | null;
    };

/**
 * One reading of RDP's latest state. Availability and freshness are RDP's verdicts, used unchanged; a missing or
 * failed latest read is unavailable, never zero.
 */
export function describeLatest(
  measurement: PublicMeasurement,
  latest: PublicLatest | null,
): LatestView {
  if (!latest || latest.status === "unavailable") return { state: "unavailable" };
  if (latest.status === "no_observations") return { state: "no_observations" };

  if (latest.kind === "period_total") {
    // A period total, never an instantaneous reading: always say what period it covers.
    const period = formatPeriod(measurement.periodSeconds ?? 0);
    const periodEnd = latest.labelConvention !== "unverified" ? latest.periodEnd : null;
    const when =
      periodEnd !== null ? (
        <>
          in the {period} to <Time value={periodEnd} />
        </>
      ) : latest.label ? (
        <>
          in the {period} labelled <Time value={latest.label} />
        </>
      ) : (
        <>in a {period} period</>
      );
    const reportable = latest.eligible !== false && latest.totalMm !== null;
    return {
      state: "available",
      value: reportable ? formatNumber(latest.totalMm!, measurement.unit) : null,
      when,
      lead: "Total ",
      freshness: latest.freshness,
      quality: latest.quality,
    };
  }

  if (latest.value === null || latest.observedAt === null) return { state: "unavailable" };
  return {
    state: "available",
    value: formatNumber(latest.value, measurement.unit),
    when: (
      <>
        at <Time value={latest.observedAt} />
      </>
    ),
    lead: "Observed ",
    freshness: latest.freshness,
    quality: latest.quality,
  };
}

export const FRESHNESS_LABEL = {
  fresh: "Recent",
  stale: "Not recent",
  unknown: "Freshness unknown",
} as const;

export const NO_DEPTH = "Depth not reported (quality check failed)";

/** One-line summary for listings. Freshness is mentioned only when it qualifies the reading. */
export function LatestLine({
  measurement,
  latest,
}: {
  measurement: PublicMeasurement;
  latest: PublicLatest | null;
}) {
  const view = describeLatest(measurement, latest);
  if (view.state === "unavailable")
    return <span className="text-ink-muted">Latest reading unavailable</span>;
  if (view.state === "no_observations")
    return <span className="text-ink-muted">No observations collected</span>;
  return (
    <span>
      {view.value ? (
        <span className="font-medium text-ink tabular-nums">{view.value}</span>
      ) : (
        <span className="text-ink-muted">{NO_DEPTH}</span>
      )}{" "}
      <span className="text-ink-muted">{view.when}</span>
      {view.freshness !== "fresh" ? (
        <span className="whitespace-nowrap">
          <span className="text-ink-muted"> · </span>
          <span className="font-medium text-ink">{FRESHNESS_LABEL[view.freshness]}</span>
        </span>
      ) : null}
    </span>
  );
}
