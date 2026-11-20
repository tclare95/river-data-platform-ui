/**
 * History ranges offered on the detail page. Windows end at the next whole UTC hour so every load within an hour
 * asks RDP the same question (one cached first page, few distinct upstream queries). `from` is inclusive and `to`
 * exclusive, exactly as RDP reads them.
 */
export const HISTORY_RANGES = Object.freeze({
  "7d": { days: 7, label: "7 days" },
  "30d": { days: 30, label: "30 days" },
});

export type HistoryRange = keyof typeof HISTORY_RANGES;
export const DEFAULT_RANGE: HistoryRange = "7d";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type HistoryWindow = { from: string; to: string };

/** A supported range from a search parameter; anything else (missing, repeated, unknown) is the default. */
export function parseRange(value: unknown): HistoryRange {
  return typeof value === "string" && Object.hasOwn(HISTORY_RANGES, value)
    ? (value as HistoryRange)
    : DEFAULT_RANGE;
}

export function rangeWindow(range: HistoryRange, now: number): HistoryWindow {
  const end = Math.ceil(now / HOUR) * HOUR;
  return {
    from: new Date(end - HISTORY_RANGES[range].days * DAY).toISOString(),
    to: new Date(end).toISOString(),
  };
}
