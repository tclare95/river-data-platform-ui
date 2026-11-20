/**
 * Turns RDP's observed readings into a chart series without inventing data.
 *
 * Readings are plotted at their own source times on a linear time axis. Consecutive readings are joined only when
 * they are no further apart than {@link BREAK_FACTOR} expected intervals and no known coverage gap lies between
 * them; otherwise a `null` point breaks the line, so a missing interval is never drawn as if it were observed.
 * Nothing is interpolated, resampled, smoothed or clipped, and negative values are kept as published.
 */
import { epochMs } from "@/lib/rdp/contract";

/** Readings further apart than this many expected intervals are not joined (one missed 15-minute sample breaks). */
export const BREAK_FACTOR = 1.5;

export type SeriesReading = { observedAt: string; value: number };
export type SeriesGap = { from: string; to: string };

export type SeriesPoint = {
  /** Epoch milliseconds of the source observation time, or of a break marker. */
  t: number;
  value: number | null;
  /** True for a reading with no joined neighbour, which a line alone would not show. */
  isolated: boolean;
};

export type MissingInterval = {
  /** Last reading before the interval (exclusive bound of missing data). */
  after: string;
  /** First reading after the interval. */
  before: string;
};

export type Series = {
  points: SeriesPoint[];
  /** Places where consecutive readings are not joined, in time order. */
  missing: MissingInterval[];
  count: number;
  min: number | null;
  max: number | null;
  first: string | null;
  last: string | null;
};

function crossesGap(previous: number, next: number, gaps: ReadonlyArray<[number, number]>) {
  return gaps.some(([from, to]) => from < next && to > previous);
}

/**
 * @param readings strictly ascending by `observedAt` (the adapter enforces this).
 * @param knownGaps RDP coverage gaps whose reason is known (not `unknown`); readings either side are never joined.
 */
export function buildSeries(
  readings: readonly SeriesReading[],
  expectedIntervalSeconds: number,
  knownGaps: readonly SeriesGap[] = [],
): Series {
  const threshold = BREAK_FACTOR * expectedIntervalSeconds * 1000;
  const gaps = knownGaps.map((gap): [number, number] => [epochMs(gap.from), epochMs(gap.to)]);
  const points: SeriesPoint[] = [];
  const missing: MissingInterval[] = [];
  let min: number | null = null;
  let max: number | null = null;

  readings.forEach((reading, index) => {
    const t = epochMs(reading.observedAt);
    if (index > 0) {
      const previous = readings[index - 1];
      const before = epochMs(previous.observedAt);
      if (t - before > threshold || crossesGap(before, t, gaps)) {
        missing.push({ after: previous.observedAt, before: reading.observedAt });
        points.push({ t: before + (t - before) / 2, value: null, isolated: false });
      }
    }
    points.push({ t, value: reading.value, isolated: false });
    min = min === null ? reading.value : Math.min(min, reading.value);
    max = max === null ? reading.value : Math.max(max, reading.value);
  });

  points.forEach((point, index) => {
    if (point.value === null) return;
    const joinedBefore = index > 0 && points[index - 1].value !== null;
    const joinedAfter = index < points.length - 1 && points[index + 1].value !== null;
    point.isolated = !joinedBefore && !joinedAfter;
  });

  return {
    points,
    missing,
    count: readings.length,
    min,
    max,
    first: readings[0]?.observedAt ?? null,
    last: readings.at(-1)?.observedAt ?? null,
  };
}
