import Link from "next/link";
import type { ReactNode } from "react";
import { LatestLine } from "@/components/latest-reading";
import { StationMetadata } from "@/components/station-metadata";
import type { StationGroup } from "@/lib/discovery";
import { measurementPath, measurementSummary, parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";

/** Stations with their published measurements; each measurement row links to its detail page. */
export function MeasurementList({
  groups,
  comparisonAction,
}: {
  groups: readonly StationGroup[];
  comparisonAction?: (measurement: PublicMeasurement) => ReactNode;
}) {
  return (
    <ul className="space-y-4">
      {groups.map((group) => (
        <li
          key={group.stationId}
          className="overflow-hidden rounded-lg border border-line bg-surface"
        >
          <div className="px-5 pt-4 pb-3 sm:px-6">
            <h3 className="text-lg font-semibold tracking-tight">{group.name}</h3>
            <StationMetadata measurement={group.items[0].measurement} />
          </div>
          <ul className="divide-y divide-line border-t border-line">
            {group.items.map(({ measurement, latest }) => (
              <li
                key={measurement.measurementId}
                className="relative transition-colors hover:bg-canvas"
              >
                <div className="flex flex-col gap-1 px-5 py-3.5 sm:px-6 @lg:grid @lg:grid-cols-[11rem_minmax(0,1fr)] @lg:items-baseline @lg:gap-6">
                  {/* The link covers the row behind the separate comparison action. */}
                  <div>
                    <Link
                      href={measurementPath(measurement.measurementId)}
                      className="font-medium text-accent underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
                    >
                      <span className="sr-only">{group.name}</span>{" "}
                      {parameterLabel(measurement.parameter)}
                    </Link>
                    <p className="text-sm text-ink-muted">{measurementSummary(measurement)}</p>
                  </div>
                  <p className="text-sm">
                    <LatestLine measurement={measurement} latest={latest} />
                  </p>
                  {comparisonAction?.(measurement)}
                </div>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
