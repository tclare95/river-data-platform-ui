import type { HistoryResult } from "@/lib/history/load";
import { epochMs, tickKey } from "@/lib/rdp/contract";

export type RainfallResult = Extract<HistoryResult, { intervals: unknown }>;
export type RainfallInterval = RainfallResult["intervals"][number];
type Missing = { fromLabel: string; toLabel: string; count: number };

export const INELIGIBLE_REASON = {
  QualityMissing: "Flagged as missing",
  QualitySuspect: "Suspect quality",
  NegativeDepth: "Negative depth",
};

export function rainfallBounds(row: RainfallInterval) {
  if (row.labelConvention === "unverified" || !row.periodStart || !row.periodEnd) return null;
  return [row.periodStart, row.periodEnd] as const;
}

export function missingLabels({ from, to, periodSeconds, intervals }: RainfallResult) {
  // RDP selects on a UTC label grid, including from and excluding to. Missing labels have no known physical bounds.
  const stride = periodSeconds * 1000;
  const labels = new Set(intervals.map((row) => tickKey(row.label)));
  const gaps: Missing[] = [];
  let run: Missing | undefined;
  for (let t = Math.ceil(epochMs(from) / stride) * stride; t < epochMs(to); t += stride) {
    const label = new Date(t).toISOString();
    if (labels.has(tickKey(label))) {
      run = undefined;
    } else if (run) {
      run.toLabel = label;
      run.count++;
    } else {
      run = { fromLabel: label, toLabel: label, count: 1 };
      gaps.push(run);
    }
  }
  return gaps;
}
