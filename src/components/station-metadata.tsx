import { stationPositionLabel, watercourseLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";

export function StationMetadata({ measurement }: { measurement: PublicMeasurement }) {
  const watercourse = watercourseLabel(measurement);
  return (
    <div className="text-sm text-ink-muted">
      {watercourse ? <p>{watercourse}</p> : null}
      <p>{measurement.source.label}</p>
      <p>{stationPositionLabel(measurement)}</p>
    </div>
  );
}
