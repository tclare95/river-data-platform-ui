import Link from "next/link";
import { useId, type ReactNode } from "react";
import { Button } from "@/components/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { StationMetadata } from "@/components/station-metadata";
import { measurementPath, measurementSummary, parameterLabel } from "@/lib/labels";
import type { PublicMeasurement } from "@/lib/rdp/public";
import type { PublicUpstreamMeasurements } from "@/lib/rdp/upstream-measurements";

export type CatchmentDiscovery =
  | { status: "loading" | "unavailable" | "release-changed" | "catchment-changed" }
  | { status: "result"; data: PublicUpstreamMeasurements };

export function CatchmentMeasurements({
  discovery,
  find,
  refreshTrace,
  comparisonAction,
}: {
  discovery: CatchmentDiscovery;
  find: () => void;
  refreshTrace: () => void;
  comparisonAction: (measurement: PublicMeasurement) => ReactNode;
}) {
  const titleId = useId();
  const result = discovery.status === "result" ? discovery.data : undefined;
  const available = result?.status === "available" ? result : undefined;
  const counts = available?.meta.counts;
  const stationCount = available?.data.length ?? 0;
  const loading = discovery.status === "loading";
  const refreshNeeded =
    discovery.status === "release-changed" || discovery.status === "catchment-changed";
  const omitted = available?.omittedMeasurements ?? 0;

  return (
    <section aria-labelledby={titleId} className="space-y-2 border-t border-line px-5 py-3 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} className="font-semibold">
          Catchment measurements
        </h2>
        {refreshNeeded || discovery.status === "unavailable" ? (
          <Button onClick={refreshNeeded ? refreshTrace : find}>
            {refreshNeeded ? "Refresh catchment" : "Try again"}
          </Button>
        ) : null}
      </div>
      {loading ? (
        <LoadingState label="Finding measurements" lines={1} className="px-3 py-3" />
      ) : null}
      {refreshNeeded ? (
        <ErrorState
          title={
            discovery.status === "release-changed"
              ? "The river network release has changed"
              : "Measurement results are for a different catchment"
          }
          className="px-3 py-2"
        />
      ) : null}
      {discovery.status === "unavailable" ? (
        <ErrorState title="Measurement search unavailable" className="px-3 py-2" />
      ) : null}
      {result && !available ? (
        <EmptyState
          title={
            result.status === "location_not_matched"
              ? "River point could not be matched"
              : "Catchment unavailable for this search"
          }
          className="px-3 py-2"
        />
      ) : null}
      {available && counts ? (
        <>
          <div role="status" className="space-y-1 text-sm text-ink-muted">
            {stationCount > 0 ? (
              <p>
                {stationCount} {stationCount === 1 ? "station" : "stations"} inside the modelled
                catchment.
              </p>
            ) : (
              <EmptyState
                title={
                  omitted > 0
                    ? "Matching measurements could not be displayed"
                    : "No matching published measurements"
                }
                className="px-3 py-2"
              />
            )}
            <p>Search covers published rainfall, level and flow only.</p>
            {stationCount > 0 && omitted > 0 ? (
              <p>Some matching measurements could not be displayed.</p>
            ) : null}
            {counts.unknown + counts.ambiguous > 0 ? (
              <p>Published stations with missing or uncertain positions were excluded.</p>
            ) : null}
            {counts.nearBoundary > 0 ? (
              <p>
                Published stations near the catchment boundary were excluded due to location
                uncertainty.
              </p>
            ) : null}
            {available.networkCoverage.completeness === "incomplete" ? (
              <p>Upstream river network coverage is incomplete.</p>
            ) : null}
          </div>
          {stationCount > 0 ? (
            <ul
              aria-label="Stations inside the modelled catchment"
              className="divide-y divide-line"
            >
              {available.data.map(({ measurements }) => {
                const [station] = measurements;
                return (
                  <li key={station.stationId} className="py-2">
                    <h3 className="text-sm font-semibold">{station.name}</h3>
                    <StationMetadata measurement={station} />
                    <ul>
                      {measurements.map((measurement) => (
                        <li
                          key={measurement.measurementId}
                          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1 text-sm"
                        >
                          <Link
                            className="link"
                            href={measurementPath(measurement.measurementId)}
                            prefetch={false}
                          >
                            {parameterLabel(measurement.parameter)}
                          </Link>
                          <span className="text-ink-muted">{measurementSummary(measurement)}</span>
                          {measurement.networkRelationship === "not_assessed" ? (
                            <span className="text-ink-muted">Upstream connection unverified</span>
                          ) : null}
                          {comparisonAction(measurement)}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
