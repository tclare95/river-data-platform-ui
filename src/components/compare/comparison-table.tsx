"use client";

import { useId, useState } from "react";
import { Button } from "@/components/button";
import { RainfallTotalValue } from "@/components/history/rainfall-totals";
import { Time } from "@/components/latest-reading";
import { comparisonReadingTime, type AlignedRow, type ComparisonReading } from "@/lib/compare";
import { comparisonOffsetLabel, shiftComparisonTime } from "@/lib/compare-time";
import { INELIGIBLE_REASON, rainfallBounds } from "@/lib/history/rainfall";
import { epochMs } from "@/lib/rdp/contract";

export const COMPARE_ROWS_PER_PAGE = 100;

const inspectionTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

export function InspectionTime({ value }: { value: string }) {
  return <time dateTime={value}>{inspectionTime.format(epochMs(value))}</time>;
}

type ComparisonColumn = {
  id: string;
  label: string;
  unit: string;
  rainfall: boolean;
  offset?: number;
};

export function ComparisonTime({
  reading,
  offset,
}: {
  reading: ComparisonReading;
  offset: number;
}) {
  const time = comparisonReadingTime(reading);
  const label =
    "expected" in reading
      ? "window end"
      : "label" in reading
        ? "provider label"
        : "observation time";
  return (
    <span className="block text-ink-muted">
      <span className="block">
        Original {label} <InspectionTime value={time} />
      </span>
      <span className="block">
        Displayed {label} <InspectionTime value={shiftComparisonTime(time, offset)} />
      </span>
    </span>
  );
}

export function ComparisonValue({ reading, unit }: { reading: ComparisonReading; unit?: string }) {
  if ("expected" in reading) return <RainfallTotalValue total={reading} showWindow />;
  const rain = "label" in reading ? reading : null;
  const value = "value" in reading ? reading.value : reading.totalMm;
  const period = rain && rainfallBounds(rain);
  return (
    <>
      <span>{value === null ? "Ineligible" : `${value}${unit ? ` ${unit}` : ""}`}</span>
      {rain ? (
        <span className="block text-ink-muted">
          {period ? (
            <>
              <Time value={period[0]} /> to <Time value={period[1]} />
              <span className="block">
                {rain.labelConvention === "period_start" ? "Start label" : "End label"}
              </span>
            </>
          ) : (
            "Timing unverified"
          )}
        </span>
      ) : null}
      {rain?.ineligibleReason ? (
        <span className="block text-ink-muted">{INELIGIBLE_REASON[rain.ineligibleReason]}</span>
      ) : null}
      {reading.revision > 1 ? (
        <span className="block text-ink-muted">Revision {reading.revision} (corrected)</span>
      ) : null}
    </>
  );
}

function Cell({ reading, offset = 0 }: { reading: ComparisonReading | null; offset?: number }) {
  return (
    <td className="px-4 py-2 text-right align-top">
      {reading ? (
        <>
          <ComparisonValue reading={reading} />
          {offset !== 0 ? <ComparisonTime reading={reading} offset={offset} /> : null}
        </>
      ) : (
        <span className="text-ink-muted">No reading</span>
      )}
    </td>
  );
}

export function ComparisonTable({
  rows,
  columns,
  name = "Compared readings",
}: {
  rows: readonly AlignedRow[];
  columns: readonly ComparisonColumn[];
  name?: string;
}) {
  const [page, setPage] = useState(0);
  const statusId = useId();
  const pages = Math.max(1, Math.ceil(rows.length / COMPARE_ROWS_PER_PAGE));
  const current = Math.min(page, pages - 1);
  const start = current * COMPARE_ROWS_PER_PAGE;
  const visible = rows.slice(start, start + COMPARE_ROWS_PER_PAGE);
  const format = (n: number) => n.toLocaleString("en-GB");
  const status =
    rows.length === 0
      ? "No readings"
      : `Times ${format(start + 1)}–${format(start + visible.length)} of ${format(rows.length)}, newest first`;

  return (
    <div>
      {/* Focusable so keyboard users can scroll a table wider than a narrow screen (WCAG 2.1.1). */}
      <div
        role="region"
        aria-label={name}
        tabIndex={0}
        className="overflow-x-auto rounded-lg border border-line bg-surface"
      >
        <table className="w-full text-left text-sm tabular-nums">
          <caption className="sr-only">{name}, newest first. Timeline times are UK time.</caption>
          <thead className="border-b border-line text-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {columns.some(({ offset }) => offset)
                  ? "Displayed time"
                  : columns.some(({ rainfall }) => rainfall)
                    ? "Observation time or rainfall window end / label"
                    : "Observed"}
              </th>
              {columns.map(({ id, label, unit, offset }) => (
                <th key={id} scope="col" className="px-4 py-2.5 text-right font-medium">
                  {label} ({unit}){offset ? ` · ${comparisonOffsetLabel(offset)}` : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {visible.map((row) => (
              <tr key={row.time}>
                <th scope="row" className="px-4 py-2 font-normal whitespace-nowrap">
                  <Time value={row.time} />
                </th>
                {columns.map(({ id, offset }, index) => (
                  <Cell key={id} reading={row.readings[index]} offset={offset} />
                ))}
              </tr>
            ))}
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
