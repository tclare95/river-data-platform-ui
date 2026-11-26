import type { HistoryResult, PublicObservation } from "@/lib/history/load";
import { comparisonSourceWindow, shiftComparisonTime } from "@/lib/compare-time";
import {
  rainfallBounds,
  visibleRainfallIntervals,
  type RainfallInterval,
} from "@/lib/history/rainfall";
import type { RainfallTotal } from "@/lib/history/rainfall-totals";
import { parseRange, type HistoryRange, type HistoryWindow } from "@/lib/history/range";
import { formatPeriod } from "@/lib/format";
import { parameterLabel } from "@/lib/labels";
import { epochMs, tickKey } from "@/lib/rdp/contract";
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

export type ComparisonReading = PublicObservation | RainfallInterval | RainfallTotal;
export type ComparisonSide = { measurement: PublicMeasurement; result: HistoryResult };
export type ComparisonHistory = { window: HistoryWindow; data: ComparisonSide[] };
export type AlignedRow = {
  time: string;
  readings: (ComparisonReading | null)[];
};

export function comparisonReadings(result: HistoryResult): readonly ComparisonReading[] {
  if (result.status !== "ok") return [];
  return "intervals" in result ? visibleRainfallIntervals(result) : result.observations;
}

/** Select readings in source time first, so rainfall totals keep their original UTC grid. */
export function comparisonWindowResult(
  result: HistoryResult,
  window: HistoryWindow,
  minutes: number,
): HistoryResult {
  if (result.status !== "ok") return result;
  const { from, to: requestedEnd } = comparisonSourceWindow(window, minutes);
  const truncated = tickKey(requestedEnd) > tickKey(result.to);
  const to = truncated ? result.to : requestedEnd;
  const start = tickKey(from);
  const end = tickKey(to);
  const gaps = result.coverage.gaps.flatMap((gap) => {
    if (tickKey(gap.from) >= end || tickKey(gap.to) <= start) return [];
    return [
      {
        ...gap,
        from: tickKey(gap.from) < start ? from : gap.from,
        to: tickKey(gap.to) > end ? to : gap.to,
      },
    ];
  });
  const coverage: typeof result.coverage = {
    status:
      truncated || gaps.some((gap) => gap.reason === "unknown")
        ? "unknown"
        : gaps.length > 0
          ? "partial"
          : result.coverage.gaps.length > 0
            ? "complete"
            : result.coverage.status,
    gaps,
  };
  if ("intervals" in result) return { ...result, from, to, coverage };
  const observations = result.observations.filter(({ observedAt }) => {
    const time = tickKey(observedAt);
    return time >= start && time < end;
  });
  return { ...result, from, to, coverage, observations };
}

export function comparisonReadingTime(reading: ComparisonReading): string {
  if ("expected" in reading) return reading.to;
  return "label" in reading ? reading.label : reading.observedAt;
}

/** Join exact display timestamps while retaining the original reading in each cell. */
export function alignReadings(
  series: readonly (readonly ComparisonReading[])[],
  offsets: readonly number[] = [],
): AlignedRow[] {
  const rows = new Map<string, AlignedRow>();
  for (const [index, readings] of series.entries()) {
    for (const reading of readings) {
      const time = shiftComparisonTime(comparisonReadingTime(reading), offsets[index] ?? 0);
      const tick = tickKey(time);
      const row = rows.get(tick) ?? { time, readings: Array(series.length).fill(null) };
      row.readings[index] = reading;
      rows.set(tick, row);
    }
  }
  return [...rows.entries()].sort(([x], [y]) => y.localeCompare(x)).map(([, row]) => row);
}

/** Snap inspection to displayed times and to a point inside each visible verified rainfall bar. */
export function comparisonInspectionRows(
  rows: readonly AlignedRow[],
  offsets: readonly number[],
  window: HistoryWindow,
) {
  const points = new Map(rows.map((row) => [tickKey(row.time), row]));
  const start = epochMs(window.from);
  const end = epochMs(window.to);
  const periods = (rows[0]?.readings ?? []).map(
    () =>
      [] as {
        from: number;
        to: number;
        reading: RainfallInterval;
      }[],
  );

  for (const { readings } of rows) {
    readings.forEach((reading, index) => {
      if (!reading || !("label" in reading)) return;
      const bounds = rainfallBounds(reading);
      if (!bounds) return;
      const [left, right] = bounds.map((time) =>
        epochMs(shiftComparisonTime(time, offsets[index])),
      );
      const from = Math.max(left, start);
      const to = Math.min(right, end);
      if (to <= from) return;
      periods[index].push({ from, to, reading });
      const time = new Date(from + (to - from) / 2).toISOString();
      const key = tickKey(time);
      if (!points.has(key)) points.set(key, { time, readings: readings.map(() => null) });
    });
  }

  for (const intervals of periods) intervals.sort((a, b) => a.from - b.from);
  const cursors = periods.map(() => 0);
  return [...points.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => {
      const t = epochMs(row.time);
      return {
        time: row.time,
        t,
        readings: row.readings.map((reading, index) => {
          const intervals = periods[index];
          while (intervals[cursors[index]]?.to <= t) cursors[index]++;
          const interval = intervals[cursors[index]];
          return reading ?? (interval && interval.from <= t ? interval.reading : null);
        }),
      };
    });
}
