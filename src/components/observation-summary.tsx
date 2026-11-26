import { Time } from "@/components/latest-reading";
import { EmptyState, ErrorState } from "@/components/states";
import { formatNumber } from "@/lib/format";
import type { ObservationSummary } from "@/lib/history/observation-summary";
import type { PublicMeasurement } from "@/lib/rdp/public";

export function ObservationSummaryStats({
  measurement,
  summary,
}: {
  measurement: PublicMeasurement;
  summary: ObservationSummary;
}) {
  if (summary.status === "history_unavailable") {
    return <ErrorState title="Recent changes unavailable" className="px-3 py-2 sm:px-3" />;
  }
  if (summary.status !== "available") {
    const reason = {
      latest_unavailable: "A latest observation is needed.",
      not_recent: "A recent observation is needed.",
      insufficient: "There aren’t enough consecutive observations.",
    }[summary.status];
    return (
      <EmptyState title="Recent changes unavailable" className="px-3 py-2 sm:px-3">
        {reason}
      </EmptyState>
    );
  }

  const unit = measurement.unit;
  const differenceUnit = measurement.parameter === "level" ? "m" : unit;
  const signed = (value: number, unit: string) =>
    formatNumber(value, unit, { signDisplay: "exceptZero" });
  const { recent, day } = summary;
  const stats = [
    ...summary.changes.map(({ hours, change }) => [
      `${hours} h change`,
      change === null ? null : signed(change, differenceUnit),
    ]),
    ["24 h minimum", day && formatNumber(day.min, unit)],
    ["24 h maximum", day && formatNumber(day.max, unit)],
    [
      "Recent rate",
      recent && signed(recent.rate, measurement.parameter === "level" ? "m/h" : `${unit} per hour`),
    ],
  ];
  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="font-medium">{recent?.trend ?? "Trend unavailable"}</span>
        <span className="text-ink-muted"> · Based on observations</span>
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 min-[380px]:grid-cols-3">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-ink-muted">{label}</dt>
            <dd className="font-medium tabular-nums">{value ?? "Unavailable"}</dd>
          </div>
        ))}
      </dl>
      {recent ? (
        <p className="text-ink-muted">
          Rate over {formatNumber(recent.elapsedMinutes, "min")} from <Time value={recent.from} />{" "}
          to the latest reading.
        </p>
      ) : null}
      {day ? (
        <svg
          role="img"
          aria-label="Observed readings over the previous 24 hours"
          viewBox="0 0 160 36"
          className="h-9 w-full max-w-40 text-accent"
        >
          <polyline
            points={day.sparkline.map(([x, y]) => `${1 + x * 158},${2 + y * 32}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </div>
  );
}
