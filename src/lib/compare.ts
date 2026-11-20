/**
 * Two-measurement comparison: which pairs may share a value scale, and the readings of both lined up at their own
 * source times. Pure, so the page, charts and table agree, and nothing here resamples or interpolates.
 */
import { parseRange, type HistoryRange } from "@/lib/history/range";
import { epochMs } from "@/lib/rdp/contract";
import type { PublicMeasurement } from "@/lib/rdp/public";

export type CompareQuery = { a: string | null; b: string | null; range: HistoryRange };

function single(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `?a=&b=&range=`; a missing or repeated parameter is not chosen. */
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

/** Only instantaneous readings have a charted history; rainfall period totals are not compared yet. */
export function isComparable(measurement: PublicMeasurement): boolean {
  return measurement.kind === "instantaneous";
}

/**
 * Level datums shared between stations. Anything else (EA's station-local `ASD`, `unknown`) is a datum of its own
 * station, so two such levels are heights above different zeros.
 */
const SHARED_LEVEL_DATUMS = new Set(["AOD", "ODN"]);

export type ScaleBasis =
  | { shared: true }
  | { shared: false; reason: "different_parameter" | "different_unit" | "local_datum" };

/**
 * Whether two series' values are directly comparable magnitudes. A shared scale needs the same parameter and unit,
 * and for level the same datum shared between stations (or the same station). Otherwise each chart keeps its own
 * scale and the page says why.
 */
export function scaleBasis(a: PublicMeasurement, b: PublicMeasurement): ScaleBasis {
  if (a.parameter !== b.parameter) return { shared: false, reason: "different_parameter" };
  if (a.unit !== b.unit) return { shared: false, reason: "different_unit" };
  if (a.parameter === "level" && a.stationId !== b.stationId) {
    if (a.datum !== b.datum || !SHARED_LEVEL_DATUMS.has(a.datum)) {
      return { shared: false, reason: "local_datum" };
    }
  }
  return { shared: true };
}

export const SCALE_NOTE: Record<Exclude<ScaleBasis, { shared: true }>["reason"], string> = {
  different_parameter: "Different kinds of measurement, so each chart has its own scale.",
  different_unit: "Different units, so each chart has its own scale.",
  local_datum:
    "Each gauge measures level from its own local datum, so the heights aren’t directly comparable. Each chart has its own scale.",
};

export type AlignedRow = {
  /** The source observation time, exactly as RDP returned it for whichever series has a reading. */
  observedAt: string;
  a: number | null;
  b: number | null;
};

/**
 * Both series' readings by exact observation time, newest first. A time present in only one series has `null` for
 * the other: no reading is moved, resampled or interpolated to fill it.
 */
export function alignReadings(
  a: ReadonlyArray<{ observedAt: string; value: number }>,
  b: ReadonlyArray<{ observedAt: string; value: number }>,
): AlignedRow[] {
  const rows = new Map<number, AlignedRow>();
  for (const reading of a) {
    rows.set(epochMs(reading.observedAt), {
      observedAt: reading.observedAt,
      a: reading.value,
      b: null,
    });
  }
  for (const reading of b) {
    const key = epochMs(reading.observedAt);
    const row = rows.get(key);
    if (row) row.b = reading.value;
    else rows.set(key, { observedAt: reading.observedAt, a: null, b: reading.value });
  }
  return [...rows.entries()].sort(([x], [y]) => y - x).map(([, row]) => row);
}
