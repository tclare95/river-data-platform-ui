import type { RainfallTotal } from "@/lib/history/rainfall-totals";
import type { HistoryWindow } from "@/lib/history/range";
import type { PublicMeasurement } from "@/lib/rdp/public";

export const RAINFALL_MAP_PERIODS = {
  "24h": { hours: 24, label: "24 hours" },
  "72h": { hours: 72, label: "72 hours" },
  "7d": { hours: 168, label: "7 days" },
} as const;

export type RainfallMapPeriod = keyof typeof RAINFALL_MAP_PERIODS;
export const MAX_MAP_RAINFALL_MEASUREMENTS = 4;

export const isRainfall = (parameter: string | null) =>
  parameter?.trim().toLowerCase() === "rainfall";

export function isRainfallTotal(measurement: Pick<PublicMeasurement, "kind" | "parameter">) {
  return measurement.kind === "period_total" && isRainfall(measurement.parameter);
}

export type MapRainfallReading =
  { status: "total"; total: RainfallTotal } | { status: "missing" | "unavailable" };

export type MapRainfallResponse = {
  window: HistoryWindow;
  readings: Record<string, MapRainfallReading>;
};
