import Link from "next/link";
import { LatestLine } from "@/components/latest-reading";
import type { StationGroup } from "@/lib/discovery";
import { measurementPath, parameterLabel } from "@/lib/labels";

/** Stations with their published measurements; each measurement row links to its detail page. */
export function MeasurementList({ groups }: { groups: readonly StationGroup[] }) {
  return (
    <ul className="space-y-4">
      {groups.map((group) => (
        <li
          key={group.stationId}
          className="overflow-hidden rounded-lg border border-line bg-surface"
        >
          <div className="px-5 pt-4 pb-3 sm:px-6">
            <h2 className="text-lg font-semibold tracking-tight">{group.name}</h2>
            {group.watercourseName ? (
              <p className="text-sm text-ink-muted">{group.watercourseName}</p>
            ) : null}
          </div>
          <ul className="divide-y divide-line border-t border-line">
            {group.items.map(({ measurement, latest }) => (
              <li
                key={measurement.measurementId}
                className="relative transition-colors hover:bg-canvas"
              >
                <div className="flex flex-col gap-1 px-5 py-3.5 sm:grid sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-baseline sm:gap-6 sm:px-6">
                  {/* The link's ::after covers the row, so the whole row is one target and one tab stop. */}
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
                </div>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
