import "server-only";
import { isComparable } from "@/lib/compare";
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
      /** Whether some public measurements (rainfall period totals) can't be compared yet. */
      excluded: boolean;
    }
  | { status: "unavailable" };

/** Publicly displayable measurements with a charted history, by station name then type. */
export async function loadComparable(): Promise<ComparableCatalogue> {
  try {
    const rdp = getRdpClient();
    const all = publicMeasurements((await rdp.listMeasurements()).measurements).map(
      toPublicMeasurement,
    );
    const measurements = all
      .filter(isComparable)
      .sort(
        (x, y) =>
          x.name.localeCompare(y.name, "en-GB") ||
          parameterLabel(x.parameter).localeCompare(parameterLabel(y.parameter), "en-GB") ||
          x.measurementId.localeCompare(y.measurementId),
      );
    return {
      status: "ok",
      mode: rdp.mode,
      measurements,
      excluded: measurements.length < all.length,
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * One series of a comparison over the shared window. Never rejects: configuration and transport failures are the
 * `unavailable` state, independently of the other series.
 */
export async function loadComparisonHistory(
  measurement: PublicMeasurement,
  window: HistoryWindow,
): Promise<HistoryResult> {
  try {
    return await loadHistory(getRdpClient(), measurement.measurementId, measurement.kind, window);
  } catch {
    return { status: "unavailable" };
  }
}

/** Both series over one window, so they always cover exactly the same period. */
export function loadComparisonPair(
  a: PublicMeasurement,
  b: PublicMeasurement,
  range: HistoryRange,
): Promise<[HistoryResult, HistoryResult]> {
  const window = rangeWindow(range, Date.now());
  return Promise.all([loadComparisonHistory(a, window), loadComparisonHistory(b, window)]);
}
