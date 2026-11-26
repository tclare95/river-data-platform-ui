import { epochMs } from "@/lib/rdp/contract";
import type { PublicLatest, PublicMeasurement } from "@/lib/rdp/public";
import { buildSeries, type SeriesGap, type SeriesReading } from "./series";

export const HOUR_MS = 3_600_000;
const WINDOWS = [1, 6, 24] as const;

const LEVEL_UNITS = new Set(["m", "mASD", "mAOD", "mAD"]);
const FLOW_UNITS = new Set(["m3/s", "m³/s"]);

export function supportsObservationSummary(measurement: PublicMeasurement) {
  return (
    measurement.kind === "instantaneous" &&
    measurement.expectedIntervalSeconds >= 60 &&
    measurement.expectedIntervalSeconds <= 3600 &&
    ((measurement.parameter === "level" && LEVEL_UNITS.has(measurement.unit)) ||
      (measurement.parameter === "flow" && FLOW_UNITS.has(measurement.unit)))
  );
}

export function summaryTolerance(intervalMs: number) {
  return Math.min(intervalMs / 2, 15 * 60_000);
}

export function isRecentReading(latest: PublicLatest | null, intervalMs: number, now: number) {
  if (
    latest?.kind !== "instantaneous" ||
    latest.status !== "available" ||
    latest.freshness !== "fresh" ||
    latest.value === null ||
    latest.observedAt === null
  ) {
    return false;
  }
  const age = now - epochMs(latest.observedAt);
  return age >= 0 && age <= 2 * intervalMs;
}

type Comparison = { hours: (typeof WINDOWS)[number]; change: number | null };
type Trend = "Rising" | "Falling" | "Broadly stable";

export type ObservationSummary =
  | { status: "latest_unavailable" | "not_recent" | "history_unavailable" | "insufficient" }
  | {
      status: "available";
      changes: Comparison[];
      recent: { rate: number; trend: Trend; from: string; elapsedMinutes: number } | null;
      day: { min: number; max: number; sparkline: [number, number][] } | null;
    };

export function summarizeObservations(
  measurement: PublicMeasurement,
  latest: SeriesReading,
  history: readonly SeriesReading[],
  gaps: readonly SeriesGap[],
): ObservationSummary {
  const end = epochMs(latest.observedAt);
  const dayStart = end - 24 * HOUR_MS;
  const interval = measurement.expectedIntervalSeconds * 1000;
  const tolerance = summaryTolerance(interval);
  const before = history.filter((row) => {
    const t = epochMs(row.observedAt);
    return t >= dayStart - tolerance && t < end;
  });
  const rows = [...before, latest];
  const times = rows.map((row) => epochMs(row.observedAt));
  const { missing } = buildSeries(rows, measurement.expectedIntervalSeconds, gaps);
  const breaks = [
    ...gaps.map((gap) => [epochMs(gap.from), epochMs(gap.to)]),
    ...missing.map((gap) => [epochMs(gap.after), epochMs(gap.before)]),
  ];
  const continuous = (start: number) => !breaks.some(([from, to]) => from <= end && to > start);

  let hourly: SeriesReading | undefined;
  const changes = WINDOWS.map((hours): Comparison => {
    const target = end - hours * HOUR_MS;
    let nearest: SeriesReading | undefined;
    let distance = Infinity;
    for (const [index, row] of before.entries()) {
      const difference = Math.abs(times[index] - target);
      if (difference <= tolerance && difference < distance) {
        nearest = row;
        distance = difference;
      }
    }
    if (!nearest || !continuous(Math.min(target, epochMs(nearest.observedAt)))) {
      return { hours, change: null };
    }
    if (hours === 1) hourly = nearest;
    return { hours, change: latest.value - nearest.value };
  });

  let recent: Extract<ObservationSummary, { status: "available" }>["recent"] = null;
  if (hourly) {
    const elapsed = end - epochMs(hourly.observedAt);
    const rate = (latest.value - hourly.value) * (HOUR_MS / elapsed);
    const threshold =
      measurement.parameter === "level"
        ? 0.01
        : Math.max(0.01, 0.02 * Math.max(Math.abs(latest.value), Math.abs(hourly.value)));
    recent = {
      rate,
      trend:
        Math.abs(rate) - threshold <= 1e-12 ? "Broadly stable" : rate > 0 ? "Rising" : "Falling",
      from: hourly.observedAt,
      elapsedMinutes: elapsed / 60_000,
    };
  }

  let day: Extract<ObservationSummary, { status: "available" }>["day"] = null;
  const firstInDay = times.findIndex((time) => time >= dayStart);
  if (times[firstInDay] - dayStart <= interval && continuous(dayStart)) {
    const readings = rows.slice(firstInDay);
    const values = readings.map(({ value }) => value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const sparkline = readings.map(({ value }, index): [number, number] => [
      (times[firstInDay + index] - dayStart) / (24 * HOUR_MS),
      min === max ? 0.5 : (max - value) / (max - min),
    ]);
    day = { min, max, sparkline };
  }

  return recent || day || changes.some(({ change }) => change !== null)
    ? { status: "available", changes, recent, day }
    : { status: "insufficient" };
}
