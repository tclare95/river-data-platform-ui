import { cx } from "@/lib/cx";
import type { PublicMeasurement } from "@/lib/rdp/public";

/** Shown whenever the adapter serves fixture data, so sample values are never mistaken for observations. */
export function FixtureNote({ className }: { className?: string }) {
  return (
    <p role="note" className={cx("text-sm text-ink-muted", className)}>
      Sample data for development. These are not real observations.
    </p>
  );
}

/** Licence attribution for every provider whose data is on the page. */
export function Attribution({
  measurements,
  className,
}: {
  measurements: readonly PublicMeasurement[];
  className?: string;
}) {
  const lines = [...new Set(measurements.map((measure) => measure.source.attribution))];
  if (lines.length === 0) return null;
  return <p className={cx("mt-8 text-xs text-ink-muted", className)}>{lines.join(" ")}</p>;
}
