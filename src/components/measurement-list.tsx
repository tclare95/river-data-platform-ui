import Link from "next/link";
import type { ReactNode } from "react";
import { LatestLine } from "@/components/latest-reading";
import type { StationGroup } from "@/lib/discovery";
import { measurementPath, parameterLabel } from "@/lib/labels";
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
    <ul className="divide-y divide-line">
      {groups.map((group) => (
        <li key={group.stationId}>
          <div className="pt-3 pb-1">
            <h3 className="text-base font-semibold">{group.name}</h3>
            {group.watercourseName ? (
              <p className="text-sm text-ink-muted">{group.watercourseName}</p>
            ) : null}
          </div>
          <ul className="divide-y divide-line">
            {group.items.map(({ measurement, latest }) => (
              <li
                key={measurement.measurementId}
                className="relative transition-colors hover:bg-canvas"
              >
                <div className="flex flex-col gap-1 py-2 @lg:grid @lg:grid-cols-[11rem_minmax(0,1fr)] @lg:items-baseline @lg:gap-6">
                  {/* The link covers the row behind the separate comparison action. */}
                  <Link
                    href={measurementPath(measurement.measurementId)}
                    className="font-medium text-accent underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
                  >
                    <span className="sr-only">{group.name}</span>{" "}
                    {parameterLabel(measurement.parameter)}
                  </Link>
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
