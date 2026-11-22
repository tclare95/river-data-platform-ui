import type { HistoryResult, PublicObservation } from "@/lib/history/load";
import type { RainfallInterval } from "@/lib/history/rainfall";
import { parseRange, type HistoryRange } from "@/lib/history/range";
import { formatPeriod } from "@/lib/format";
import { parameterLabel } from "@/lib/labels";
import { tickKey } from "@/lib/rdp/contract";
import type { PublicMeasurement } from "@/lib/rdp/public";

export const COMPARE_SLOTS = ["a", "b", "c", "d"] as const;
export const MAX_COMPARE_AXES = 2;

export function readCompareQuery(
  params: Record<string, string | string[] | undefined> | URLSearchParams,
) {
  const get = (name: string) => {
    if (!(params instanceof URLSearchParams)) return params[name];
    const values = params.getAll(name);
    return values.length > 1 ? values : values[0];
  };
  const values = COMPARE_SLOTS.map(get);
  return {
    ids: values.filter((value): value is string => typeof value === "string" && value !== ""),
    repeated: values.some(Array.isArray),
    range: parseRange(get("range")),
  };
}

export function compareParams(ids: readonly string[], range?: HistoryRange) {
  const params = new URLSearchParams();
  COMPARE_SLOTS.forEach((slot, index) => {
    if (ids[index]) params.set(slot, ids[index]);
  });
  if (range) params.set("range", range);
  return params;
}

export function compareHref(ids: readonly string[] = [], range?: HistoryRange) {
  const search = compareParams(ids, range).toString();
  return search ? `/compare?${search}` : "/compare";
}

export function comparisonLabel(measurement: PublicMeasurement) {
  const { name, parameter, unit, kind, periodSeconds } = measurement;
  const scale =
    kind === "period_total" && periodSeconds ? `${unit} per ${formatPeriod(periodSeconds)}` : unit;
  return `${name} · ${parameterLabel(parameter)} (${scale})`;
}

/**
 * Level datums shared between stations. Anything else (EA's station-local `ASD`, `unknown`) is a datum of its own
 * station, so two such levels are heights above different zeros.
 */
const SHARED_LEVEL_DATUMS = new Set(["AOD", "ODN"]);

export function sharesScale(a: PublicMeasurement, b: PublicMeasurement): boolean {
  if (a.parameter !== b.parameter || a.unit !== b.unit || a.kind !== b.kind) return false;
  if (a.kind === "period_total") return a.periodSeconds === b.periodSeconds;
  if (a.parameter !== "level") return true;
  if (a.datum !== b.datum || a.datum === "unknown" || a.datum === "none") return false;
  return a.stationId === b.stationId || SHARED_LEVEL_DATUMS.has(a.datum);
}

export function comparisonAxes<T>(
  items: readonly T[],
  measurement: (item: T) => PublicMeasurement,
) {
  const axes: T[][] = [];
  for (const item of items) {
    const shared = axes.find(([first]) => sharesScale(measurement(first), measurement(item)));
    if (shared) shared.push(item);
    else axes.push([item]);
  }
  return axes;
}

export function needsMoreCompareAxes(measurements: readonly PublicMeasurement[]) {
  return comparisonAxes(measurements, (item) => item).length > MAX_COMPARE_AXES;
}

export type ComparisonReading = PublicObservation | RainfallInterval;
export type ComparisonSide = { measurement: PublicMeasurement; result: HistoryResult };
export type AlignedRow = {
  time: string;
  readings: (ComparisonReading | null)[];
};

export function comparisonReadings(result: HistoryResult): readonly ComparisonReading[] {
  if (result.status !== "ok") return [];
  return "intervals" in result ? result.intervals : result.observations;
}

/** Join equal source timestamps or provider labels without moving readings or rounding timestamps. */
export function alignReadings(series: readonly (readonly ComparisonReading[])[]): AlignedRow[] {
  const rows = new Map<string, AlignedRow>();
  for (const [index, readings] of series.entries()) {
    for (const reading of readings) {
      const time = "label" in reading ? reading.label : reading.observedAt;
      const tick = tickKey(time);
      const row = rows.get(tick) ?? { time, readings: Array(series.length).fill(null) };
      row.readings[index] = reading;
      rows.set(tick, row);
    }
  }
  return [...rows.entries()].sort(([x], [y]) => y.localeCompare(x)).map(([, row]) => row);
}
