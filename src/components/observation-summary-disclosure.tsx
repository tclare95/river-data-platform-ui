"use client";

import { useEffect, useState } from "react";
import { LatestLine } from "@/components/latest-reading";
import { ObservationSummaryStats } from "@/components/observation-summary";
import { ErrorState, LoadingState } from "@/components/states";
import {
  supportsObservationSummary,
  type ObservationSummary,
} from "@/lib/history/observation-summary";
import { datumSummary, parameterLabel } from "@/lib/labels";
import type { PublicLatest, PublicMeasurement } from "@/lib/rdp/public";

type SummaryData = { latest: PublicLatest | null; summary: ObservationSummary };

function LoadedSummary({ measurement }: { measurement: PublicMeasurement }) {
  const id = measurement.measurementId;
  const [data, setData] = useState<SummaryData | "unavailable" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/measurements/${encodeURIComponent(id)}/summary`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Summary unavailable");
        const result: SummaryData = await response.json();
        if (!controller.signal.aborted) setData(result);
      } catch {
        if (!controller.signal.aborted) setData("unavailable");
      }
    }
    void load();
    return () => controller.abort();
  }, [id]);

  if (!data) {
    return <LoadingState label="Loading observation summary" lines={1} className="px-3 py-2" />;
  }
  if (data === "unavailable") {
    return <ErrorState title="Observation summary unavailable" className="px-3 py-2" />;
  }
  const datum = datumSummary(measurement);
  return (
    <div className="space-y-2">
      <p>
        <LatestLine measurement={measurement} latest={data.latest} showFreshness />
        {datum ? <span className="text-ink-muted"> · {datum}</span> : null}
      </p>
      <ObservationSummaryStats measurement={measurement} summary={data.summary} />
    </div>
  );
}

export function ObservationSummaryDisclosure({ measurement }: { measurement: PublicMeasurement }) {
  const [open, setOpen] = useState(false);
  if (!supportsObservationSummary(measurement)) return null;
  return (
    <details
      className="my-1 w-full text-sm"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="w-fit cursor-pointer py-1 font-medium text-accent"
        aria-label={`Recent observations for ${measurement.name} ${parameterLabel(measurement.parameter).toLowerCase()}`}
      >
        Recent observations
      </summary>
      {open ? <LoadedSummary key={measurement.measurementId} measurement={measurement} /> : null}
    </details>
  );
}
