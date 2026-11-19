import { formatNumber, formatPeriod, formatTime, sentenceCase } from "@/lib/format";
import type { OverviewItem } from "@/lib/overview";
import type { PublicLatest } from "@/lib/rdp/public";

function Time({ value }: { value: string }) {
  return <time dateTime={value}>{formatTime(value)}</time>;
}

/** RDP's freshness verdict, shown only when it qualifies an available reading. */
function FreshnessNote({ freshness }: { freshness: PublicLatest["freshness"] }) {
  if (freshness === "fresh") return null;
  return (
    <span className="text-ink-muted">
      {freshness === "stale" ? " · Not recent" : " · Freshness unknown"}
    </span>
  );
}

function LatestSummary({ item }: { item: OverviewItem }) {
  const { latest, measurement } = item;
  if (!latest || latest.status === "unavailable")
    return <p className="text-ink-muted">Latest reading unavailable</p>;
  if (latest.status === "no_observations")
    return <p className="text-ink-muted">No observations collected</p>;

  if (latest.kind === "period_total") {
    // A period total, never an instantaneous reading: always say what period it covers.
    const period = formatPeriod(measurement.periodSeconds ?? 0);
    const ending = latest.labelConvention !== "unverified" && latest.periodEnd;
    return (
      <p>
        <span className="font-medium">{formatNumber(latest.totalMm ?? 0, measurement.unit)}</span>
        {ending ? (
          <>
            {" "}
            in the {period} to <Time value={latest.periodEnd!} />
          </>
        ) : (
          <>
            {" "}
            {period} total labelled <Time value={latest.label!} />
          </>
        )}
        {latest.eligible === false ? (
          <span className="text-ink-muted"> · Fails quality checks</span>
        ) : null}
        <FreshnessNote freshness={latest.freshness} />
      </p>
    );
  }

  return (
    <p>
      <span className="font-medium">{formatNumber(latest.value ?? 0, measurement.unit)}</span> at{" "}
      <Time value={latest.observedAt!} />
      <FreshnessNote freshness={latest.freshness} />
    </p>
  );
}

export function MeasurementList({ items }: { items: OverviewItem[] }) {
  const attributions = [...new Set(items.map((item) => item.measurement.source.attribution))];
  return (
    <>
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {items.map((item) => (
          <li key={item.measurement.measurementId} className="px-5 py-4 sm:px-6">
            <h2 className="font-medium">
              {item.measurement.name}{" "}
              <span className="font-normal text-ink-muted">
                {sentenceCase(item.measurement.parameter)}
              </span>
            </h2>
            <div className="mt-1 text-sm">
              <LatestSummary item={item} />
            </div>
          </li>
        ))}
      </ul>
      {attributions.length > 0 ? (
        <p className="mt-4 text-xs text-ink-muted">{attributions.join(" ")}</p>
      ) : null}
    </>
  );
}
