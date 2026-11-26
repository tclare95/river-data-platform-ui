import { rainfallBounds, type RainfallResult } from "@/lib/history/rainfall";
import type { HistoryWindow } from "@/lib/history/range";
import { epochMs, tickKey } from "@/lib/rdp/contract";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

const ROLLING_HOURS = { "6h": 6, "12h": 12, "24h": 24, "48h": 48, "72h": 72, "7d": 168 };
const SUMMARY_WINDOWS = ["24h", "48h", "72h", "7d"] as const;
const WINDOW_LABELS = {
  "6h": "6 hours",
  "12h": "12 hours",
  "24h": "24 hours",
  "48h": "48 hours",
  "72h": "72 hours",
  "7d": "7 days",
};

export const RAINFALL_MODES = {
  native: "Native interval totals",
  hourly: "Hourly totals",
  daily: "Daily totals",
  "6h": "Rolling 6-hour total",
  "12h": "Rolling 12-hour total",
  "24h": "Rolling 24-hour total",
  "48h": "Rolling 48-hour total",
  "72h": "Rolling 72-hour total",
  "7d": "Rolling 7-day total",
  cumulative: "Cumulative since chart start",
} as const;

export type RainfallMode = keyof typeof RAINFALL_MODES;

export type RainfallTotal = HistoryWindow & {
  expected: number;
  used: number;
  totalMm: number | null;
  basis: "verified" | "indicative";
  status: "complete" | "partial" | "unavailable";
};

/** RDP's query is by label [from, to). A verified end-label at the chart end can close the last period. */
export function rainfallReadWindow(window: HistoryWindow): HistoryWindow {
  return { from: iso(epochMs(window.from) - 7 * DAY), to: iso(epochMs(window.to) + 1) };
}

function gridTime(timestamp: string, stride: number) {
  const ms = epochMs(timestamp);
  return ms % stride === 0 && tickKey(timestamp) === tickKey(iso(ms)) ? ms : NaN;
}

type Slot = { value: number | null; start: number; unverified: boolean };

function rainfallAccumulator(history: RainfallResult) {
  type Interval = RainfallResult["intervals"][number];
  const stride = history.periodSeconds * 1000;
  const byLabel = new Map<number, { row: Interval; conflict: boolean }>();
  for (const row of history.intervals) {
    const label = gridTime(row.label, stride);
    if (!Number.isFinite(label)) continue;
    const previous = byLabel.get(label);
    if (!previous || row.revision > previous.row.revision) {
      byLabel.set(label, { row, conflict: false });
    } else if (row.revision === previous.row.revision) {
      const before = previous.row;
      if (
        row.totalMm !== before.totalMm ||
        row.eligible !== before.eligible ||
        row.labelConvention !== before.labelConvention ||
        tickKey(row.periodStart ?? "") !== tickKey(before.periodStart ?? "") ||
        tickKey(row.periodEnd ?? "") !== tickKey(before.periodEnd ?? "")
      )
        previous.conflict = true;
    }
  }

  const labels = new Map<number, Slot>();
  const periods = new Map<number, Slot[]>();
  for (const [label, { row, conflict }] of byLabel) {
    if (conflict) continue;
    const bounds = rainfallBounds(row);
    const start = bounds ? gridTime(bounds[0], stride) : NaN;
    const end = bounds ? gridTime(bounds[1], stride) : NaN;
    const unverified = row.labelConvention === "unverified";
    const validPeriod =
      end - start === stride && label === (row.labelConvention === "period_start" ? start : end);
    if (!unverified && !validPeriod) continue;
    const slot = {
      start,
      unverified,
      value:
        row.eligible && row.totalMm !== null && Number.isFinite(row.totalMm) && row.totalMm >= 0
          ? row.totalMm
          : null,
    };
    labels.set(label, slot);
    if (validPeriod) {
      const slots = periods.get(start) ?? [];
      slots.push(slot);
      periods.set(start, slots);
    }
  }

  return (from: number, to: number, expectedSpan = to - from): RainfallTotal => {
    const expected = Math.ceil(expectedSpan / stride);
    let exactSum = 0;
    let exactCount = 0;
    let labelSum = 0;
    let labelCount = 0;
    let indicative = labels.get(to)?.unverified ?? false;

    for (let t = Math.ceil(from / stride) * stride; t < to; t += stride) {
      const byStart = periods.get(t);
      if (t + stride <= to && byStart?.length === 1 && byStart[0].value !== null) {
        exactSum += byStart[0].value;
        exactCount++;
      }
      const slot = labels.get(t);
      if (!slot) continue;
      indicative ||= slot.unverified;
      // Two verified labels can point to the same period across a convention change.
      if (slot.value !== null && (periods.get(slot.start)?.length ?? 0) < 2) {
        labelSum += slot.value;
        labelCount++;
      }
    }

    const used = indicative ? labelCount : exactCount;
    return {
      from: iso(from),
      to: iso(to),
      expected,
      used,
      totalMm: used ? (indicative ? labelSum : exactSum) : null,
      basis: indicative ? "indicative" : "verified",
      status: used === 0 ? "unavailable" : used === expected ? "complete" : "partial",
    };
  };
}

export function rainfallSummaries(history: RainfallResult) {
  const end = epochMs(history.to);
  const total = rainfallAccumulator(history);
  return SUMMARY_WINDOWS.map((key) => ({
    label: `Previous ${WINDOW_LABELS[key]}`,
    ...total(end - ROLLING_HOURS[key] * HOUR, end),
  }));
}

export function rainfallTotals(history: RainfallResult, mode: Exclude<RainfallMode, "native">) {
  const from = epochMs(history.from);
  const to = epochMs(history.to);
  const total = rainfallAccumulator(history);
  const points: RainfallTotal[] = [];
  if (mode === "hourly" || mode === "daily") {
    const step = mode === "daily" ? DAY : HOUR;
    for (let start = Math.floor(from / step) * step; start < to; start += step) {
      points.push(total(Math.max(start, from), Math.min(start + step, to), step));
    }
  } else {
    const rolling = mode === "cumulative" ? null : ROLLING_HOURS[mode] * HOUR;
    for (let end = rolling === null ? from + HOUR : from; end <= to; end += HOUR) {
      points.push(total(rolling === null ? from : end - rolling, end));
    }
  }
  return points;
}

export function rainfallTotalCoverage(total: RainfallTotal) {
  const status = total.status === "partial" ? "Partial · " : "";
  if (total.basis === "indicative") {
    return `${status}Indicative · ${total.used}/${total.expected} expected labels`;
  }
  return `${status}${total.used}/${total.expected} expected intervals with verified timing`;
}

const depth = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 7 });

export function rainfallDepth(value: number | null) {
  return value === null ? "Unavailable" : `${depth.format(value)} mm`;
}
