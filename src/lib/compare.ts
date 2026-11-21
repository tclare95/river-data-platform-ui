import type { HistoryResult, PublicObservation } from "@/lib/history/load";
import type { RainfallInterval } from "@/lib/history/rainfall";
import { parseRange, type HistoryRange } from "@/lib/history/range";
import { tickKey } from "@/lib/rdp/contract";
import type { PublicMeasurement } from "@/lib/rdp/public";

export type CompareQuery = { a: string | null; b: string | null; range: HistoryRange };

function single(value: unknown): string | null {
  // A repeated parameter is a choice that can't be used: a joined value never matches a measurement ID.
  if (Array.isArray(value)) return value.join(",");
  return typeof value === "string" && value !== "" ? value : null;
}

/** `?a=&b=&range=`; a missing parameter is not chosen, a repeated one is an unusable choice. */
export function readCompareQuery(
  params: Record<string, string | string[] | undefined>,
): CompareQuery {
  return { a: single(params.a), b: single(params.b), range: parseRange(params.range) };
}

export function compareHref(query: { a?: string | null; b?: string | null; range?: HistoryRange }) {
  const params = new URLSearchParams();
  if (query.a) params.set("a", query.a);
  if (query.b) params.set("b", query.b);
  if (query.range) params.set("range", query.range);
  const search = params.toString();
  return search ? `/compare?${search}` : "/compare";
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

export type ComparisonReading = PublicObservation | RainfallInterval;
export type ComparisonSide = { measurement: PublicMeasurement; result: HistoryResult };
export type AlignedRow = {
  time: string;
  a: ComparisonReading | null;
  b: ComparisonReading | null;
};

export function comparisonReadings(result: HistoryResult): readonly ComparisonReading[] {
  if (result.status !== "ok") return [];
  return "intervals" in result ? result.intervals : result.observations;
}

/** Join equal source timestamps or provider labels without moving readings or rounding timestamps. */
export function alignReadings(
  a: readonly ComparisonReading[],
  b: readonly ComparisonReading[],
): AlignedRow[] {
  const rows = new Map<string, AlignedRow>();
  for (const [key, readings] of [
    ["a", a],
    ["b", b],
  ] as const) {
    for (const reading of readings) {
      const time = "label" in reading ? reading.label : reading.observedAt;
      const tick = tickKey(time);
      const row = rows.get(tick) ?? { time, a: null, b: null };
      row[key] = reading;
      rows.set(tick, row);
    }
  }
  return [...rows.entries()].sort(([x], [y]) => y.localeCompare(x)).map(([, row]) => row);
}
