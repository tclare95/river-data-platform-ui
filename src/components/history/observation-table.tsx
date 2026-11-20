"use client";

import { useId, useState } from "react";
import { Button } from "@/components/button";
import { formatTime } from "@/lib/format";
import { buildSeries, type MissingInterval, type SeriesGap } from "@/lib/history/series";
import { qualityLabel } from "@/lib/labels";
import { epochMs } from "@/lib/rdp/contract";

export const ROWS_PER_PAGE = 100;

export type TableReading = {
  observedAt: string;
  value: number;
  quality: string | null;
  ingestedAt: string;
  revision: number;
};

type Props = {
  /** Strictly ascending, as the loader returns them. */
  readings: readonly TableReading[];
  unit: string;
  parameterLabel: string;
  expectedIntervalSeconds: number;
  knownGaps: readonly SeriesGap[];
};

type Item = { kind: "reading"; reading: TableReading } | { kind: "gap"; gap: MissingInterval };

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return [days && `${days} d`, hours && `${hours} h`, rest && `${rest} min`]
    .filter(Boolean)
    .join(" ");
}

/**
 * The original readings, newest first. Values are shown exactly as RDP returned them (no rounding), with the
 * observation time, RDP's storage time and the revision kept apart. Where readings are missing a row says so, so
 * the table never reads as continuous where the record is not.
 */
export function ObservationTable({
  readings,
  unit,
  parameterLabel,
  expectedIntervalSeconds,
  knownGaps,
}: Props) {
  const [page, setPage] = useState(0);
  const statusId = useId();

  const { missing } = buildSeries(readings, expectedIntervalSeconds, knownGaps);
  const gapsAfter = new Map(missing.map((gap) => [gap.after, gap]));
  const items: Item[] = [];
  for (const reading of readings) {
    items.push({ kind: "reading", reading });
    const gap = gapsAfter.get(reading.observedAt);
    if (gap) items.push({ kind: "gap", gap });
  }
  items.reverse();

  const pages = Math.max(1, Math.ceil(items.length / ROWS_PER_PAGE));
  const current = Math.min(page, pages - 1);
  const visible = items.slice(current * ROWS_PER_PAGE, (current + 1) * ROWS_PER_PAGE);
  const shownReadings = visible.filter((item) => item.kind === "reading").length;
  const before = items
    .slice(0, current * ROWS_PER_PAGE)
    .filter((item) => item.kind === "reading").length;
  const status =
    readings.length === 0
      ? "No readings"
      : `Readings ${(before + 1).toLocaleString("en-GB")}–${(before + shownReadings).toLocaleString("en-GB")} of ${readings.length.toLocaleString("en-GB")}, newest first`;

  return (
    <div>
      {/* Focusable so keyboard users can scroll a table wider than a narrow screen (WCAG 2.1.1). */}
      <div
        role="region"
        aria-label={`${parameterLabel} readings`}
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-line bg-surface"
      >
        <table className="w-full text-left text-sm tabular-nums">
          <caption className="sr-only">
            {parameterLabel} readings in {unit}, newest first. Times are UK time.
          </caption>
          <thead className="border-b border-line text-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Observed
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                {parameterLabel} ({unit})
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Quality
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Stored by RDP
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                Revision
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((item) =>
              item.kind === "gap" ? (
                <tr key={`gap-${item.gap.after}`} className="bg-canvas">
                  <td colSpan={5} className="px-4 py-2 text-ink-muted">
                    No readings for {duration(epochMs(item.gap.before) - epochMs(item.gap.after))}{" "}
                    between <time dateTime={item.gap.after}>{formatTime(item.gap.after)}</time> and{" "}
                    <time dateTime={item.gap.before}>{formatTime(item.gap.before)}</time>
                  </td>
                </tr>
              ) : (
                <tr key={item.reading.observedAt}>
                  <th scope="row" className="px-4 py-2 font-normal whitespace-nowrap">
                    <time dateTime={item.reading.observedAt}>
                      {formatTime(item.reading.observedAt)}
                    </time>
                  </th>
                  <td className="px-4 py-2 text-right">{String(item.reading.value)}</td>
                  <td className="px-4 py-2">
                    {qualityLabel(item.reading.quality) ?? (
                      <span className="text-ink-muted">Not stated</span>
                    )}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap text-ink-muted">
                    <time dateTime={item.reading.ingestedAt}>
                      {formatTime(item.reading.ingestedAt)}
                    </time>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {item.reading.revision > 1 ? (
                      <span className="font-medium">{item.reading.revision} (corrected)</span>
                    ) : (
                      item.reading.revision
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p id={statusId} role="status" className="text-sm text-ink-muted">
          {status}
        </p>
        {pages > 1 ? (
          <div className="flex gap-2">
            {/* aria-disabled, not disabled: a button that disables itself would drop keyboard focus. */}
            <Button
              onClick={() => current > 0 && setPage(current - 1)}
              aria-disabled={current === 0}
              aria-describedby={statusId}
            >
              Newer
            </Button>
            <Button
              onClick={() => current < pages - 1 && setPage(current + 1)}
              aria-disabled={current === pages - 1}
              aria-describedby={statusId}
            >
              Older
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
