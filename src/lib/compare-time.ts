import type { HistoryWindow } from "@/lib/history/range";
import { epochMs } from "@/lib/rdp/contract";

export const MAX_COMPARISON_OFFSET = 24 * 60;
export const comparisonOffsetMs = (minutes: number) => minutes * 60_000;

/** Keep the source seconds and fractional precision when translating by whole minutes. */
export function shiftComparisonTime(time: string, minutes: number): string {
  if (minutes === 0) return time;
  const shifted = new Date(epochMs(time) + comparisonOffsetMs(minutes)).toISOString();
  return shifted.slice(0, 16) + time.slice(16);
}

export function comparisonSourceWindow(window: HistoryWindow, minutes: number): HistoryWindow {
  return {
    from: shiftComparisonTime(window.from, -minutes),
    to: shiftComparisonTime(window.to, -minutes),
  };
}

export function comparisonOffsetLabel(minutes: number): string {
  const hours = minutes % 60 === 0;
  return `${minutes > 0 ? "+" : "−"}${Math.abs(minutes) / (hours ? 60 : 1)} ${hours ? "h" : "min"}`;
}
