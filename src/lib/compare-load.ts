import "server-only";
import { loadHistory, type HistoryResult } from "@/lib/history/load";
import { rangeWindow, type HistoryRange, type HistoryWindow } from "@/lib/history/range";
import { parameterLabel } from "@/lib/labels";
import { publicMeasurements, toPublicMeasurement, type PublicMeasurement } from "@/lib/rdp/public";
import { getRdpClient } from "@/lib/rdp/server";

export type ComparableCatalogue =
  | {
      status: "ok";
      mode: "fixture" | "live";
      measurements: PublicMeasurement[];
    }
  | { status: "unavailable" };

/** Publicly displayable measurements with a charted history, by station name then type. */
export async function loadComparable(): Promise<ComparableCatalogue> {
  try {
    const rdp = getRdpClient();
    const all = publicMeasurements((await rdp.listMeasurements()).measurements).map(
      toPublicMeasurement,
    );
    const measurements = all.sort(
      (x, y) =>
        x.name.localeCompare(y.name, "en-GB") ||
        parameterLabel(x.parameter).localeCompare(parameterLabel(y.parameter), "en-GB") ||
        x.measurementId.localeCompare(y.measurementId),
    );
    return {
      status: "ok",
      mode: rdp.mode,
      measurements,
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * One series of a comparison over the shared window. Never rejects: configuration and transport failures are the
 * `unavailable` state, independently of the other series.
 */
async function loadComparisonHistory(
  measurement: PublicMeasurement,
  window: HistoryWindow,
): Promise<HistoryResult> {
  try {
    return await loadHistory(getRdpClient(), measurement.measurementId, measurement.kind, window);
  } catch {
    return { status: "unavailable" };
  }
}

/** All selected series over one shared window. */
export function loadComparison(measurements: readonly PublicMeasurement[], range: HistoryRange) {
  const window = rangeWindow(range, Date.now());
  return Promise.all(
    measurements.map(async (measurement) => ({
      measurement,
      result: await loadComparisonHistory(measurement, window),
    })),
  );
}
