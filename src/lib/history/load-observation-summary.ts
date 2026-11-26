import "server-only";
import {
  HOUR_MS,
  isRecentReading,
  summarizeObservations,
  summaryTolerance,
  type ObservationSummary,
} from "@/lib/history/observation-summary";
import { epochMs } from "@/lib/rdp/contract";
import type { PublicLatest, PublicMeasurement } from "@/lib/rdp/public";
import { getRdpClient } from "@/lib/rdp/server";

export async function loadObservationSummary(
  measurement: PublicMeasurement,
  latest: PublicLatest | null,
): Promise<ObservationSummary> {
  if (
    latest?.kind !== "instantaneous" ||
    latest.status !== "available" ||
    latest.observedAt === null ||
    latest.value === null
  ) {
    return { status: "latest_unavailable" };
  }
  const interval = measurement.expectedIntervalSeconds * 1000;
  if (!isRecentReading(latest, interval, Date.now())) return { status: "not_recent" };

  const { observedAt, value } = latest;
  const end = epochMs(observedAt);
  try {
    const page = await getRdpClient().getHistory(measurement.measurementId, {
      from: new Date(end - 24 * HOUR_MS - summaryTolerance(interval)).toISOString(),
      to: new Date(end + 1).toISOString(),
      limit: 1500,
    });
    if (!isRecentReading(latest, interval, Date.now())) return { status: "not_recent" };
    if (page.kind !== "instantaneous" || page.nextCursor !== null) {
      return { status: "history_unavailable" };
    }
    const matching = page.observations.find((row) => epochMs(row.observedAt) === end);
    if (matching && matching.value !== value) return { status: "history_unavailable" };
    return summarizeObservations(
      measurement,
      { observedAt, value },
      page.observations,
      page.coverage.gaps.filter((gap) => gap.reason !== "unknown"),
    );
  } catch {
    return { status: "history_unavailable" };
  }
}
